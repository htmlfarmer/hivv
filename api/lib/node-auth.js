// api/lib/node-auth.js — per-node shared secret: bee ↔ hub.
//
// Why this exists: the inbox long-poll had NO authentication, so anyone who
// could reach the hub could read or ack any bee's control messages
// (`/api/agents/<id>/inbox/peek` answered from the public internet). The CLI's
// X-Auth-Signature headers couldn't help — they're HMACed with a locally
// generated bearer token the hub has never seen, so there was no verifiable
// shared credential. This establishes one.
//
// Enrolment (no coordinated restart needed; legacy bees keep working):
//   1. Bee sends `x-node-secret` if it already holds one (state.node_secret).
//   2. Hub has none → it ADOPTS the bee's value (the bee owns its secret).
//   3. Bee presents nothing → hub ISSUES one and returns it in the heartbeat
//      response; the bee stores it and starts presenting it.
//   4. `node.secret_seen` flips true the first time the bee proves knowledge —
//      ONLY then do readers (inbox) start enforcing. So upgrading the hub first
//      is safe, and bees are protected automatically once they pick up the CLI.
//
// Never downgrades: a spoofed caller presenting a *different* secret can't
// rotate a stored one.

const crypto = require('crypto');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Read path (inbox poll/ack/peek) — no mutation.
// Returns {ok, reason}.
function verify(node, provided) {
  if (!node) return { ok: false, reason: 'unknown-node' };
  if (!node.secret_seen) return { ok: true };          // not enrolled yet → legacy behaviour
  if (!provided) return { ok: false, reason: 'missing' };
  if (!safeEqual(provided, node.secret)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

// Write path (register / heartbeat) — enrols or issues a secret.
// Returns {ok, issue} where `issue` is a freshly minted secret the caller must
// hand back to the bee so it can start proving identity.
function enroll(node, provided) {
  if (!node) return { ok: false, issue: null };
  if (provided) {
    if (!node.secret) {
      node.secret = String(provided);                  // bee owns it
      node.secret_seen = true;
      return { ok: true, issue: null };
    }
    if (!safeEqual(provided, node.secret)) return { ok: false, issue: null };
    node.secret_seen = true;
    return { ok: true, issue: null };
  }
  if (!node.secret) {
    node.secret = crypto.randomBytes(24).toString('hex');
    return { ok: true, issue: node.secret };           // hand to the bee
  }
  return { ok: true, issue: null };                    // enrolled; bee not presenting yet
}

module.exports = { safeEqual, verify, enroll };
