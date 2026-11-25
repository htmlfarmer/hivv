// api/lib/bee-identity.js — ONE bee identity protocol for HIVV and BLNQ.
//
// THE PROBLEM THIS SOLVES
// ───────────────────────
// HIVV put the node id in the URL (`POST /api/nodes/{id}/heartbeat`).
// BLNQ put the worker id in the body (`POST /api/agents/{id}/inbox`).
// One was called "node", the other "worker", and the two registries were
// separate. An agent joining the network had to learn two protocols to be
// useful in both.
//
// THE SHAPE OF THE FIX
// ────────────────────
// ONE identity, TWO transports:
//   * `bee_id` is the canonical identity — a content-derived id that the bee
//     can prove it owns, so nobody can squat another bee's name.
//   * The id may travel in the URL (HIVV style) OR in the body (BLNQ style).
//     Both are accepted; the body wins when both are present and disagree,
//     because the body is what the bee signs over.
//   * The enrolment credential is the SAME in both: the per-node secret plus
//     the machine's hw_id.
//
// THE ANTI-SQUATTING RULE
// ───────────────────────
// A registration that claims an id the hub has NOT seen before may do so —
// that is how every bee joins. But a registration that claims an id the hub
// HAS seen must prove it is the same bee, by presenting that bee's secret or
// its hw_id. Otherwise anyone could POST a registration for "masjid" and
// take over a node's inbox, its relay jobs, and its honey streak.
//
// This is enforced here so BOTH sites can call it.

const crypto = require('crypto');

// Canonical id shape: lowercase, URL-safe, 2..64 chars.
//
// NOTE: the FIRST character may be a letter, digit, underscore or dash so
// identifiers like `__node_auth_e2e__` and `bee-x` both work. The security
// property comes from the enrolment proof (secret or hw_id) — the id format
// is hygiene, not authentication.
const BEE_ID_RE = /^[a-z0-9_-][a-z0-9._-]{1,63}$/;

function isValidBeeId(value) {
    return typeof value === 'string' && BEE_ID_RE.test(value);
}

// ── the hive's reserved ritual vocabulary ───────────────────────────────────
// These names belong to the RITUAL LAYER (salah times, adhan pushes, wudu,
// hajj, jihad, the moon) — no bee may claim them. Spiritual words are the
// hive's original protocol for shared meaning; the hive keeps them, the way
// a mosque keeps its minbar. Enforced at the register door, like everything
// else here. Playful — but enforced.
const RESERVED_BEE_IDS = new Set([
    // the five daily prayers (regional times, pushed as the adhan)
    'fajr', 'dhuhr', 'asr', 'maghrib', 'isha',
    // core ritual vocabulary
    'salah', 'salat', 'wudu', 'adhan', 'sujud', 'sujood', 'sujood-as-salah',
    'dua', 'hajj', 'jihad', 'ramadan', 'ramadhan', 'eid', 'zakat',
    // the hive's own ritual functions
    'moon', 'tongue',
]);

function isReservedId(value) {
    return RESERVED_BEE_IDS.has(String(value || '').toLowerCase());
}

// A stable fingerprint of the machine, so two registrations from the same box
// are recognisably the same bee even before it has a secret.
function beeFingerprint(hwId) {
    if (!hwId) return null;
    return crypto.createHash('sha256').update(String(hwId)).digest('hex').slice(0, 32);
}

// The canonical id for a NEW bee. Derived from the machine id so the same
// machine gets the same id on every reinstall — no more "yalla-192" because
// the hostname collided with someone else's.
function deriveBeeId({ hw_id, id, name }) {
    const fp = beeFingerprint(hw_id);
    if (fp) return `bee_${fp.slice(0, 12)}`;
    const base = String(id || name || 'bee').toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || 'bee';
}

// Timing-safe equality for secrets.
function sameSecret(a, b) {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * Decide whether a registration may claim `requestedId`.
 *
 * @param {object} opts
 * @param {object} opts.existing      the hub's current row for that id (or null)
 * @param {string} opts.requestedId    the id the caller is claiming
 * @param {string} [opts.hwId]         the machine id the caller presents
 * @param {string} [opts.secret]       the per-bee secret the caller presents
 * @param {string} [opts.existingHwId] the hw_id the hub already recorded
 * @param {string} [opts.existingSecret] the secret the hub already issued
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
function authorizeClaim({ existing, requestedId, hwId, secret, existingHwId, existingSecret }) {
    // A brand-new id is a join, not a takeover.
    if (!existing) return { ok: true, isNew: true };

    // Re-registering an existing bee: it must prove it is that bee.
    // EITHER the secret it was issued …
    if (secret && existingSecret && sameSecret(secret, existingSecret)) {
        return { ok: true, isNew: false, proof: 'secret' };
    }
    // … OR the machine id it enrolled with (the recovery path for a bee that
    // lost its local copy).
    if (hwId && existingHwId && sameSecret(hwId, existingHwId)) {
        return { ok: true, isNew: false, proof: 'hw_id' };
    }
    return {
        ok: false,
        code: 'BEE_ID_TAKEN',
        reason: `bee id '${requestedId}' is already registered — present its secret or hw_id`,
    };
}

// Read the identity out of a request, accepting EITHER transport.
//
//   HIVV style : POST /api/nodes/{bee_id}/heartbeat
//   BLNQ style : POST /api/agents  { bee_id | worker_id | node_id }
//
// The body wins when both are present and disagree: the body is what a bee
// signs over, so it is the more trustworthy statement of "who am I".
function readBeeId(req, params) {
    const body = req.body || {};
    const fromBody = body.bee_id || body.worker_id || body.node_id || body.id || null;
    const fromUrl = (params && (params.bee_id || params.worker_id || params.node_id || params.id)) || null;
    if (fromBody && fromUrl && String(fromBody) !== String(fromUrl)) {
        return { id: String(fromBody), source: 'body', conflict: true, url_id: String(fromUrl) };
    }
    if (fromBody) return { id: String(fromBody), source: 'body' };
    if (fromUrl) return { id: String(fromUrl), source: 'url' };
    return { id: null, source: null };
}

// The headers a bee presents to prove itself.
function readBeeProof(req) {
    const body = req.body || {};
    return {
        secret: req.headers['x-node-secret'] || req.headers['x-bee-secret']
             || body.node_secret || body.secret || null,
        hwId: body.hw_id || body.hwId || req.headers['x-hw-id'] || null,
        token: body.token || req.headers['x-node-token'] || null,
    };
}

module.exports = {
    BEE_ID_RE,
    isValidBeeId,
    isReservedId,
    RESERVED_BEE_IDS,
    beeFingerprint,
    deriveBeeId,
    sameSecret,
    authorizeClaim,
    readBeeId,
    readBeeProof,
};
