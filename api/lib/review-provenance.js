// api/lib/review-provenance.js — rich, privacy-aware review provenance.
//
// Purpose: every signed source.review should answer, in one verifiable place:
//   * who signed it (principal + reviewer label)
//   * what was reviewed (source hash, language, size)
//   * why they signed it (verdict, score, reasons, statement)
//   * which AI/model produced the assessment
//   * which worker/node performed the review (coarse public identity)
//   * exactly when it happened (seconds + milliseconds)
//   * what it cost (money + resource cost)
//   * how substantial the job was (complexity classification)
//
// PRIVACY MODEL (deliberate, enforced here):
//   * `public` fields are safe to put in a signed, publicly verifiable envelope.
//   * `private` fields (email, phone, exact IP, precise coordinates, full
//     traceroute, internal margins) NEVER enter a public envelope. They belong
//     in HIVV's private operator registry.
//   * The builder takes an explicit `privacy` policy and filters accordingly,
//     so adding a field to the wrong bucket cannot silently leak it.
//
// This module is intentionally dependency-free so BLNQ can keep a behaviorally
// identical copy without pulling in HIVV's router/database stack.

const crypto = require('crypto');

const DEFAULT_PRIVACY = Object.freeze({
  privacy_class: 'public',
  share_contact: false,
  share_exact_location: false,
  share_public_ip: false,
  share_trace_route: false,
  share_hostname: false,
});

function clampText(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function isSafeInt(value) {
  return Number.isSafeInteger(value);
}

function nonNegativeInt(value) {
  return isSafeInt(value) && value >= 0 ? value : null;
}

function round(value, places = 6) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const p = 10 ** places;
  return Math.round(value * p) / p;
}

// ── model identity ─────────────────────────────────────────────────────────
// Keep the useful parts of a model path/ID without leaking a filesystem path.
function normalizeModel(raw) {
  if (!raw) return null;
  const s = String(raw);
  let id = s;
  // HuggingFace cache: .../models--org--name/snapshots/<hash>/file.gguf
  const hf = s.match(/models--([^/]+)/);
  if (hf) id = hf[1].replace(/--/g, '/');
  else {
    // Local model file path -> basename without extension
    const base = s.split(/[\\/]/).pop();
    if (base && base !== s) id = base.replace(/\.(gguf|bin|safetensors|onnx|pt)$/i, '');
  }
  id = clampText(id, 160);
  if (!id) return null;

  const family = (String(id).match(/gemma|llama|qwen|mistral|mixtral|phi|deepseek|glm|kimi|minicm|codellama|gpt|claude|gemini/i) || [])[0];
  const quant = (String(id).match(/\b(Q\d(?:_[A-Z0-9]+)?|IQ\d(?:_[A-Z0-9]+)?|F16|BF16|FP16)\b/i) || [])[1];
  const params = (String(id).match(/\b(\d+(?:\.\d+)?B)\b/i) || [])[1];
  const provider = /\bllama\.cpp\b/i.test(s) ? 'llama.cpp'
    : /\bollama\b/i.test(s) ? 'ollama'
    : /\bvllm\b/i.test(s) ? 'vllm'
    : /\blm-?studio\b/i.test(s) ? 'lm-studio' : null;

  return {
    id,
    family: family ? family.toLowerCase() : null,
    provider,
    parameters: params || null,
    quantization: quant ? quant.toUpperCase() : null,
  };
}

// ── worker identity ────────────────────────────────────────────────────────
// Public: node id, coarse geography, transport. Private: hostname, exact IP,
// precise coordinates, traceroute. The privacy policy decides.
function normalizeWorker(worker, privacy) {
  if (!worker || typeof worker !== 'object') return null;
  const loc = worker.location || worker.geo || {};
  const out = {
    node_id: clampText(worker.node_id || worker.name || '', 120) || null,
    transport: ['direct', 'relay', 'cloud', 'local'].includes(worker.transport) ? worker.transport : null,
    region: clampText(loc.region || '', 64) || null,
    country_code: clampText(loc.country_code || loc.countryCode || '', 8).toUpperCase() || null,
    asn: clampText(loc.asn || '', 48) || null,
    network_class: ['datacenter', 'residential', 'mobile', 'unknown'].includes(loc.network_class)
      ? loc.network_class : 'unknown',
    privacy_class: clampText(worker.privacy_class || privacy.privacy_class, 32),
  };

  if (privacy.share_hostname) out.hostname = clampText(worker.hostname || '', 120) || null;
  if (privacy.share_public_ip) out.public_ip = clampText(worker.public_ip || '', 64) || null;
  if (privacy.share_exact_location) {
    out.latitude = round(loc.lat, 4);
    out.longitude = round(loc.lon ?? loc.lng, 4);
  }

  // Traceroute is topology data — only when explicitly permitted.
  if (privacy.share_trace_route && Array.isArray(worker.trace_route)) {
    out.network_trace = worker.trace_route.slice(0, 64).map((hop) => ({
      ttl: nonNegativeInt(hop.ttl),
      address: clampText(hop.address || '', 64) || null,
      hostname: clampText(hop.hostname || '', 120) || null,
      rtt_ms: round(hop.rtt_ms, 3),
      asn: clampText(hop.asn || '', 48) || null,
      region: clampText(hop.region || '', 64) || null,
    }));
  }
  return out;
}

// ── network summary ────────────────────────────────────────────────────────
// Even when the full trace stays private, BLNQ benefits from hop count and RTT.
function summarizeNetwork(worker, privacy) {
  if (!worker || typeof worker !== 'object') return null;
  const trace = Array.isArray(worker.trace_route) ? worker.trace_route : null;
  const rtts = trace
    ? trace.map((h) => Number(h && h.rtt_ms)).filter((n) => Number.isFinite(n))
    : [];
  const summary = {
    reachable: worker.reachable === undefined ? null : !!worker.reachable,
    hop_count: trace ? trace.length : null,
    rtt_ms: rtts.length ? round(Math.max(...rtts), 3) : (round(worker.rtt_ms, 3) ?? null),
    trace_shared: privacy.share_trace_route,
  };
  return summary;
}

// ── cost ───────────────────────────────────────────────────────────────────
// Split money from resource cost. A local model has $0 marginal provider cost
// but still consumes CPU/GPU time — saying so explicitly is more honest than
// omitting the field.
function buildCost(input, privacy) {
  const c = input.cost || {};
  const provider = clampText(c.provider || input.provider || 'local', 40);
  const amount = typeof c.amount_usd === 'number' && Number.isFinite(c.amount_usd)
    ? round(c.amount_usd, 8) : 0;
  const cost = {
    currency: 'USD',
    provider,
    amount_usd: amount,
    input_tokens: nonNegativeInt(c.input_tokens) || 0,
    output_tokens: nonNegativeInt(c.output_tokens) || 0,
    estimated: c.estimated === undefined ? false : !!c.estimated,
  };
  if (provider === 'local' || provider === 'hivv' || provider === 'relay') {
    cost.marginal_provider_cost = false;
    cost.note = 'local/distributed compute; no marginal provider fee';
  } else {
    cost.marginal_provider_cost = true;
  }
  // Internal margin is operator-private; never publish it.
  if (!privacy.share_internal_margin && c.margin_usd !== undefined) delete cost.margin_usd;
  return cost;
}

function buildResources(input) {
  const r = input.resources || {};
  const duration = nonNegativeInt(r.duration_ms);
  const cpuMs = nonNegativeInt(r.cpu_ms);
  return {
    duration_ms: duration,
    cpu_ms: cpuMs,
    cpu_seconds: cpuMs === null ? null : round(cpuMs / 1000, 3),
    gpu_ms: nonNegativeInt(r.gpu_ms) || 0,
    peak_rss_kb: nonNegativeInt(r.peak_rss_kb) || 0,
    source_bytes: nonNegativeInt(r.source_bytes) || 0,
    analysis_passes: nonNegativeInt(r.analysis_passes) || 0,
    retry_count: nonNegativeInt(r.retry_count) || 0,
  };
}

// ── complexity ────────────────────────────────────────────────────────────
// "Big job to study it all" made concrete and comparable across reviews.
function classifyComplexity({ bytes, lines, commands, durationMs, riskScore }) {
  const size = bytes >= 100000 ? 'large' : bytes >= 10000 ? 'medium' : 'small';
  const duration = durationMs >= 60000 ? 'long' : durationMs >= 10000 ? 'medium' : 'short';
  let score = 0;
  if (bytes >= 100000) score += 40;
  else if (bytes >= 10000) score += 20;
  else if (bytes >= 1000) score += 8;
  if (durationMs >= 60000) score += 35;
  else if (durationMs >= 10000) score += 18;
  else if (durationMs >= 2000) score += 6;
  if (commands >= 20) score += 15;
  else if (commands >= 8) score += 8;
  if (riskScore >= 70) score += 10;
  return { size_class: size, duration_class: duration, score: Math.max(0, Math.min(100, score)) };
}

// ── builder ────────────────────────────────────────────────────────────────
function buildProvenance(input = {}) {
  const privacy = Object.assign({}, DEFAULT_PRIVACY, input.privacy || {});
  const startedAt = nonNegativeInt(input.started_at_ms);
  const reviewedAtMs = nonNegativeInt(input.reviewed_at_ms)
    ?? (nonNegativeInt(input.reviewed_at) === null ? null : nonNegativeInt(input.reviewed_at) * 1000);
  const durationMs = nonNegativeInt(input.duration_ms)
    ?? (startedAt !== null && reviewedAtMs !== null ? Math.max(0, reviewedAtMs - startedAt) : null);

  const worker = normalizeWorker(input.worker, privacy);
  const resources = buildResources({
    ...(input.resources || {}),
    duration_ms: durationMs,
    source_bytes: (input.analysis && input.analysis.bytes) || (input.resources || {}).source_bytes,
  });

  const out = {
    reviewer_name: clampText(input.reviewer_name || 'Unnamed reviewer', 128),
    reviewer_system: clampText(input.reviewer_system || 'unknown', 64),
    reviewer_version: clampText(input.reviewer_version || '2', 32),
    reviewer_model: normalizeModel(input.model || input.reviewer_model),
    reviewer_node: worker,
    reviewed_at: reviewedAtMs === null ? null : Math.floor(reviewedAtMs / 1000),
    reviewed_at_ms: reviewedAtMs,
    reviewed_timezone: 'UTC',
    review_started_at_ms: startedAt,
    review_duration_ms: durationMs,
    review_mode: ['fresh', 'cached', 'reused'].includes(input.review_mode) ? input.review_mode : 'fresh',
    cache_hit: input.cache_hit === undefined ? false : !!input.cache_hit,
    cost: buildCost(input, privacy),
    resources,
    complexity: classifyComplexity({
      bytes: resources.source_bytes,
      lines: (input.analysis && input.analysis.lines) || 0,
      commands: (input.analysis && input.analysis.command_count) || 0,
      durationMs: durationMs || 0,
      riskScore: (input.analysis && input.analysis.risks && input.analysis.risks.score) || 0,
    }),
    network: summarizeNetwork(input.worker, privacy),
    policy_version: clampText(input.policy_version || '2', 32),
    scanner_version: clampText(input.scanner_version || '2', 32),
    attestation_schema: 'blnq.attestation.v2',
    // Provenance about the review itself (never private).
    deterministic_agreement: input.deterministic_agreement === undefined
      ? null : !!input.deterministic_agreement,
    disagreement_reason: input.disagreement_reason
      ? clampText(input.disagreement_reason, 240) : null,
    human_override: input.human_override ? {
      by: clampText(input.human_override.by, 120),
      reason: clampText(input.human_override.reason, 240),
      at_ms: nonNegativeInt(input.human_override.at_ms),
    } : null,
  };

  // Convenience digest over the provenance (not a signature — the envelope
  // signature covers everything; this is for quick comparison/grouping).
  out.provenance_digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(out))
    .digest('hex')
    .slice(0, 32);

  return out;
}

module.exports = {
  DEFAULT_PRIVACY,
  normalizeModel,
  normalizeWorker,
  summarizeNetwork,
  buildCost,
  buildResources,
  classifyComplexity,
  buildProvenance,
};
