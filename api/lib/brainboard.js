// api/lib/brainboard.js — the public brain board: IQ + practical score +
// hub-measured speed + AI/human ranks in ONE ranking.
//
// power (v1) = IQ × speed-factor
//   factor = 1.0 when speed is UNKNOWN (no info is NOT a penalty),
//   else 0.5 + tps/100 clamped to [0.5, 2.0]:
//     10 t/s → 0.6× · 50 t/s → 1.0× (plain IQ) · 150+ t/s → 2.0×
// Labelled v1 everywhere — recalibrates alongside the IQ index itself.
//
// needs_hand: practical score < 60 → the board invites the hive to help
// (coaching tips on the tested node, human encouragement via `hivv rate`).

function speedFactor(tps) {
  const t = Number(tps) || 0;
  if (t <= 0) return 1.0;
  return Math.max(0.5, Math.min(2.0, 0.5 + t / 100));
}

function powerScore(iq, tps) {
  if (iq === null || iq === undefined || iq === '') return null;
  const q = Number(iq);
  if (!Number.isFinite(q)) return null;
  return Math.round(q * speedFactor(tps));
}

function buildBrainBoard(nodes, perfSamples = []) {
  // Speed: best DIRECT ewma tps per node, keyed by name or node_id
  const tpsByKey = Object.create(null);
  for (const s of perfSamples || []) {
    if (!s || (s.via || 'direct') !== 'direct') continue;
    const t = Number(s.ewma_tps) || 0;
    for (const k of [s.node, s.node_id]) {
      if (!k) continue;
      if (!(k in tpsByKey) || t > tpsByKey[k]) tpsByKey[k] = t;
    }
  }

  const rows = [];
  for (const n of nodes || []) {
    const s = n.exam_summary
      || (n.quality_score != null ? { score: n.quality_score } : null);
    const human = Array.isArray(n.human_ratings) ? n.human_ratings : [];
    const hAvg = human.length
      ? Math.round((human.reduce((a, r) => a + (r.score || 0), 0) / human.length) * 10) / 10
      : null;
    if (!s && !human.length) continue;
    const tps = Math.round(Math.max(
      Number(tpsByKey[n.name]) || 0, Number(tpsByKey[n.node_id]) || 0));
    const score = s && s.score != null ? Number(s.score) : null;
    rows.push({
      node_id: n.node_id,
      name: n.name,
      status: n.status,
      models: (n.local_models || [])
        .map(m => String(m.model || m.name || '').split('/').pop())
        .filter(Boolean).slice(0, 3),
      score,
      iq: s && s.iq != null ? Number(s.iq) : null,
      ts: (s && s.ts) || null,
      ai_avg: s && s.ai_avg != null ? Number(s.ai_avg) : null,
      by_cat: (s && s.by_cat) || {},
      tps: tps || null,
      power: powerScore(s && s.iq != null ? s.iq : null, tps),
      needs_hand: score != null && score < 60,
      human_avg: hAvg,
      human_votes: human.length,
      human_notes: human.slice(-5).map(r => r.note).filter(Boolean),
    });
  }
  rows.sort((a, b) => (b.power || 0) - (a.power || 0)
    || (b.iq || 0) - (a.iq || 0)
    || (b.score || 0) - (a.score || 0)
    || (b.human_votes || 0) - (a.human_votes || 0));
  return rows;
}

module.exports = { buildBrainBoard, powerScore, speedFactor };
