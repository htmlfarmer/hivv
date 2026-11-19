// Brain board: power = IQ × speed-factor, fair sorting, needs-hand flag.
const test = require('node:test');
const assert = require('node:assert');
const { powerScore, speedFactor, buildBrainBoard } = require('../lib/brainboard');

test('unknown speed = neutral 1.0x (no info is not a penalty)', () => {
  assert.strictEqual(speedFactor(0), 1.0);
  assert.strictEqual(powerScore(100, 0), 100);
});

test('speed factor curve: 10→0.6x, 50→1.0x, 150+→2.0x cap', () => {
  assert.strictEqual(speedFactor(10), 0.6);
  assert.strictEqual(speedFactor(50), 1.0);
  assert.strictEqual(speedFactor(150), 2.0);
  assert.strictEqual(speedFactor(999), 2.0);
  assert.strictEqual(powerScore(135, 120), Math.round(135 * 1.7));
});

test('null IQ → null power (never fabricated)', () => {
  assert.strictEqual(powerScore(null, 100), null);
  assert.strictEqual(powerScore(undefined, 100), null);
  assert.strictEqual(powerScore('n/a', 100), null);
});

const NODES = [
  { node_id: 'a', name: 'fast-dumb', status: 'online', local_models: [],
    exam_summary: { score: 70, iq: 111, ts: 1, by_cat: {} } },
  { node_id: 'b', name: 'slow-smart', status: 'online', local_models: [],
    exam_summary: { score: 100, iq: 135, ts: 2, by_cat: {} } },
  { node_id: 'c', name: 'weakling', status: 'online', local_models: [],
    exam_summary: { score: 40, iq: 87, ts: 3, by_cat: {} } },
  { node_id: 'd', name: 'untested', status: 'online', local_models: [],
    human_ratings: [{ score: 9, note: 'nice', ts: 4 }] },
];
const PERF = [
  { node: 'fast-dumb', via: 'direct', ewma_tps: 120 },
  { node: 'slow-smart', via: 'direct', ewma_tps: 30 },
  { node: 'slow-smart', via: 'relay', ewma_tps: 999 },   // relay never counts
];

test('board ranks by power: fast-111 (×1.7=189) beats smart-135 (×0.8=108)', () => {
  const rows = buildBrainBoard(NODES, PERF);
  assert.strictEqual(rows[0].name, 'fast-dumb');
  assert.strictEqual(rows[0].power, 189);
  const slow = rows.find(r => r.name === 'slow-smart');
  assert.strictEqual(slow.power, 108);      // 135 × 0.8 (30 t/s)
  assert.strictEqual(slow.tps, 30);         // relay 999 ignored
});

test('needs_hand flags practical score < 60', () => {
  const rows = buildBrainBoard(NODES, PERF);
  assert.strictEqual(rows.find(r => r.name === 'weakling').needs_hand, true);
  assert.strictEqual(rows.find(r => r.name === 'fast-dumb').needs_hand, false);
});

test('untested bee still boards with human votes (iq null)', () => {
  const rows = buildBrainBoard(NODES, PERF);
  const u = rows.find(r => r.name === 'untested');
  assert.ok(u, 'human-rated bee must appear');
  assert.strictEqual(u.iq, null);
  assert.strictEqual(u.power, null);
  assert.strictEqual(u.human_avg, 9);
});
