// api/lib/licenses.js — what we know about model licenses, and our preference.
//
// The stance: TOTALLY OPEN models — copyleft (GPLv3) or permissive (MIT /
// Apache-2.0) — are preferred, because they can be MODIFIED AND STUDIED.
// Fork the weights like you fork the code.
//
// This is a HINT table, not a legal opinion: weights licensing is messy in
// reality (and changes). unknown = we honestly do not know — say so, never
// guess a verdict. The preference never blocks; it SUGGESTS.

const KNOWN = [
  // family regex            license                 open?
  [/qwen/i,                 'Apache-2.0',            true],
  [/mistral|mixtral/i,      'Apache-2.0',            true],
  [/phi[-_ ]?\d/i,          'MIT',                   true],
  [/deepseek/i,             'MIT',                   true],
  [/gemma/i,                'Gemma Terms (NOT OSI-open)', false],
  [/llama/i,                'Llama Community License (NOT OSI-open)', false],
  [/openchat|vicuna|wizardlm|alpaca/i, 'Apache-2.0 (weights may vary)', true],
  [/falcon/i,               'Apache-2.0',            true],
  [/gpt-oss/i,              'Apache-2.0',            true],
  [/openelm/i,              'Apple MLX License (research)', false],
];

/** License hint for a model name — {license, open} or null when unknown. */
function licenseFor(model) {
  const s = String(model || '');
  for (const [re, license, open] of KNOWN) {
    if (re.test(s)) return { license, open };
  }
  return null;
}

/** The public statement (manifest / docs). */
const PREFERENCE = 'TOTALLY OPEN models are preferred — copyleft (GPLv3) or ' +
  'permissive (MIT / Apache-2.0) — because they can be modified and studied. ' +
  'Fork the weights like you fork the code. Unknown licenses are labeled unknown, ' +
  'never guessed, never blocked — the preference suggests, it does not gate.';

module.exports = { licenseFor, PREFERENCE, KNOWN };
