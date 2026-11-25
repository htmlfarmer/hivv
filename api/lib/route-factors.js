// api/lib/route-factors.js — the routing factor vector.
// Plan: HIVV_ROUTING_PLAN.md §7 "Factor routing — the scoring vector".
//
// WHY THIS EXISTS
//   `router._scoreTargets` used to be a `switch(mode)` with 4-5 ad-hoc terms
//   (`tps*rel`, `quality*12`, `20000/lat`, `free+100`, `trust*20`). Every new
//   signal meant another case branch and another chance to get the scale
//   wrong — and no single place could answer "WHY did this bee win?".
//   This module makes the decision explicit:
//
//       every candidate → the SAME vector of factors, each in [0,1]
//       a mode          → nothing but a weight table over that vector
//       score           → 100 · Σ(wᵢ·fᵢ) / Σ(wᵢ)          ∈ [0,100]
//
// LAWS
//  1. NO FACTOR IS EVER NaN/undefined. Every normalizer returns NEUTRAL (0.5)
//     when the data is missing: "no data" must never beat or lose to
//     "measured". Two deliberate exceptions, both documented on the function:
//       · reliability — unknown = 1.0 (a brand-new bee must not be locked out
//         of traffic before it can prove itself; today's router does this too)
//       · speed       — unknown = the LOW `unknown_tps` prior (8 t/s), so a
//         measured bee is preferred over an unmeasured one, while jitter keeps
//         the unmeasured ones warm.
//  2. Privacy and capabilities are HARD FILTERS upstream (`_orderByMode`,
//     `routeWithFailover`'s transport order). The privacy/capability FACTORS
//     only rank candidates that already passed those gates — a weight can
//     never buy back a gate. See router.js:1755 "privacy filter is a hard
//     gate, not a weight".
//  3. Weights are DATA (`gateway_config.routing.weights`), not code.
//  4. Every factor is monotone in the thing it measures: better latency ⇒
//     higher factor, never lower. Tests in api/tests/route-factors.test.js
//     pin this for each one.

'use strict';

const NEUTRAL = 0.5;

// The contract. Anything added here must also appear in DEFAULT_WEIGHTS for
// every mode, in `computeFactors`, and in the factor tests.
const FACTORS = [
  'latency',      // time to first token (TTFT), ms — lower is better
  'speed',        // generated tokens/sec — higher is better
  'capacity',     // free VRAM × free worker slots — higher is better
  'queue',        // jobs already waiting on this bee — lower is better
  'reliability',  // recent completion vs failure rate — higher is better
  'quality',      // model quality tier (task-specific term = `capability`)
  'cost',         // actual price or donated quota consumed — lower is better
  'privacy',      // local > LAN peer > public peer > cloud
  'geography',    // network/region proximity to the hub
  'capability',   // does this candidate satisfy THIS request's requirements?
  'trust',        // honey rank (queen-bee … larva) — used by `trusted` mode
];

// Per-mode weight tables. Tuned so each mode keeps the intent of the old
// switch() it replaces; every one is overridable per mode in
// `gateway_config.routing.weights.<mode>.<factor>`.
//
// Reading them: the RELATIVE size inside a row is what matters (the score is a
// weighted average, so only ratios decide the ranking). Compare `quality`'s
// 6 against `speed`'s 0.8 — model quality is ~7x more decisive than raw speed
// in quality mode, which is what `quality*12 + tps*0.15*rel` used to say.
const DEFAULT_WEIGHTS = {
  // was: tps·rel + jitter — measured throughput, reliability as the brake.
  balanced: {
    speed: 1.0, reliability: 0.9, latency: 0.6, capability: 0.5, queue: 0.4,
    quality: 0.4, capacity: 0.3, cost: 0.3, privacy: 0.25, geography: 0.15,
    trust: 0,
  },
  // was: (20000/lat)·rel — first byte is everything.
  fast: {
    latency: 2.0, speed: 0.7, queue: 0.5, reliability: 0.6, geography: 0.3,
    capability: 0.3, capacity: 0.3, quality: 0.2, cost: 0.15, privacy: 0.15,
    trust: 0,
  },
  // was: quality*12 + tps*0.15·rel — the model dominates, speed is a tiebreak.
  quality: {
    quality: 6, capability: 1.5, reliability: 1, speed: 0.8, latency: 0.5,
    queue: 0.4, capacity: 0.3, cost: 0.3, privacy: 0.3, geography: 0.2,
    trust: 0,
  },
  // was: free(0|100) + tps*0.1·rel — donated compute beats anything priced.
  cost: {
    cost: 4, speed: 0.5, reliability: 0.6, queue: 0.35, latency: 0.3,
    capability: 0.3, capacity: 0.25, quality: 0.2, privacy: 0.2,
    geography: 0.1, trust: 0,
  },
  // was: trust*20 + tps*0.1·rel — honey rank first, health second.
  trusted: {
    trust: 4, reliability: 0.7, speed: 0.4, capability: 0.4, latency: 0.3,
    queue: 0.3, capacity: 0.2, quality: 0.3, cost: 0.2, privacy: 0.2,
    geography: 0.1,
  },
  // was: tps·rel + jitter, but only after the privacy HARD gate had already
  // removed anything outside the hive. The factor ranks what survived it.
  private: {
    privacy: 3, reliability: 0.7, speed: 0.5, latency: 0.4, capability: 0.4,
    queue: 0.3, capacity: 0.25, quality: 0.3, cost: 0.2, geography: 0.1,
    trust: 0.2,
  },
};

// ── small math ───────────────────────────────────────────────────────────────

function clamp01(x) {
  if (!Number.isFinite(x)) return NEUTRAL;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Saturating curve: 0 → 0, k → 0.5, ∞ → 1. Used for "more is better, but the
// difference between 100 and 200 t/s matters far less than 0 and 50.
function sat(x, k) {
  const v = Number.isFinite(x) ? Math.max(0, x) : 0;
  return v / (v + k);
}

function firstFinite(...vals) {
  for (const v of vals) if (v != null && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Great-circle distance in km. Returns null unless BOTH ends are real coords.
function haversineKm(a, b) {
  const lat1 = firstFinite(a?.lat ?? a?.latitude);
  const lon1 = firstFinite(a?.lon ?? a?.longitude ?? a?.lng);
  const lat2 = firstFinite(b?.lat ?? b?.latitude);
  const lon2 = firstFinite(b?.lon ?? b?.longitude ?? b?.lng);
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ── the factors ──────────────────────────────────────────────────────────────

// LATENCY — time to first token. Prefer the real TTFT when we have it; the
// completion-shaped `latency_ms` is a fallback (it always overstates TTFT).
// REF = 1s: 0ms → 1.0, 1s → 0.5, 3s → 0.25.
function latencyFactor({ ttfbMs, latMs } = {}) {
  const t = firstFinite(ttfbMs, latMs);
  if (t == null) return NEUTRAL;
  return 1000 / (1000 + Math.max(0, t));
}

// SPEED — generated tokens/sec. Unknown falls back to the LOW `unknown_tps`
// prior (router default 8 t/s → 0.21) rather than NEUTRAL: an unmeasured bee
// should be reachable but should not outrank a bee we have actually watched
// serve. Jitter keeps it in the rotation.
function speedFactor({ tps, unknownTps = 8 } = {}) {
  const v = firstFinite(tps);
  return sat(v != null && v > 0 ? v : unknownTps, 30);
}

// CAPACITY — free VRAM × free worker slots. Both come off the heartbeat, so a
// bee whose owner is mid-training (VRAM full) or mid-burst (slots full) drops
// out of the running WITHOUT having failed a single request. A node with no
// GPU reported falls back to system RAM%; a node with neither is NEUTRAL.
function capacityFactor({ gpus, memPct, maxJobs, activeTasks } = {}) {
  let vram = null;
  if (Array.isArray(gpus) && gpus.length) {
    const total = gpus.reduce((s, g) => s + (Number(g?.mem_total_mb) || 0), 0);
    const used = gpus.reduce((s, g) => s + (Number(g?.mem_used_mb) || 0), 0);
    if (total > 0) vram = clamp01(1 - used / total);
  } else if (firstFinite(memPct) != null) {
    vram = clamp01(1 - Number(memPct) / 100);
  }
  let slots = null;
  const max = firstFinite(maxJobs);
  if (max != null && max > 0) {
    slots = clamp01((max - (Number(activeTasks) || 0)) / max);
  }
  if (vram == null && slots == null) return NEUTRAL;
  if (vram == null) return slots;
  if (slots == null) return vram;
  return 0.5 * vram + 0.5 * slots;
}

// QUEUE — work already waiting. A relay job counts double: it occupies the
// bee's inbox AND a poll cycle before the answer even starts. 0 waiting → 1.0.
function queueFactor({ activeTasks, relayActive } = {}) {
  if (activeTasks == null && relayActive == null) return NEUTRAL;
  const active = Number(activeTasks) || 0;
  const relay = Number(relayActive) || 0;
  return 1 / (1 + active + 2 * relay);
}

// RELIABILITY — how often this (node, model) actually answered. The shape
// (0.25 + 0.75·rate², unknown = 1.0) is carried over unchanged from the old
// scorer: a flaky bee keeps a floor so it stays reachable when it is the only
// bee left, but never outranks a healthy one.
function reliabilityFactor({ okRate } = {}) {
  if (okRate == null || !Number.isFinite(Number(okRate))) return 1;
  return 0.25 + 0.75 * clamp01(Number(okRate)) ** 2;
}

// QUALITY — model tier from `router._qualityOf` (5..10,5 = unknown name).
// Mapped onto [0.5, 1.0] so "unknown model" reads as neutral, not as the worst
// thing in the hive. Task-specific quality is the `capability` factor below;
// when `p_wise` (HIVV_ROUTING_PLAN §2) ships it replaces this term wholesale.
function qualityFactor({ qualityScore } = {}) {
  const q = firstFinite(qualityScore) ?? 5;
  return clamp01(0.5 + (q - 5) / 10);
}

// COST — actual price or donated quota. Local and peer bees are DONATED
// compute → 1.0, full stop. A priced endpoint decays with its estimated cost
// for a ~256-in/512-out request; an unpriced non-free endpoint is NEUTRAL.
function costFactor({ free, priceUsd } = {}) {
  if (free) return 1;
  const p = firstFinite(priceUsd);
  if (p == null) return NEUTRAL;
  return 1 / (1 + Math.max(0, p) * 200);
}

// PRIVACY — where the payload goes. Only ranks candidates that already passed
// the transport GATE (law #2). LAN peer vs public peer is a real distinction:
// an RFC1918 address means the payload never leaves a private network.
function privacyFactor({ isLocal, isPeer, isPublicPeer } = {}) {
  if (isLocal) return 1;
  if (isPeer) return isPublicPeer ? 0.7 : 0.85;
  return 0.4; // external / cloud key endpoint
}

// GEOGRAPHY — network & region proximity to the HUB. Needs both ends to have
// real coordinates; until the hub knows its own location this is NEUTRAL for
// everyone (which is honest: an unknown distance is not a far one). Note the
// physical distance also shows up inside TTFT — this factor is deliberately
// low-weight everywhere except `fast`, where it acts as the tiebreaker between
// two bees with equal latency.
function geographyFactor({ hubLoc, nodeLoc } = {}) {
  const km = haversineKm(hubLoc, nodeLoc);
  if (km == null) return NEUTRAL;
  return clamp01(1 - Math.min(km, 8000) / 8000);
}

// CAPABILITY — does this candidate satisfy THIS request's requirements?
// Requirements are gathered by the router (context fit, tool-calling, …) and
// passed in as tri-state booleans: `null` = not applicable, so a plain chat
// message with no tools and no size pressure scores NEUTRAL instead of a
// meaningless 1.0. This is the task-specific half of "quality".
function capabilityFactor({ contextOk, toolsOk } = {}) {
  const reqs = [];
  if (contextOk != null) reqs.push(contextOk ? 1 : 0);
  if (toolsOk != null) reqs.push(toolsOk ? 1 : 0);
  if (!reqs.length) return NEUTRAL;
  return reqs.reduce((s, v) => s + v, 0) / reqs.length;
}

// TRUST — honey rank (larva 1 … queen-bee 6), normalized. Unknown rank = 0,
// matching the old `trust*20` term: an unranked bee is not yet vouched for.
function trustFactor({ trustScore } = {}) {
  const t = firstFinite(trustScore) ?? 0;
  return clamp01(t / 6);
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Build the full factor vector for one candidate.
 * @param {object} input raw signals (see each factor for what it reads)
 * @returns {{factors: Object<string,number>, raw: Object<string,*>}}
 */
function computeFactors(input = {}) {
  const factors = {
    latency: latencyFactor(input),
    speed: speedFactor(input),
    capacity: capacityFactor(input),
    queue: queueFactor(input),
    reliability: reliabilityFactor(input),
    quality: qualityFactor(input),
    cost: costFactor(input),
    privacy: privacyFactor(input),
    geography: geographyFactor(input),
    capability: capabilityFactor(input),
    trust: trustFactor(input),
  };
  // Belt: a factor that somehow escaped its normalizer must not poison the
  // score with NaN — a NaN score sorts nowhere and silently empties the roster.
  for (const k of FACTORS) {
    if (!Number.isFinite(factors[k])) factors[k] = NEUTRAL;
  }
  return { factors, raw: input };
}

/** Weights for a mode: defaults overlaid with `gateway_config.routing.weights[mode]`. */
function weightsFor(mode, cfgWeights) {
  const base = DEFAULT_WEIGHTS[mode] || DEFAULT_WEIGHTS.balanced;
  const w = { ...base };
  const over = cfgWeights && typeof cfgWeights === 'object' ? cfgWeights[mode] : null;
  if (over && typeof over === 'object') {
    for (const k of FACTORS) {
      const v = Number(over[k]);
      if (Number.isFinite(v) && v >= 0) w[k] = v;
    }
  }
  return w;
}

/**
 * Weighted score, 0..100. Factors missing from the weight table count for 0;
 * a mode with no usable weights at all returns the midpoint (never NaN).
 */
function scoreWith(weights, factors) {
  let num = 0;
  let den = 0;
  for (const k of FACTORS) {
    const w = Number(weights?.[k]);
    if (!Number.isFinite(w) || w <= 0) continue;
    num += w * (Number.isFinite(factors?.[k]) ? factors[k] : NEUTRAL);
    den += w;
  }
  if (den <= 0) return 50;
  return (100 * num) / den;
}

/** The sum of a weight table — used by the dry-run to explain itself. */
function weightTotal(weights) {
  let den = 0;
  for (const k of FACTORS) {
    const w = Number(weights?.[k]);
    if (Number.isFinite(w) && w > 0) den += w;
  }
  return den;
}

module.exports = {
  NEUTRAL,
  FACTORS,
  DEFAULT_WEIGHTS,
  clamp01,
  sat,
  haversineKm,
  latencyFactor,
  speedFactor,
  capacityFactor,
  queueFactor,
  reliabilityFactor,
  qualityFactor,
  costFactor,
  privacyFactor,
  geographyFactor,
  capabilityFactor,
  trustFactor,
  computeFactors,
  weightsFor,
  scoreWith,
  weightTotal,
};
