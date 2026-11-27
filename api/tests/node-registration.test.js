// api/tests/node-registration.test.js — registering a bee must not 500.
//
// WHAT HAPPENED
// --------------
// registerNode() built its node object with
//
//     hw_id: nodeData.hw_id || existingNode?.hw_id || ''
//
// but "existingNode" is declared INSIDE the
// "if (this.nodes.has(nodeId)) { ... }" block, and that block has closed by
// the time the object literal is built. It was out of scope — a ReferenceError
// waiting to happen.
//
// It never happened, because of || short-circuiting: with hw_id present the
// right-hand side is never evaluated, so every hw_id registration succeeded.
// The endpoint explicitly allows a TOKEN instead of an hw_id
// (server.js: "must provide hw_id or token"), and THAT path evaluated the
// dead reference and returned:
//
//     500 {"error":"existingNode is not defined"}
//
// Reproduced live. The fix uses "existing", which is declared at function
// scope on the line above and is already used for secret, secret_seen and
// volunteer in the same literal.
//
// Run with:  cd api && node --test tests/node-registration.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

function freshOrchestrator() {
  // A clean instance per test: the constructor loads persisted nodes from
  // nodes.json, and a test that leaves a node behind would poison the next.
  const Orchestrator = require(path.join(REPO, 'api', 'lib', 'orchestrator.js'));
  return new Orchestrator();
}

test('registering with an hw_id works', () => {
  const orch = freshOrchestrator();
  const node = orch.registerNode({ id: 'reg-hw-probe', name: 'probe', hw_id: 'HW-1' });
  assert.equal(node.node_id, 'reg-hw-probe');
  assert.equal(node.hw_id, 'HW-1');
  orch.nodes.delete('reg-hw-probe');
});

test('registering with a TOKEN and no hw_id must not throw', () => {
  // This is the path that returned 500: nodeData.hw_id is falsy, so
  // "nodeData.hw_id || existingNode?.hw_id" had to evaluate the right side,
  // and existingNode is not in scope there.
  const orch = freshOrchestrator();
  let node;
  assert.doesNotThrow(() => {
    node = orch.registerNode({ id: 'reg-token-probe', name: 'probe', token: 'tok-abc' });
  }, 'registerNode threw for a token-based registration');
  // NOTE on the id: registerNode does `nodeId = nodeData.token || nodeData.id`,
  // so a body token WINS over an explicit id. The real CLI sends them
  // equal ({id: stable_id, token: stable_id}) so it never matters, but
  // pin the precedence here rather than assume it.
  assert.equal(node.node_id, 'tok-abc', 'a body token wins over an explicit id');
  assert.equal(node.hw_id, '', 'no hw_id was presented, so none is stored');
  orch.nodes.delete('reg-token-probe');
});

test('registering with neither still yields a valid object', () => {
  const orch = freshOrchestrator();
  const node = orch.registerNode({ id: 'reg-bare-probe', name: 'probe' });
  assert.ok(node && typeof node === 'object');
  assert.equal(node.hw_id, '');
  assert.ok(node.name, 'a name is always present');
  orch.nodes.delete('reg-bare-probe');
});

test('the fix uses the in-scope variable, not the block-scoped one', () => {
  const src = fs.readFileSync(path.join(REPO, 'api', 'lib', 'orchestrator.js'), 'utf8');
  const start = src.indexOf('registerNode(nodeData)');
  assert.ok(start > 0, 'registerNode must exist');
  const body = src.slice(start, start + 6000);
  assert.ok(!/existingNode\?\.hw_id/.test(body),
    'registerNode still references the block-scoped existingNode in the node literal');
  assert.ok(/nodeData\.hw_id \|\| existing\?\.hw_id/.test(body),
    'registerNode must fall back to the function-scoped existing');
});
