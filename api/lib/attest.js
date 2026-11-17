// api/lib/attest.js — signed attestation envelopes (Ed25519).
//
// HIVV's copy of the BLNQ attestation module. It MUST stay byte-identical to
// /var/www/vhosts/blnq.org/public_html/api/lib/attest.js — blnq verifies the
// signatures hivv produces here, and both sides canonicalize independently.
// tests/test_attest_parity.js fails if the two copies ever drift.
//
// Why a copy rather than a shared require: each site stays independently
// deployable, and a broken cross-vhost path must never be able to take hivv's
// API down. The parity test is what makes the duplication safe.
//
// The canonicalization contract (see blnq's docs/TRUST-PLAN.md §2): sorted by
// UTF-8 byte order, no insignificant whitespace, integers only — so a signature
// made here verifies on the stdlib-only Python CLI too.

const crypto = require('crypto');
const {
  ENVELOPE_VERSION,
  PRINCIPAL_PREFIX,
  PRINCIPAL_PATTERN,
  LEGACY_PRINCIPAL_PATTERN,
} = require('./attestation-contract');

const KINDS = ['source.review', 'run.request', 'io.record', 'run.record'];

// ── canonical JSON ────────────────────────────────────────────────────────
//
// Rules (mirrored exactly in blnq-cli.py:_canonical_json):
//   1. object keys sorted by UTF-8 BYTES (JS Array.sort is UTF-16 code units,
//      which diverges from Python for any key outside BMP — sort explicitly)
//   2. no insignificant whitespace
//   3. integers only — a float here would format differently between
//      Number.toFixed and Python repr, silently breaking every signature
//   4. standard JSON string escaping
function cmpBuf(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function canonicalize(value) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`canonical JSON allows integers only, got ${value}`);
    }
    // Reject -0 and values outside the safe integer range: both would render
    // differently across languages.
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error(`canonical JSON integer out of range: ${value}`);
    }
    return String(value);
  }

  if (t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort((x, y) => cmpBuf(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  throw new Error(`canonical JSON cannot serialize type ${t}`);
}

// ── hashing ───────────────────────────────────────────────────────────────
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Subject binding. `io.record` folds both input and output hashes together so a
// signature over it cannot be replayed against a run with different data.
function subjectFor(kind, parts) {
  if (kind === 'io.record') {
    return sha256Hex(Buffer.from(String(parts.input), 'utf8'))
      + sha256Hex(Buffer.from(String(parts.output), 'utf8'));
  }
  return sha256Hex(parts.source !== undefined ? parts.source : parts.runId);
}

// ── keys ──────────────────────────────────────────────────────────────────
// SPKI DER prefix for an Ed25519 public key (RFC 8410 §3):
//   30 2a 30 05 06 03 2b 65 70 03 21 00 || <32 raw bytes>
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromRaw(raw32) {
  const raw = Buffer.isBuffer(raw32) ? raw32 : Buffer.from(raw32, 'base64');
  if (raw.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function rawFromPublicKey(key) {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

// Self-certifying identity: the principal id IS a function of the public key, so
// it cannot be claimed by anyone who does not hold the matching private key.
// v2 uses a human-readable `hivv_` namespace. The 32 hex characters remain the
// key fingerprint; the prefix identifies the issuing system family.
function principalIdFromRaw(raw32) {
  return PRINCIPAL_PREFIX +
    sha256Hex(Buffer.isBuffer(raw32) ? raw32 : Buffer.from(raw32, 'base64')).slice(0, 32);
}

function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    rawPublicKey: rawFromPublicKey(publicKey),
    principalId: principalIdFromRaw(rawFromPublicKey(publicKey)),
  };
}

// ── envelopes ─────────────────────────────────────────────────────────────
function buildEnvelope({ kind, subject, issuer, body, nonce, issuedAt }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown attestation kind: ${kind}`);
  if (!/^[0-9a-f]{64}$/.test(String(subject))) throw new Error('subject must be 64 hex chars');
  if (!PRINCIPAL_PATTERN.test(String(issuer))) {
    throw new Error(`issuer must be ${PRINCIPAL_PREFIX}<32 hex>`);
  }
  return {
    v: ENVELOPE_VERSION,
    kind,
    subject,
    issuer,
    issued_at: issuedAt === undefined ? Math.floor(Date.now() / 1000) : issuedAt,
    nonce: nonce || crypto.randomBytes(8).toString('hex'),
    body: body || {},
  };
}

function envelopeBytes(envelope) {
  return Buffer.from(canonicalize(envelope), 'utf8');
}

function signEnvelope(envelope, privateKey) {
  const sig = crypto.sign(null, envelopeBytes(envelope), privateKey);
  return sig.toString('base64');
}

// Verifies signature AND that the issuer id actually derives from the supplied
// key. Checking only the signature would let an attacker present a valid
// signature under their own key while claiming to be someone else's principal.
function verifyEnvelope(envelope, signatureB64, rawPublicKey) {
  const problems = [];
  if (!envelope || typeof envelope !== 'object') return { ok: false, problems: ['malformed envelope'] };
  if (envelope.v !== ENVELOPE_VERSION && envelope.v !== 1) {
    problems.push(`unsupported version ${envelope.v}`);
  }
  if (!KINDS.includes(envelope.kind)) problems.push(`unknown kind ${envelope.kind}`);
  if (!/^[0-9a-f]{64}$/.test(String(envelope.subject || ''))) problems.push('bad subject');
  if (!PRINCIPAL_PATTERN.test(String(envelope.issuer || '')) &&
      !LEGACY_PRINCIPAL_PATTERN.test(String(envelope.issuer || ''))) {
    problems.push('bad issuer');
  }
  if (!Number.isSafeInteger(envelope.issued_at)) problems.push('bad issued_at');

  let raw;
  try {
    raw = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey, 'base64');
  } catch {
    problems.push('unparseable public key');
    return { ok: false, problems };
  }
  if (raw.length !== 32) problems.push('public key must be 32 bytes');
  // Legacy envelopes remain verifiable against their retained old key. New
  // envelopes must use the current self-certifying `hivv_` principal.
  if (PRINCIPAL_PATTERN.test(String(envelope.issuer || '')) &&
      principalIdFromRaw(raw) !== envelope.issuer) {
    problems.push('issuer does not derive from public key');
  }
  if (problems.length) return { ok: false, problems };

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      envelopeBytes(envelope),
      publicKeyFromRaw(raw),
      Buffer.from(String(signatureB64), 'base64')
    );
  } catch (e) {
    return { ok: false, problems: [`verify error: ${e.message}`] };
  }
  return valid ? { ok: true, problems: [] } : { ok: false, problems: ['signature mismatch'] };
}

// Freshness + replay. Signatures are deterministic over identical content, so a
// stored envelope could be re-submitted forever; callers reject outside this
// window and the hub keeps a nonce cache (mirrors workerAuth.js).
function checkFreshness(envelope, { windowS = 86400, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isSafeInteger(envelope.issued_at)) return false;
  return Math.abs(now - envelope.issued_at) <= windowS;
}

module.exports = {
  ENVELOPE_VERSION,
  KINDS,
  canonicalize,
  contract: require('./attestation-contract').contract,
  sha256Hex,
  subjectFor,
  publicKeyFromRaw,
  rawFromPublicKey,
  principalIdFromRaw,
  generateSigningKey,
  buildEnvelope,
  envelopeBytes,
  signEnvelope,
  verifyEnvelope,
  checkFreshness,
};
