// api/tests/licenses.test.js — the open-model preference.
// The stance: totally open (GPLv3/MIT/Apache-2.0) models are PREFERRED
// because they can be modified and studied — and unknown licenses are
// labeled unknown, never guessed, never blocked.
//
// Run with:  cd api && node --test tests/licenses.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const licenses = require('../lib/licenses');

test('known open families are marked open', () => {
  assert.deepEqual(licenses.licenseFor('Qwen2.5-0.5B-Instruct-GGUF'),
    { license: 'Apache-2.0', open: true });
  assert.equal(licenses.licenseFor('mistral:7b').open, true);
  assert.equal(licenses.licenseFor('phi-4').license, 'MIT');
  assert.equal(licenses.licenseFor('deepseek-r1').open, true);
});

test('restricted families are honestly marked NOT open', () => {
  const gemma = licenses.licenseFor('gemma-4-E2B');
  assert.equal(gemma.open, false);
  assert.match(gemma.license, /NOT OSI-open/);
  assert.equal(licenses.licenseFor('llama-3.1-8b').open, false);
});

test('unknown models say unknown — null, never a guess', () => {
  assert.equal(licenses.licenseFor('mystery-model-9000'), null);
  assert.equal(licenses.licenseFor(''), null);
  assert.equal(licenses.licenseFor(undefined), null);
});

test('the preference statement: copyleft, MIT, Apache — and never a gate', () => {
  const p = licenses.PREFERENCE;
  assert.match(p, /copyleft/);
  assert.match(p, /GPLv3/);
  assert.match(p, /MIT/);
  assert.match(p, /Apache-2\.0/);
  assert.match(p, /modified and studied/);
  assert.match(p, /suggests, it does not gate/);
});
