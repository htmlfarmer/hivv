// api/tests/quarantine-recovery.test.js
//
// THE FAILURE THIS GUARDS AGAINST
// ────────────────────────────────
// 2026-11-22 (yalla): yalla re-registered every ~100 seconds for HOURS — a
// crash-loop — and the hub quarantined it at 19:36 ("5 re-registrations
// within 10 minutes"). Then:
//
//   1. The quarantine FROZE its heartbeat (updateHeartbeat returned early).
//   2. `flap_events` was written ONLY in registerNode and NEVER cleared —
//      the heartbeat was the only thing that could clear it.
//   3. So: quarantine froze the heartbeat → the heartbeat that would have
//      cleared the counter never arrived → the counter held the quarantine.
//      A DEADLOCK with no exit except a human.
//   4. Worse, registerNode set `last_heartbeat: now`, so a crash-looping bee
//      looked PERMANENTLY ALIVE (fresh heartbeat age) while dying — the
//      roster said "online" right up to the quarantine, and the only
//      visible symptom was the quarantine itself.
//
// The fixes:
//   * a re-registration is NOT a heartbeat — keep the old age (the truth);
//   * a healthy heartbeat clears the flap counter;
//   * a quarantined bee that heartbeats SUSTAINABLY is auto-released
//     (2 consecutive heartbeats) — the detector re-arms;
//   * an OPERATOR quarantine is NEVER auto-lifted — only a human releases it.

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ISOLATE: the orchestrator persists to api/data/nodes.json. A test that
// loads it would read PRODUCTION nodes and (worse) write test bees into
// the live roster — the gateway would then register 'y-y' and 'newbee' as
// real members of the hive. Point it at a temp file for the whole run.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP_NODES = path.join(os.tmpdir(), `hivv-quarantine-test-nodes-${process.pid}.json`);
process.env.HIVV_NODES_FILE = TMP_NODES;

const Orchestrator = require('../lib/orchestrator');

process.on('exit', () => {
    try { fs.unlinkSync(TMP_NODES); } catch (_e) { /* already gone */ }
});

function bee(overrides = {}) {
    return Object.assign({
        node_id: 'y', name: 'y', status: 'quarantined',
        last_heartbeat: Date.now() - 99999,
        flap_events: [Date.now() - 1000, Date.now() - 900, Date.now() - 800,
                      Date.now() - 700, Date.now() - 600],
        quarantined: { by: 'auto-flap', reason: 'crash-loop: 5 re-registrations within 10 minutes',
                       since: Date.now(), count: 5 },
        recovery_hb: 0,
        capabilities: [], cpu_model: '', total_cpu_percent: 0,
        total_mem_percent: 0, local_models: [], tools: [],
    }, overrides);
}

describe('quarantine recovery', () => {
    it('lifts an auto-flap quarantine after SUSTAINED healthy heartbeats', () => {
        const o = new Orchestrator();
        o.nodes.set('y', bee());

        // ONE heartbeat is not proof of recovery — a bee mid-crash-loop
        // heartbeats once and dies again.
        let n = o.updateHeartbeat('y', { version: '1' }, {});
        assert.ok(n.quarantined, 'one heartbeat must NOT lift the quarantine');
        assert.strictEqual(n.flap_events.length, 5, 'the accusation must stand until recovery is proven');

        // The second consecutive heartbeat proves it is stable.
        n = o.updateHeartbeat('y', { version: '1' }, {});
        assert.strictEqual(n.quarantined, null, 'a recovered bee must be released');
        assert.strictEqual(n.status, 'online');
        assert.deepStrictEqual(n.flap_events, [], 'the detector must re-arm (counter cleared)');
    });

    it('never auto-lifts an OPERATOR quarantine', () => {
        const o = new Orchestrator();
        o.nodes.set('y', bee({ quarantined: { by: 'operator', reason: 'operator quarantine',
                                                since: Date.now(), count: 5 } }));
        let n = o.updateHeartbeat('y', { version: '1' }, {});
        assert.ok(n.quarantined, 'one heartbeat must not release an operator quarantine');
        n = o.updateHeartbeat('y', { version: '1' }, {});
        n = o.updateHeartbeat('y', { version: '1' }, {});
        assert.ok(n.quarantined, 'an operator quarantine is human-only');
        assert.strictEqual(n.status, 'quarantined');
    });

    it('a re-registration is NOT a heartbeat (the crash-loop stays visible)', () => {
        const o = new Orchestrator();
        const old = Date.now() - 600000;      // 10 minutes stale
        o.nodes.set('y', bee({
            status: 'online', quarantined: null, flap_events: [],
            last_heartbeat: old,
        }));
        const n = o.registerNode({
            id: 'y', token: 'y', name: 'y', hw_id: 'hw-1', version: '2',
        });
        assert.strictEqual(n.last_heartbeat, old,
            'a re-registration must NOT fake a fresh heartbeat — the old age is the truth');
    });

    it('a re-registration breaks the recovery streak (the agent restarted)', () => {
        const o = new Orchestrator();
        o.nodes.set('y', bee({ quarantined: null, status: 'online', flap_events: [Date.now()] }));
        o.updateHeartbeat('y', { version: '1' }, {});       // recovery_hb = 1
        const n = o.registerNode({ id: 'y', token: 'y', name: 'y', hw_id: 'hw-1', version: '2' });
        assert.strictEqual(n.recovery_hb, 0,
            'a restart must reset the streak — it counts CONSECUTIVE heartbeats');
    });

    it('a brand-new node starts with a fresh heartbeat', () => {
        const o = new Orchestrator();
        const n = o.registerNode({ id: 'newbee', token: 'newbee', name: 'newbee', hw_id: 'hw-2' });
        assert.ok(Date.now() - n.last_heartbeat < 5000,
            'a node that just joined has just arrived');
    });
});
