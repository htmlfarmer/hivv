// api/tests/traffic-count.test.js — pins the SERVED-TRAFFIC accounting.
//
// THE FAILURE THIS GUARDS AGAINST
// ────────────────────────────────
// 2026-11-26: `hivv stats` printed a REQS column that was 0 for EVERY bee,
// forever, while the hive was actually serving hundreds of requests (every
// call xyzo.org makes through this hub included). Two independent causes:
//
//   1. The BEE never reported anything. The agent's heartbeat sends
//      `stats.total_requests`, computed from a state key (`local_requests`)
//      that the CLI never wrote — a structural zero.
//   2. The HUB never counted either. Almost every answer is routed DIRECTLY
//      (hub → bee's llama-server); the bee's agent is not in that path, so
//      the bee cannot see the request, and the hub did not tally it. Only
//      RELAY work (bee behind NAT) was ever counted.
//
// The fix: the hub counts what it routed (both transports), the counters
// survive a re-registration, and `GET /api/control/stats` reports them.
//
// Run with:  cd api && node --test tests/traffic-count.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// ISOLATE: the orchestrator persists to api/data/nodes.json. Point it at a
// temp file so the test never reads or writes the PRODUCTION roster.
const TMP_NODES = path.join(os.tmpdir(), `hivv-traffic-test-nodes-${process.pid}.json`);
process.env.HIVV_NODES_FILE = TMP_NODES;

const Orchestrator = require('../lib/orchestrator');

process.on('exit', () => {
    try { fs.unlinkSync(TMP_NODES); } catch (_e) { /* already gone */ }
});

function makeOrch() {
    const orch = new Orchestrator();
    orch.nodes.clear();
    return orch;
}

describe('the served-traffic counters', () => {
    test('creditNodeAnswer counts the request, the tokens and the transport', () => {
        const orch = makeOrch();
        const node = { node_id: 'ashy', name: 'ashy', stats: {} };
        orch.nodes.set('ashy', node);

        orch.creditNodeAnswer(node, { tokens: 120, transport: 'direct', model: 'gemma-4' });
        orch.creditNodeAnswer(node, { tokens: 30, transport: 'relay' });
        orch.creditNodeAnswer('ashy', { tokens: 0, transport: 'direct' });

        assert.equal(node.stats.routed_requests, 3);
        assert.equal(node.stats.routed_tokens, 150);
        assert.equal(node.stats.routed_by_transport.direct, 2);
        assert.equal(node.stats.routed_by_transport.relay, 1);
        assert.ok(node.last_served_at > 0);
    });

    test('creditNodeAnswer on an unknown bee is a no-op, not a crash', () => {
        const orch = makeOrch();
        assert.equal(orch.creditNodeAnswer('nope', { tokens: 5 }), null);
        assert.equal(orch.creditNodeAnswer(null, { tokens: 5 }), null);
    });

    test('a RE-REGISTRATION keeps the counters (the object is rebuilt)', () => {
        // THE trap this guards: registerNode() REBUILDS the node object on
        // every registration. Without carrying `stats` over, every agent
        // restart wiped the whole history and the column fell back to 0.
        const orch = makeOrch();
        orch.registerNode({
            token: 'bee1', name: 'bee1', ip: '10.0.0.9', hw_id: 'hw-bee1',
            local_models: [{ model: 'gemma-4' }], capabilities: [],
        });
        orch.creditNodeAnswer('bee1', { tokens: 42, transport: 'direct' });
        assert.equal(orch.nodes.get('bee1').stats.routed_requests, 1);

        orch.registerNode({
            token: 'bee1', name: 'bee1', ip: '10.0.0.9', hw_id: 'hw-bee1',
            local_models: [{ model: 'gemma-4' }], capabilities: [],
        });
        assert.equal(
            orch.nodes.get('bee1').stats.routed_requests, 1,
            're-registration wiped the served-traffic counters'
        );
        assert.equal(orch.nodes.get('bee1').stats.routed_tokens, 42);
    });

    test('the counters survive a gateway restart (nodes.json round-trip)', () => {
        const orch = makeOrch();
        orch.registerNode({
            token: 'bee2', name: 'bee2', ip: '10.0.0.10', hw_id: 'hw-bee2',
            local_models: [], capabilities: [],
        });
        orch.creditNodeAnswer('bee2', { tokens: 7, transport: 'relay' });
        orch._saveNodes();

        const rehydrated = makeOrch();
        // the second orchestrator reads the same file
        const Orch2 = Orchestrator;
        const fresh = new Orch2();
        fresh.nodes.clear();
        fresh._loadNodes();
        const node = fresh.nodes.get('bee2');
        assert.ok(node, 'the bee did not come back from disk');
        assert.equal(node.stats.routed_requests, 1);
        assert.equal(node.stats.routed_tokens, 7);
    });
});

describe('the router credits the RIGHT bee', () => {
    test('a target with a nodeId is credited to that node', async () => {
        const orch = makeOrch();
        const node = { node_id: 'masjid', name: 'masjid', lan_ip: '192.168.1.33', stats: {} };
        orch.nodes.set('masjid', node);

        const AIRouter = require('../lib/router');
        // NO constructor: it starts the spare-time monitor (a live interval)
        // and the orchestrator is injected AFTER construction anyway.
        const router = Object.create(AIRouter.prototype);
        router.orchestrator = orch;
        router._creditAnswer({ url: 'http://192.168.1.33:8080/v1/chat/completions', nodeId: 'masjid' },
            { tokens: 11, transport: 'direct' });

        assert.equal(node.stats.routed_requests, 1);
        assert.equal(node.stats.routed_tokens, 11);
    });

    test('the relay path credits the bee object it already holds', async () => {
        const orch = makeOrch();
        const node = { node_id: 'yalla', name: 'yalla', stats: {} };
        orch.nodes.set('yalla', node);

        const AIRouter = require('../lib/router');
        const router = Object.create(AIRouter.prototype);
        router.orchestrator = orch;
        router._creditAnswer(node, { tokens: 5, transport: 'relay' });

        assert.equal(node.stats.routed_requests, 1);
        assert.equal(node.stats.routed_by_transport.relay, 1);
    });

    test('a LOCALHOST target is credited to the bee that IS this box', async () => {
        // The hub box is usually a registered bee itself (its own
        // llama-server on :8080). The route label says "localhost", but the
        // work was done by a real bee — and that bee must get the credit.
        const orch = makeOrch();
        const node = { node_id: 'hubbox', name: 'hubbox', lan_ip: '127.0.0.1', stats: {} };
        orch.nodes.set('hubbox', node);

        const AIRouter = require('../lib/router');
        const router = Object.create(AIRouter.prototype);
        router.orchestrator = orch;
        router._creditAnswer({ url: 'http://localhost:8080/v1/chat/completions' },
            { tokens: 9, transport: 'direct' });

        assert.equal(node.stats.routed_requests, 1);
        assert.equal(node.stats.routed_tokens, 9);
    });

    test('accounting never breaks an answer (a broken target is swallowed)', async () => {
        const orch = makeOrch();
        const AIRouter = require('../lib/router');
        const router = Object.create(AIRouter.prototype);
        router.orchestrator = orch;
        assert.doesNotThrow(() => router._creditAnswer({ url: 'not a url' }, { tokens: 1 }));
        assert.doesNotThrow(() => router._creditAnswer(undefined, { tokens: 1 }));
        assert.doesNotThrow(() => router._creditAnswer(null, { tokens: 1 }));
    });
});

describe('GET /api/control/stats (live)', () => {
    let gatewayUp = false;
    before(async () => {
        try {
            const r = await fetch('http://localhost:3011/api/health');
            gatewayUp = r.ok;
        } catch (_e) { gatewayUp = false; }
    });

    test('the stats payload carries the served-traffic fields', async (t) => {
        if (!gatewayUp) return t.skip('gateway not running');
        const r = await fetch('http://localhost:3011/api/control/stats');
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.ok(Array.isArray(j.nodes));
        assert.ok(j.totals && typeof j.totals.requests === 'number');
        for (const n of j.nodes) {
            assert.equal(typeof n.requests, 'number', n.name + ' has no requests number');
            assert.equal(typeof n.tokens, 'number', n.name + ' has no tokens number');
            assert.ok('transport_split' in n);
            assert.equal(typeof n.bee_reported_requests, 'number');
        }
    });
});
