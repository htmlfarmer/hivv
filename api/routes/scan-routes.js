// api/routes/scan-routes.js — purpose-built code safety scanner.
//
//   POST /api/scan  {language, code} -> structured verdict, plain-English
//                   statement, and an HIVV-OWNED Ed25519 signature over it.
//
// Why this exists alongside chat: a chat completion is an unprompted opinion
// that any caller can shape by prompt-injection, and blnq cannot tell which
// model produced it. This endpoint returns a fixed-shape, hash-bound, signed
// artifact, so blnq can verify (a) the code hash the verdict covers, (b) that
// hivv — not the hub — made the claim, and (c) that nothing was edited in
// transit. The hub can relay this signature but cannot forge it.
//
// Mounted with:
//   const ScanRoutes = require('./routes/scan-routes');
//   ScanRoutes.inject(router);
//   app.use('/api/scan', ScanRoutes);

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const attest = require('../lib/attest');
const { analyzeCode } = require('../lib/code-analysis');
const { fastScan } = require('../lib/fast-scan');

const router = express.Router();

// The scanner's own public identity — used by the partner surface so a partner
// can pre-verify a signature without a database round trip.
router.publicKey = () => {
    const key = scanKey();
    return {
        principalId: key.principalId,
        rawPublicKey: key.rawPublicKey,
        publicKey: key.rawPublicKey.toString('base64'),
    };
};

const MAX_CODE_BYTES = 256 * 1024;      // matches lib/sandbox.js LIMITS.codeBytes
const WINDOW_MS = 60 * 1000;
const MAX_PER_MIN = parseInt(process.env.HIVV_SCAN_RATE_MAX || '20', 10);
const SCAN_TIMEOUT_MS = parseInt(process.env.HIVV_SCAN_TIMEOUT_MS || '90000', 10);

let aiRouter = null;
router.inject = (r) => { aiRouter = r; };

// ── rate limiting (house pattern: relay-routes B1) ─────────────────────────
const hits = new Map();
function limiter(req, res, next) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] ||
             req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || now - e.start > WINDOW_MS) { e = { start: now, n: 0 }; hits.set(ip, e); }
  e.n += 1;
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  }
  if (e.n > MAX_PER_MIN) return res.status(429).json({ error: 'scan rate limit' });
  next();
}

// ── hivv's own validator key ───────────────────────────────────────────────
// Generated once and persisted, so hivv's principal id never changes (a rotating
// key would invalidate every quorum that already counted hivv's signature).
const KEY_PATH = path.join(__dirname, '..', '.keys', 'scan-key');
let _key = null;

function scanKey() {
  if (_key) return _key;
  let seed = null;
  if (process.env.HIVV_SCAN_KEY) {
    const s = Buffer.from(process.env.HIVV_SCAN_KEY, 'hex');
    if (s.length === 32) seed = s;
  }
  if (!seed) {
    try {
      const existing = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
      if (existing.length === 32) seed = existing;
    } catch { /* first run */ }
  }
  if (!seed) {
    seed = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(KEY_PATH, seed.toString('hex'), { mode: 0o600 });
    } catch (e) {
      console.error('[scan] could not persist scan key:', e.message);
    }
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  const rawPublicKey = attest.rawFromPublicKey(crypto.createPublicKey(privateKey));
  _key = { privateKey, rawPublicKey, principalId: attest.principalIdFromRaw(rawPublicKey) };
  return _key;
}

// ── review prompt ──────────────────────────────────────────────────────────
// Same contract as blnq's trustScan: judge it AND describe it, because the
// statement is what other people read before deciding to run the code.
const PROMPT = `You are a code safety reviewer for a distributed compute network.
Other people will read your description before deciding to run this code.

Analyze the code and respond with ONLY a JSON object, no prose, no code fence:
{
  "verdict": "safe" | "unsafe" | "review",
  "statement": "<2-4 sentences in plain English describing exactly what this code does: what it reads, what it writes, what it sends over the network, and any side effects>",
  "risk": "low" | "medium" | "high",
  "reasons": ["<short bullet points>"]
}

Rules for verdict:
- "safe": reads/processes data and reports results; no exfiltration, no destructive
  writes, no credential access, no privilege escalation, no obfuscation.
- "unsafe": does anything to credentials, other users' files, persistence,
  privilege escalation, or sends data to a third party the user did not ask for.
- "review": you cannot tell from static reading alone.

Sandbox context: the code runs with no network, a read-only filesystem except
/tmp, a CPU and memory cap, and a wall-clock timeout.

CODE:
`;

// ── deterministic pre-screen ───────────────────────────────────────────────
// Cheap, always runs, and never produces an approval on its own — it only
// forces "unsafe" when the pattern is unambiguous, so an LLM that talks itself
// into a pass cannot override a hard signal.
const HARD_UNSAFE = [
  /\bexec\s*\(/, /\beval\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\.(?:run|call|Popen|check_output)\s*\(/,
  /\b__import__\s*\(/, /\bcompile\s*\(/, /\bpty\.spawn\b/, /\bctypes\./,
  /base64\.(?:b64decode|decodebytes)\s*\(/, /\bmarshal\.loads?\s*\(/, /\bpickle\.loads?\s*\(/,
  /\b(?:shutil|rmtree)\.rmtree\s*\(/, /\bos\.(?:remove|unlink|rename)\s*\(/,
  /\b(?:chmod|chown)\s*\(/, /\bsocket\.(?:socket|create_connection)\s*\(/,
  /\brequests\.(?:get|post|put|delete)\s*\(/, /\burllib\.request\.urlopen\s*\(/,
  /\bparamiko\b/, /\bnetrc\b/, /\.ssh\b/, /id_rsa/, /\b(?:aws|github|slack|openai)[_\-]?key\b/i,
  /\b(?:subprocess|os)\b[^\n]{0,40}\b(?:curl|wget|nc|bash|sh)\b/,
];

function prescreen(code) {
  const hitsFound = [];
  for (const re of HARD_UNSAFE) {
    const m = re.exec(code);
    if (m) hitsFound.push(m[0]);
    if (hitsFound.length >= 5) break;
  }
  return hitsFound;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fenced && fenced[1], text]) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

function normalize(raw, flags) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = String(raw.verdict || '').toLowerCase();
  if (!['safe', 'unsafe', 'review'].includes(verdict)) return null;
  const statement = String(raw.statement || raw.summary || '').trim();
  if (!statement) return null;
  // Hard patterns beat the model's opinion.
  const finalVerdict = (verdict === 'safe' && flags.length) ? 'unsafe' : verdict;
  return {
    verdict: finalVerdict,
    statement,
    risk: ['low', 'medium', 'high'].includes(String(raw.risk || '').toLowerCase())
      ? String(raw.risk).toLowerCase() : 'unknown',
    reasons: Array.isArray(raw.reasons) ? raw.reasons.slice(0, 8) : [],
  };
}

// ── FAST SCAN (no AI, no signature) ────────────────────────────────────────
// Deterministic screening before we spend an LLM (and real money) on a review.
// Same source => same answer, on every node, forever. Cheap enough to call on
// every upload.
//
// This NEVER approves anything: the deterministic scan can only move a verdict
// to `unsafe` or `review`. A signed approval still requires the AI review
// below (or another trusted validator's signature).
router.post('/fast', limiter, async (req, res) => {
  try {
    const { language, code, filename, mode } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code required' });
    }
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > MAX_CODE_BYTES) {
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_BYTES} bytes` });
    }
    const started = Date.now();
    const result = fastScan(code, { language, mode });
    res.json({
      ...result,
      filename: filename ? String(filename).slice(0, 200) : null,
      request_duration_ms: Date.now() - started,
      ai_used: false,
      signed: false,
    });
  } catch (e) {
    console.error('[scan/fast] error:', e.message);
    res.status(500).json({ error: 'fast scan failed', detail: e.message });
  }
});

// HEAD-style summary for callers that only need the headline numbers.
router.post('/fast/summary', limiter, async (req, res) => {
  try {
    const { language, code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code required' });
    }
    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > MAX_CODE_BYTES) {
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_BYTES} bytes` });
    }
    const r = fastScan(code, { language });
    res.json({
      source_sha256: r.source_sha256,
      language: r.language,
      bytes: r.size.bytes,
      chars: r.size.chars,
      lines: r.size.lines,
      risk_score: r.risks.score,
      risk_level: r.risks.level,
      verdict: r.verdict,
      most_used: r.most_used,
      command_count: r.command_count,
      hard_findings: r.hard_findings.length,
      secret_findings: r.secret_findings.length,
      network_indicators: r.network.indicators,
      needs_ai_review: r.needs_ai_review,
      ai_used: false,
      signed: false,
      scan_duration_ms: r.scan_duration_ms,
    });
  } catch (e) {
    console.error('[scan/fast/summary] error:', e.message);
    res.status(500).json({ error: 'fast scan failed', detail: e.message });
  }
});

// The scanner core — shared by POST /api/scan and POST /api/partner/review.
// Returns a plain object (never touches res) so both surfaces produce the
// SAME signed artifact. Throws on failure so each caller can shape its own
// HTTP response.
async function scanSource({ language = 'python', code }) {
  if (typeof code !== 'string' || !code.trim()) {
  throw Object.assign(new Error('code required'), { status: 400 });
  }
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_CODE_BYTES) {
  throw Object.assign(new Error(`code exceeds ${MAX_CODE_BYTES} bytes`), { status: 400 });
  }

  const flags = prescreen(code);
  const subject = attest.sha256Hex(Buffer.from(code, 'utf8'));
  const reviewStartedAtMs = Date.now();
  const scannedAt = Math.floor(reviewStartedAtMs / 1000);
  const analysis = analyzeCode(code, language);
  // Deterministic pre-scan: free, instant, and it can only make the verdict
  // WORSE. Run it before the AI so we know whether an LLM call is even
  // warranted (and so the signed record carries the same facts BLNQ can
  // reproduce without an AI).
  const fast = fastScan(code, { language });
  // Signed envelopes allow integers only. Sanitize the deterministic result
  // so a float can never silently break the canonical signature.
  const fastSafe = JSON.parse(JSON.stringify(fast, (k, v) => {
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v);
    return v;
  }));

  let verdict = null;
  let model = null;
  let llmError = null;

  if (aiRouter) {
    try {
      const res = await Promise.race([
        aiRouter.chatCompletion(
          [{ role: 'system', content: 'You are a precise code safety reviewer. Output JSON only.' },
           { role: 'user', content: PROMPT + code }],
          { stream: false, temperature: 0, capability: 'coding', timeout: SCAN_TIMEOUT_MS }
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('scan timeout')), SCAN_TIMEOUT_MS)),
      ]);
      // chatCompletion() returns {ok, data:{choices:[...]}} — NOT the flat
      // OpenAI shape that /v1/chat/completions serves. Reading res.choices
      // here silently yields undefined and every scan reports "unparseable".
      if (!res || !res.ok) {
        llmError = (res && (res.error || res.reason)) || 'router returned not-ok';
      } else {
        const choices = res.data && res.data.choices;
        const text = choices && choices[0] && choices[0].message
          ? choices[0].message.content : '';
        verdict = normalize(extractJson(text), flags);
        model = (res.data && res.data.model) || res.servedModel || model;
        if (!verdict) llmError = 'unparseable verdict';
      }
    } catch (e) {
      llmError = e.message;
    }
  } else {
    llmError = 'no AI router available';
  }

  // Fail-closed: no LLM verdict means no signature. Hard flags alone can only
  // ever make things worse, never approve them.
  if (!verdict) {
    throw Object.assign(new Error(llmError || 'scan unavailable'), {
      status: 503,
      code: 'SCAN_UNAVAILABLE',
      subject,
      signed: false,
      // Report the deterministic findings so a caller still learns something,
      // while being unable to mistake them for an approval.
      prescreen: flags,
    });
  }

  const key = scanKey();
  const reviewCompletedAtMs = Date.now();
  const durationMs = reviewCompletedAtMs - reviewStartedAtMs;
  const riskScore = Math.max(analysis.risks.score, fastSafe.risks.score);
  const riskLevel = riskScore >= 80 ? 'critical'
    : riskScore >= 50 ? 'high'
    : riskScore >= 20 ? 'medium'
    : riskScore > 0 ? 'low' : 'safe';
  const envelope = attest.buildEnvelope({
    kind: 'source.review',
    subject,
    issuer: key.principalId,
    body: {
      source_sha256: subject,
      verdict: verdict.verdict,
      statement: verdict.statement,
      risk_score: riskScore,
      risk_level: riskLevel,
      reviewed_at: scannedAt,
      reviewed_at_ms: reviewCompletedAtMs,
      reviewed_date: new Date(scannedAt * 1000).toISOString().slice(0, 10),
      reviewer_name: 'HIVV Code Safety Scanner',
      reviewer_system: 'hivv.org',
      reviewer_version: '2',
      language,
      bytes,
      chars: fast.size.chars,
      lines: analysis.lines,
      commands: analysis.commands,
      command_count: analysis.command_count,
      most_used_commands: analysis.most_used_commands,
      files: analysis.files,
      network: analysis.network,
      risks: analysis.risks,
      reasons: verdict.reasons,
      model: model || 'auto',
      scanned_at: scannedAt,
      prescreen_flags: flags.length,
      scanner: 'hivv-scan',
      // Deterministic, AI-free evidence — reproducible by anyone.
      fast_scan: {
        schema: fastSafe.schema,
        source_sha256: fastSafe.source_sha256,
        verdict: fastSafe.verdict,
        verdict_basis: fastSafe.verdict_basis,
        risk_score: fastSafe.risks.score,
        risk_level: fastSafe.risks.level,
        size: fastSafe.size,
        entropy: fastSafe.entropy,
        imports: fastSafe.imports,
        command_count: fastSafe.command_count,
        most_used: fastSafe.most_used,
        riskiest_operations: fastSafe.riskiest_operations,
        files: fastSafe.files,
        network: fastSafe.network,
        hard_findings: fastSafe.hard_findings,
        secret_findings: fastSafe.secret_findings,
        scan_duration_ms: fastSafe.scan_duration_ms,
      },
      // Provenance of the review itself.
      provenance: {
        reviewed_at: scannedAt,
        reviewed_at_ms: reviewCompletedAtMs,
        review_started_at_ms: reviewStartedAtMs,
        review_duration_ms: durationMs,
        review_mode: 'fresh',
        reviewer_model: model || 'auto',
        reviewer_system: 'hivv.org',
        policy_version: '2',
        scanner_version: '2',
        attestation_schema: 'blnq.attestation.v2',
        cost: {
          currency: 'USD',
          provider: 'local',
          amount_usd: 0,
          marginal_provider_cost: false,
          note: 'local/distributed compute; no marginal provider fee',
        },
        resources: {
          duration_ms: durationMs,
          source_bytes: bytes,
          analysis_passes: 2,
          retry_count: 0,
        },
        complexity: {
          size_class: fast.size.bytes >= 100000 ? 'large' : fast.size.bytes >= 10000 ? 'medium' : 'small',
          duration_class: durationMs >= 60000 ? 'long' : durationMs >= 10000 ? 'medium' : 'short',
        },
      },
    },
  });
  const signature = attest.signEnvelope(envelope, key.privateKey);

  return {
    subject,
    language,
    verdict: verdict.verdict,
    statement: verdict.statement,
    risk: verdict.risk,
    reasons: verdict.reasons,
    model,
    prescreen: flags,
    risk_score: riskScore,
    risk_level: riskLevel,
    reviewed_at: scannedAt,
    reviewed_at_ms: reviewCompletedAtMs,
    reviewed_date: new Date(scannedAt * 1000).toISOString().slice(0, 10),
    review_duration_ms: durationMs,
    reviewer_name: 'HIVV Code Safety Scanner',
    reviewer_system: 'hivv.org',
    fast_scan: {
      verdict: fastSafe.verdict,
      risk_score: fastSafe.risks.score,
      risk_level: fastSafe.risks.level,
      size: fastSafe.size,
      entropy: fastSafe.entropy,
      imports: fastSafe.imports,
      most_used: fastSafe.most_used,
      hard_findings: fastSafe.hard_findings,
      secret_findings: fastSafe.secret_findings,
      scan_duration_ms: fastSafe.scan_duration_ms,
    },
    commands: analysis.commands,
    most_used_commands: analysis.most_used_commands,
    files: analysis.files,
    network: analysis.network,
    risks: analysis.risks,
    scanned_at: scannedAt,
    signed: true,
    signature,
    public_key: key.rawPublicKey.toString('base64'),
    principal_id: key.principalId,
    envelope,
  };
}

// The HTTP entry point for the scanner.
router.post('/', limiter, async (req, res) => {
  try {
    const result = await scanSource({
      language: req.body?.language || 'python',
      code: req.body?.code,
    });
    res.json(result);
  } catch (e) {
    console.error('[scan] error:', e.message);
    const status = e.status || 500;
    res.status(status).json({
      error: status === 503 ? 'scan unavailable' : 'scan failed',
      detail: e.message,
      subject: e.subject,
      signed: false,
      prescreen: e.prescreen,
    });
  }
});

// The partner surface calls the SAME core so both produce identical signed
// artifacts.
router.scanForPartner = (args) => scanSource(args);

// Public key only — lets blnq pre-verify a signature before it ever submits it.
router.get('/key', (_req, res) => {
  const key = scanKey();
  res.json({
    principal_id: key.principalId,
    public_key: key.rawPublicKey.toString('base64'),
    algorithm: 'ed25519',
  });
});

module.exports = router;
