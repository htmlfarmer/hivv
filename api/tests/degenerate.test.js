// Degenerate-output guard — the HUB twin of the CLI's `_looks_degenerate`.
// Same fixture sample (the real Stuarts-iMac gemma loop): a fast garbage
// model must score ok:false in the routing EWMA instead of winning traffic.
const test = require('node:test');
const assert = require('node:assert');
const { looksDegenerate } = require('../lib/degenerate');

const IMAC_LOOP =
  '}}^}}^}}^ 협 협hommehommehommehommehommehomme ' +
  'kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu kiểu ' +
  'Keen Keen Keen Keen Keen ' +
  'servedservedservedservedservedservedservedservedservedserved' +
  'servedservedservedserved';

const NORMAL = 'Hello! How can I help you today? I can explain the hive, check your nodes, or just chat — whatever you need.';

test('real imac repetition loop is flagged', () => {
  assert.strictEqual(looksDegenerate(IMAC_LOOP), true);
});

test('normal reply passes', () => {
  assert.strictEqual(looksDegenerate(NORMAL), false);
});

test('short text never flagged (min-length rule)', () => {
  assert.strictEqual(looksDegenerate('OK'), false);
  assert.strictEqual(looksDegenerate(''), false);
  assert.strictEqual(looksDegenerate(null), false);
  assert.strictEqual(looksDegenerate(undefined), false);
});

test('control-char noise flagged', () => {
  assert.strictEqual(looksDegenerate('A'.repeat(30) + '\x00'.repeat(10)), true);
});

test('dominant word without adjacency flagged', () => {
  const text = 'served okay served fine served yes served no served go served end of a normal sentence here';
  assert.strictEqual(looksDegenerate(text), true);
});
