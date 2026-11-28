// api/lib/ssrf.js — guard outbound requests against internal addresses.
//
// The hub's `fetch` tool lets a model retrieve an arbitrary URL. Without a
// guard that is a server-side request forgery primitive: anyone who can make
// a model call a tool could read services that are only reachable from
// inside this box — the local AI servers, the databases, and the cloud
// metadata endpoint.
//
// The local tools server (public_html/hivv-tools.py) has a similar guard,
// but it is a string-prefix check. This one resolves the hostname and
// inspects every address it maps to, so a DNS name pointing at 127.0.0.1 is
// caught too.

const dns = require('dns').promises;
const net = require('net');

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Hostnames that always mean "inside this network".
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.localdomain'];

function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateIPv4(ip) {
    const value = ipv4ToInt(ip);
    if (value === null) return true; // unparseable → treat as unsafe
    const inRange = (base, bits) => {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return (value & mask) === (ipv4ToInt(base) & mask);
    };
    return (
        inRange('0.0.0.0', 8) ||        // "this network"
        inRange('10.0.0.0', 8) ||       // private
        inRange('100.64.0.0', 10) ||    // carrier-grade NAT
        inRange('127.0.0.0', 8) ||      // loopback
        inRange('169.254.0.0', 16) ||   // link-local, incl. 169.254.169.254 metadata
        inRange('172.16.0.0', 12) ||    // private
        inRange('192.0.0.0', 24) ||     // IETF protocol assignments
        inRange('192.168.0.0', 16) ||   // private
        inRange('198.18.0.0', 15) ||    // benchmarking
        inRange('224.0.0.0', 4) ||      // multicast
        inRange('240.0.0.0', 4)         // reserved, incl. broadcast
    );
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable.
 *
 * WHY THIS EXISTS — the whole bug this function replaces:
 * the WHATWG URL parser normalises IPv6 literals to canonical HEX GROUPS
 * before this module ever sees them. `http://[64:ff9b::127.0.0.1]` arrives
 * as `64:ff9b::7f00:1`. The old guard matched `64:ff9b::` only in its
 * DOTTED form, so that pattern was dead code and every NAT64 address walked
 * straight through. Matching strings is the trap; groups are the truth.
 *
 * A trailing dotted-quad is expanded here anyway: `isPrivateIPv6` is
 * exported and may be called directly, without a URL parser in front of it.
 */
function ipv6Groups(addr) {
    let s = addr;
    const quad = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (quad) {
        const parts = quad[1].split('.').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
            return null;
        }
        const hi = ((parts[0] << 8) | parts[1]).toString(16);
        const lo = ((parts[2] << 8) | parts[3]).toString(16);
        s = s.slice(0, quad.index) + hi + ':' + lo;
    }

    const halves = s.split('::');
    if (halves.length > 2) return null;
    const parse = (part) =>
        part === ''
            ? []
            : part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));

    const left = parse(halves[0]);
    if (left.some(Number.isNaN)) return null;
    if (halves.length === 1) return left.length === 8 ? left : null;

    const right = parse(halves[1]);
    if (right.some(Number.isNaN)) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    return [...left, ...Array(fill).fill(0), ...right];
}

/**
 * The IPv4 address this IPv6 address embeds, or null if it embeds none.
 *
 * Table of the transition prefixes (RFC 6052 §2.2, RFC 6145, RFC 3056).
 * Read it as DATA, not as scattered regexes — a prefix nobody listed is a
 * prefix nobody checks, which is how four bypasses shipped together.
 */
function embeddedIPv4(g) {
    const zero = (a, b) => g.slice(a, b).every((x) => x === 0);

    // IPv4-mapped      ::ffff:0:0/96       g0..g4=0, g5=ffff        → g6,g7
    if (zero(0, 5) && g[5] === 0xffff) return [g[6], g[7]];
    // IPv4-translated  ::ffff:0:0:0/96      g0..g3=0, g4=ffff, g5=0  → g6,g7
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return [g[6], g[7]];
    // NAT64 well-known 64:ff9b::/96         g0=64, g1=ff9b, g2..g5=0 → g6,g7
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return [g[6], g[7]];
    // NAT64 local-use  64:ff9b:1::/48       prefix(48)=g0..g2, v4=g3,g4,
    //                                        u=g5, reserved=g6,g7 (RFC 6052 §2.2).
    // The reserved tail is deliberately NOT required to be zero: an address
    // with a dirty tail is not a well-formed embedding, and guessing where
    // the v4 went is exactly the error this table exists to prevent.
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x1) return [g[3], g[4]];
    // 6to4             2002::/16            v4 sits in bits 16..47   → g1,g2
    if (g[0] === 0x2002) return [g[1], g[2]];

    return null;
}

function isPrivateIPv6(ip) {
    const addr = ip.toLowerCase().split('%')[0];
    if (addr === '::' || addr === '::1') return true;

    const g = ipv6Groups(addr);
    if (!g) {
        // Cannot prove it is safe, so it is not safe. `net.isIP` gates entry
        // here, so reaching this branch means the parser disagreed with Node —
        // and a guard that cannot read an address must not vouch for it.
        return true;
    }

    // Does it embed an IPv4 address? If the embedded one is private, so is
    // the host that carries it — that is the entire point of the check.
    const emb = embeddedIPv4(g);
    if (emb) {
        const dotted =
            `${(emb[0] >> 8) & 0xff}.${emb[0] & 0xff}.` +
            `${(emb[1] >> 8) & 0xff}.${emb[1] & 0xff}`;
        if (isPrivateIPv4(dotted)) return true;
        // A PUBLIC embedding is no reason to block; fall through to the
        // ordinary prefix checks rather than trusting it blindly.
    }

    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
}

function isPrivateAddress(ip) {
    if (!ip) return true;
    const family = net.isIP(ip);
    if (family === 4) return isPrivateIPv4(ip);
    if (family === 6) return isPrivateIPv6(ip);
    return true; // not an IP literal — should not reach here
}

/**
 * Decide whether a URL is safe to fetch.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function checkUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl));
    } catch {
        return { ok: false, reason: 'not a valid URL' };
    }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return { ok: false, reason: `scheme ${parsed.protocol} is not allowed` };
    }

    const hostname = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) {
        return { ok: false, reason: 'no hostname' };
    }

    if (hostname === 'localhost' || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
        return { ok: false, reason: 'internal hostname' };
    }

    // A literal IP? Check it directly.
    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) {
            return { ok: false, reason: 'address is inside a private network' };
        }
        return { ok: true };
    }

    // A name? Resolve it and check every address it maps to.
    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        return { ok: false, reason: 'hostname could not be resolved' };
    }
    if (!addresses || addresses.length === 0) {
        return { ok: false, reason: 'hostname resolved to no addresses' };
    }
    for (const entry of addresses) {
        if (isPrivateAddress(entry.address)) {
            return { ok: false, reason: `hostname resolves to a private address (${entry.address})` };
        }
    }
    return { ok: true };
}

/**
 * Fetch a URL, refusing internal targets. Returns the raw Response on success
 * and throws an Error with a readable reason on refusal.
 */
async function safeFetch(rawUrl, options = {}) {
    const verdict = await checkUrl(rawUrl);
    if (!verdict.ok) {
        const err = new Error(`Refused to fetch ${rawUrl}: ${verdict.reason}`);
        err.code = 'SSRF_BLOCKED';
        throw err;
    }
    return fetch(rawUrl, options);
}

module.exports = { checkUrl, safeFetch, isPrivateAddress, isPrivateIPv4, isPrivateIPv6 };
