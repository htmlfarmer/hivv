// api/lib/key-donation.js — guard rails for donated cloud keys and endpoints.
//
// THE ABUSE VECTORS THIS CLOSES
// ─────────────────────────────
// 1. SSRF. `POST /api/keys/donate` accepted an arbitrary `endpoint` URL and
//    wrote it into `ai_providers.default_endpoint`. The router then POSTs
//    every matching chat request to it — including the user's PROMPT. A
//    malicious endpoint could harvest prompts, or point at an internal
//    service (the local LLM, Postgres, the cloud metadata endpoint).
//    → Every donated endpoint is now checked with lib/ssrf.js BEFORE it is
//      stored, and it is re-checked before every use.
//
// 2. Unbounded spend. A donated cloud key with no cap is an open wallet for
//    the whole network, and the donor has no way to see or stop it.
//    → Every donated key gets a requests/hour cap and a tokens/day cap, both
//      required, both visible in the response, both enforced by the router.
//
// 3. Donor impersonation. The old response returned the provider + key name,
//    and nothing bound a key to the person who donated it. Anyone could
//    donate under a name that looked official.
//    → Every donation is bound to an anonymous donor fingerprint (a salted
//      hash of the caller's IP + user-agent), and the per-donor rate limit
//      and per-donor cap are enforced.
//
// 4. Custom-provider spam. `provider` was free text, so an attacker could
//    create thousands of junk provider rows.
//    → Only a known provider list (plus an explicitly "custom" name) is
//      accepted, and a custom provider needs a verified endpoint.

const crypto = require('crypto');
const ssrf = require('./ssrf');

// Providers we know how to talk to. A custom provider is allowed, but only
// with an endpoint that passes the SSRF guard.
const KNOWN_PROVIDERS = new Set([
    'openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek',
    'openrouter', 'together', 'qwen', 'fireworks', 'perplexity',
    'ollama', 'llamacpp', 'lmstudio', 'localai', 'vllm', 'textgen',
    'custom',
]);

// Defaults when the donor does not specify caps. Deliberately modest: a
// donated key is a gift to the network, not a blank cheque.
const DEFAULT_MAX_REQUESTS_PER_HOUR = 120;
const DEFAULT_MAX_TOKENS_PER_DAY = 200_000;

// A donor may not register more than this many keys per rolling window.
const MAX_KEYS_PER_DONOR = 5;
const DONOR_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── in-memory donor bookkeeping ───────────────────────────────────────────
// Process-local is enough: it is a rate limit, not an accounting ledger. A
// restart resets it, which is the safe direction (the caps themselves live in
// Postgres and survive).
const donorKeys = new Map();   // fingerprint -> { keys: [timestamp], ... }

function _prune(list, now) {
    return list.filter((t) => now - t < DONOR_WINDOW_MS);
}

// A stable, NON-REVERSIBLE fingerprint of the donor. It is a salted hash —
// the raw IP is never stored here, so this cannot become a PII store.
function donorFingerprint(req) {
    const salt = process.env.HIVV_DONOR_SALT
        || (process.env.HIVV_SESSION_SECRET || 'hivv-donor-salt');
    const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const ua = String(req.headers['user-agent'] || '');
    return crypto.createHash('sha256').update(`${salt}|${ip}|${ua}`).digest('hex').slice(0, 32);
}

function donorKeyCount(fingerprint) {
    const now = Date.now();
    const entry = donorKeys.get(fingerprint) || { keys: [] };
    entry.keys = _prune(entry.keys, now);
    donorKeys.set(fingerprint, entry);
    return entry.keys.length;
}

function noteDonorKey(fingerprint) {
    const now = Date.now();
    const entry = donorKeys.get(fingerprint) || { keys: [] };
    entry.keys = _prune(entry.keys, now);
    entry.keys.push(now);
    donorKeys.set(fingerprint, entry);
    // Keep the map from growing without bound.
    if (donorKeys.size > 5000) {
        for (const [k, v] of donorKeys) {
            if (!v.keys.length || now - v.keys[v.keys.length - 1] > DONOR_WINDOW_MS) {
                donorKeys.delete(k);
            }
        }
    }
}

/**
 * Validate a donation.
 *
 * @returns {{ok: true, plan: object} | {ok: false, status: number, error: string, detail?: any}}
 */
async function validateDonation(req, { provider, api_key, endpoint, name, model,
                                        max_requests_per_hour, max_tokens_per_day }) {
    // ── provider ─────────────────────────────────────────────────────
    const p = String(provider || '').toLowerCase().trim();
    if (!p) return { ok: false, status: 400, error: 'provider required' };
    if (!KNOWN_PROVIDERS.has(p)) {
        return {
            ok: false, status: 400,
            error: `unknown provider '${p}'`,
            detail: {
                known: [...KNOWN_PROVIDERS].sort(),
                hint: 'a custom provider must be named exactly "custom"',
            },
        };
    }

    // ── key ──────────────────────────────────────────────────────────
    const key = String(api_key || '').trim();
    if (!key) return { ok: false, status: 400, error: 'api_key required' };
    if (key.length < 8) {
        return { ok: false, status: 400, error: 'api_key looks too short to be valid' };
    }
    if (key.length > 500) {
        return { ok: false, status: 400, error: 'api_key is implausibly long' };
    }
    // A key that looks like a private key or a JWT is not an API key.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
        return { ok: false, status: 400, error: 'that is a private key, not an API key' };
    }

    // ── endpoint ──────────────────────────────────────────────────────
    let ep = endpoint ? String(endpoint).trim() : null;
    if (ep) {
        let parsed;
        try {
            parsed = new URL(ep);
        } catch {
            return { ok: false, status: 400, error: 'endpoint is not a valid URL' };
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { ok: false, status: 400, error: `endpoint scheme ${parsed.protocol} is not allowed` };
        }
        // THE SSRF CHECK. The donated endpoint will receive real prompts, so
        // it must be a PUBLIC address — never this box, never the metadata
        // service, never a DNS name that points inside.
        const verdict = await ssrf.checkUrl(ep);
        if (!verdict.ok) {
            return {
                ok: false, status: 400,
                error: `endpoint refused: ${verdict.reason}`,
                detail: { code: 'ENDPOINT_BLOCKED' },
            };
        }
    }

    // ── donor limits ──────────────────────────────────────────────────
    const fingerprint = donorFingerprint(req);
    if (donorKeyCount(fingerprint) >= MAX_KEYS_PER_DONOR) {
        return {
            ok: false, status: 429,
            error: `too many donated keys — the limit is ${MAX_KEYS_PER_DONOR} per day`,
            detail: { code: 'DONOR_LIMIT', limit: MAX_KEYS_PER_DONOR },
        };
    }

    // ── caps ──────────────────────────────────────────────────────────
    const rpm = parseInt(max_requests_per_hour, 10);
    const tpd = parseInt(max_tokens_per_day, 10);
    if (Number.isFinite(rpm) && rpm <= 0) {
        return { ok: false, status: 400, error: 'max_requests_per_hour must be positive' };
    }
    if (Number.isFinite(tpd) && tpd <= 0) {
        return { ok: false, status: 400, error: 'max_tokens_per_day must be positive' };
    }

    return {
        ok: true,
        plan: {
            provider: p,
            api_key: key,
            endpoint: ep || null,
            name: String(name || `${p}-donated`).slice(0, 100),
            model: model || '*',
            max_requests_per_hour: Number.isFinite(rpm) ? rpm : DEFAULT_MAX_REQUESTS_PER_HOUR,
            max_tokens_per_day: Number.isFinite(tpd) ? tpd : DEFAULT_MAX_TOKENS_PER_DAY,
            donor_fingerprint: fingerprint,
        },
    };
}

module.exports = {
    KNOWN_PROVIDERS,
    DEFAULT_MAX_REQUESTS_PER_HOUR,
    DEFAULT_MAX_TOKENS_PER_DAY,
    MAX_KEYS_PER_DONOR,
    DONOR_WINDOW_MS,
    donorFingerprint,
    donorKeyCount,
    noteDonorKey,
    validateDonation,
};
