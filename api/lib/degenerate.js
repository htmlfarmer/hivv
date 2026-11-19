// api/lib/degenerate.js — deterministic garbage detector for model output.
//
// WHY THIS EXISTS: routing's reliability score (perf EWMA ok/err) only counts
// HTTP success — a FAST degenerate model (repetition loops, mojibake) would
// score HIGHER and get routed MORE traffic, spreading garbage across the hive.
// Real sample: Stuarts-iMac-Pro gemma loop, 2026-11-18 —
//   "…hommehommehommehommehomme kiểu kiểu kiểu kiểu… servedservedserved…"
//
// Mirrors the CLI's `_looks_degenerate` (public_html/hivv-cli.py) — keep the
// thresholds in step; BOTH test suites pin the same fixture sample.

function looksDegenerate(text) {
  if (typeof text !== 'string' || text.length < 40) return false;

  // 1. Adjacent short-unit loops: the same 2-14 char unit ≥5× back to back
  //    ('kiểu kiểu kiểu…', 'hommehommehomme…', 'the the the the the').
  if (/([^\n]{2,14}?)\1{4,}/.test(text)) return true;

  // 2. One ≥4-char word dominating the reply: ≥6 uses AND ≥20% of all words.
  const words = text.toLowerCase().match(/[\w']+/g) || [];
  if (words.length >= 12) {
    const counts = Object.create(null);
    let top = 0;
    for (const w of words) {
      if (w.length < 4) continue;
      counts[w] = (counts[w] || 0) + 1;
      if (counts[w] > top) top = counts[w];
    }
    if (top >= 6 && top / words.length >= 0.20) return true;
  }

  // 3. Control / replacement chars — broken decoding noise.
  let bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c < 32 && c !== 10 && c !== 13 && c !== 9) || c === 0xfffd) bad++;
  }
  return bad / text.length > 0.03;
}

module.exports = { looksDegenerate };
