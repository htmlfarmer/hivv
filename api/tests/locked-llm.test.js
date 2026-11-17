const { describe, it } = require('node:test');
const assert = require('node:assert');

const { plan, lockedModelsOf, describeLocked, TITLE_MARKER } = require('../lib/locked-llm');

const locked8080 = {
    provider: 'llama.cpp:8080',
    model: 'locked (api-key required)',
    loaded: false,
    locked: true,
    port: 8080,
};

describe('lockedModelsOf', () => {
    it('keeps only locked entries of an online node', () => {
        const node = { status: 'online', local_models: [
            locked8080,
            { provider: 'llama.cpp:8081', model: 'real', port: 8081 },
        ] };
        assert.deepStrictEqual(lockedModelsOf(node), [locked8080]);
    });

    it('ignores offline/stale nodes and junk', () => {
        assert.deepStrictEqual(lockedModelsOf({ status: 'stale', local_models: [locked8080] }), []);
        assert.deepStrictEqual(lockedModelsOf({ status: 'online' }), []);
        assert.deepStrictEqual(lockedModelsOf(null), []);
        assert.deepStrictEqual(lockedModelsOf('nope'), []);
    });
});

describe('plan — creates', () => {
    it('creates one incident for a bee reporting a keyed server', () => {
        const nodes = [{ node_id: 'yalla', name: 'yalla', status: 'online',
                         local_models: [locked8080] }];
        const { create, resolve } = plan(nodes, []);
        assert.strictEqual(create.length, 1);
        assert.strictEqual(create[0].node_id, 'yalla');
        assert.ok(create[0].title.startsWith(TITLE_MARKER));
        assert.ok(create[0].title.includes('yalla'));
        assert.strictEqual(resolve.length, 0);
        assert.strictEqual(create[0].evidence.models[0].port, 8080);
    });

    it('does not duplicate an already-active locked incident', () => {
        const nodes = [{ node_id: 'yalla', status: 'online', local_models: [locked8080] }];
        const active = [{ id: 'inc-1', node_id: 'yalla', title: `${TITLE_MARKER} on yalla: api-key required` }];
        const { create, resolve } = plan(nodes, active);
        assert.deepStrictEqual(create, []);
        assert.deepStrictEqual(resolve, []); // still locked → keep it open
    });

    it('ignores nodes without locked models', () => {
        const nodes = [{ node_id: 'masjid', status: 'online',
                         local_models: [{ provider: 'llama.cpp:8080', model: 'gemma' }] }];
        assert.deepStrictEqual(plan(nodes, []).create, []);
    });

    it('falls back to id when node_id is absent', () => {
        const nodes = [{ id: 'ashy', status: 'online', local_models: [locked8080] }];
        const { create } = plan(nodes, []);
        assert.strictEqual(create[0].node_id, 'ashy');
    });

    it('tolerates junk input', () => {
        assert.deepStrictEqual(plan(null, []).create, []);
        assert.deepStrictEqual(plan([null, 7, undefined], []).create, []);
        assert.deepStrictEqual(plan([], null).resolve, []);
    });
});

describe('plan — resolves', () => {
    it('resolves when the bee no longer reports locked models', () => {
        const nodes = [{ node_id: 'yalla', status: 'online',
                         local_models: [{ provider: 'llama.cpp:8080', model: 'gemma' }] }];
        const active = [{ id: 'inc-9', node_id: 'yalla', title: `${TITLE_MARKER} on yalla: api-key required` }];
        const { create, resolve } = plan(nodes, active);
        assert.deepStrictEqual(create, []);
        assert.deepStrictEqual(resolve, ['inc-9']);
    });

    it('resolves when the node disappears', () => {
        const active = [{ id: 'inc-9', node_id: 'yalla', title: `${TITLE_MARKER} on yalla: …` }];
        assert.deepStrictEqual(plan([], active).resolve, ['inc-9']);
    });

    it('never touches non-marker incidents of the same node', () => {
        const active = [{ id: 'inc-2', node_id: 'yalla', title: 'Node yalla is offline (5m)' }];
        const { resolve } = plan([], active);
        assert.deepStrictEqual(resolve, []); // offline incidents are managed elsewhere
    });
});

describe('describeLocked', () => {
    it('carries the on-box commands and the remote restart', () => {
        const text = describeLocked({ name: 'yalla' }, [{ port: 8080 }, { port: 8081 }]);
        assert.ok(text.includes(':8080, :8081'));
        assert.ok(text.includes('ps -ef | grep llama-server'));
        assert.ok(text.includes('ps -p <ppid> -o cmd='));
        assert.ok(text.includes('systemctl cat llama.service'));
        assert.ok(text.includes('hivv repair yalla --op service_restart --unit llama.service'));
        assert.ok(text.includes('FROM THE HUB HOST')); // bees get control auth required
        assert.ok(text.includes('hivv never sets llama API keys'));
        assert.ok(text.includes('--api-key-file'));
    });
});
