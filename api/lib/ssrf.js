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

function isPrivateIPv6(ip) {
    const addr = ip.toLowerCase().split('%')[0];
    if (addr === '::' || addr === '::1') return true;

    // IPv4-mapped (::ffff:127.0.0.1) and IPv4-translated (64:ff9b::127.0.0.1)
    // embed an IPv4 address — check it as one.
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ||
        addr.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/) ||
        addr.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
        if (mapped.length === 2) return isPrivateIPv4(mapped[1]);
        const high = parseInt(mapped[1], 16);
        const low = parseInt(mapped[2], 16);
        const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isPrivateIPv4(v4);
    }

    const head = addr.slice(0, 4);
    if (/^fc|^fd/.test(head)) return true;   // fc00::/7 unique local
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
    if (/^ff/.test(head)) return true;       // multicast
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
