// An EMBEDDING model is not a chat candidate — hub side.
//
// THE REPORT (ashy -> a Mac, 2026-11-28): ashy's heartbeat advertises
//   llama.cpp:8090  gemma-4-E2B-it-Q4_K_M.gguf
//   ollama:11434    qwen2.5:0.5b
//   ollama:11434    nomic-embed-text:latest   <- vectors, not chat
// and the chat path walked local_models straight through it. Two things
// then went wrong for the caller:
//   * the direct loop spent a request on the embedder -> HTTP 400
//     "does not support chat", and
//   * the 400 hint ignored the body and blamed slot/context config.
//
// Worse on this hub: both ollama models share port 11434, so getAllEndpoints
// dedupes them to ONE url — and if the embedder came first it WON, taking the
// chat model's place as ashy's advertised model.
//
// This file pins the hub half: isEmbedModel, firstChatModel, and the
// endpoint builder. The CLI half lives in tests/test_bee_chat.py.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const AIRouter = require('../lib/router');

// The constructor starts a 10s spare-time monitor — a live-process concern
// these tests don't need, and a setInterval that keeps the test PROCESS alive
// forever after the last assertion. Neutralize it for this file only.
AIRouter.prototype.startSpareTimeMonitor = function () {};

function makeRouter() {
    const rt = new AIRouter();
    rt.localEndpoints = [];   // never inherit HIVV_LOCAL_ENDPOINTS from the env
    return rt;
}

function makeOrchestrator(nodes) {
    return {
        nodes: new Map(nodes.map(n => [n.node_id || n.id, n])),
    };
}

const ashy = {
    node_id: 'ashy', name: 'ashy', status: 'online',
    last_heartbeat: Date.now(),
    lan_ip: '192.168.1.3',
    local_models: [
        { provider: 'llama.cpp:8090', model: 'gemma-4-E2B-it-Q4_K_M.gguf', port: 8090 },
        { provider: 'ollama', model: 'qwen2.5:0.5b', port: 11434 },
        { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
    ],
};

describe('isEmbedModel', () => {
    it('recognises the embedder families', () => {
        for (const n of [
            'nomic-embed-text:latest', 'nomic-embed-text',
            'mxbai-embed-latest', 'bge-small-en-v1.5',
            'all-minilm-l6-v2', 'text-embedding-ada-002',
            'snowflake-arctic-embed-m',
            'sentence-transformers/all-MiniLM-L6-v2',
            'Nomic-Embed-Text:latest',
        ]) assert.strictEqual(AIRouter.isEmbedModel(n), true, n);
    });

    it('never mistakes a chat model for an embedder', () => {
        // the filter must not take a real answer away from anyone
        for (const n of [
            'gemma-4-E2B-it-Q4_K_M.gguf', 'qwen2.5:0.5b',
            'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
            'unsloth/gemma-4-E2B-it-GGUF',
            'llama-3.2-3b-instruct', 'phi-4', 'mistral:7b',
            'deepseek-r1:8b', 'google_gemma-3-4b-it-Q4_K_M.gguf',
        ]) assert.strictEqual(AIRouter.isEmbedModel(n), false, n);
    });

    it('a name it cannot identify stays eligible', () => {
        // unknown != embedder: an odd or empty name must never be dropped
        assert.strictEqual(AIRouter.isEmbedModel(null), false);
        assert.strictEqual(AIRouter.isEmbedModel(undefined), false);
        assert.strictEqual(AIRouter.isEmbedModel(''), false);
    });

    it('the CLI and the hub agree on what an embedder is', () => {
        // TWO implementations (a Python tuple, a JS regex) — without this
        // they drift, and one surface stops filtering what the other does.
        const fs = require('fs');
        const path = require('path');
        const py = fs.readFileSync(
            path.join(__dirname, '..', '..', 'public_html', 'hivv-cli.py'), 'utf8');
        const m = py.match(/_EMBED_NAME_HINTS = \(([^)]*)\)/);
        assert.ok(m, 'CLI _EMBED_NAME_HINTS not found');
        const pyHints = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
        assert.ok(pyHints.length > 0, 'parsed no hints out of the CLI');
        const jsHints = AIRouter.EMBED_MODEL_RE.source.split('|');
        assert.deepStrictEqual(
            [...pyHints].sort(), [...jsHints].sort(),
            'the CLI and the hub list different embedder families');
    });
});

describe('firstChatModel', () => {
    it('skips an embedder sitting at the head of the list', () => {
        // THE ashy FAILURE MODE: ollama lists models in pull order, and
        // nomic-embed-text was pulled first — so names[0] WAS the embedder.
        assert.strictEqual(
            AIRouter.firstChatModel([
                { model: 'nomic-embed-text:latest', port: 11434 },
                { model: 'qwen2.5:0.5b', port: 11434 },
            ]),
            'qwen2.5:0.5b');
    });

    it('takes the first CHAT model of a real bee list', () => {
        // ashy's actual heartbeat: gemma is first and is a chat model, so
        // the filter must leave that choice alone
        assert.strictEqual(
            AIRouter.firstChatModel(ashy.local_models),
            'gemma-4-E2B-it-Q4_K_M.gguf');
        // ...and must not fall through to the embedder when only it remains
        assert.strictEqual(
            AIRouter.firstChatModel(ashy.local_models.slice(1)),
            'qwen2.5:0.5b');
    });

    it('reads model (heartbeat) and name (fixtures)', () => {
        assert.strictEqual(
            AIRouter.firstChatModel([{ name: 'gemma', port: 8080 }]), 'gemma');
        assert.strictEqual(
            AIRouter.firstChatModel([{ model: 'qwen', port: 8080 }]), 'qwen');
    });

    it('falls back to local, never undefined', () => {
        assert.strictEqual(AIRouter.firstChatModel([]), 'local');
        assert.strictEqual(AIRouter.firstChatModel(null), 'local');
        assert.strictEqual(AIRouter.firstChatModel(undefined), 'local');
        assert.strictEqual(AIRouter.firstChatModel([{}]), 'local');
        // an embedder-only box gets 'local' too: an empty model field would
        // be worse, and the CLI's _real_model (which asks THAT endpoint
        // directly) is the one that names the real embedder
        assert.strictEqual(
            AIRouter.firstChatModel([{ model: 'nomic-embed-text:latest' }]),
            'local');
    });
});

describe('getAllEndpoints — embedders are never candidates', () => {
    it('drops the embedder endpoint', () => {
        const rt = makeRouter();
        rt.orchestrator = makeOrchestrator([ashy]);
        const eps = rt.getAllEndpoints();
        for (const e of eps) {
            assert.ok(!AIRouter.isEmbedModel(e.model),
                `endpoint advertises an embedder: ${e.model}`);
        }
    });

    it('the embedder must not STEAL the chat model on a shared port', () => {
        // Both ollama models are on 11434, so the builder dedupes to one
        // url. Pull order put nomic-embed-text first — without the filter
        // it won, and ashy advertised an embedder as its chat model.
        const rt = makeRouter();
        rt.orchestrator = makeOrchestrator([ashy]);
        const eps = rt.getAllEndpoints();
        const ollama = eps.find(e => e.url === 'http://192.168.1.3:11434/v1/chat/completions');
        assert.ok(ollama, 'ashy\'s ollama endpoint should still be offered');
        assert.strictEqual(ollama.model, 'qwen2.5:0.5b');
    });

    it('still offers the embedder-free llama.cpp endpoint', () => {
        const rt = makeRouter();
        rt.orchestrator = makeOrchestrator([ashy]);
        const eps = rt.getAllEndpoints();
        assert.ok(eps.some(e => e.url.includes(':8090')),
            'the llama.cpp endpoint must survive');
    });

    it('a locked model is still skipped too (both filters hold)', () => {
        const locked = {
            node_id: 'yalla', name: 'yalla', status: 'online',
            last_heartbeat: Date.now(), lan_ip: '192.168.1.7',
            local_models: [
                { provider: 'llama.cpp:8080', model: 'locked (api-key required)',
                  locked: true, port: 8080 },
                { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
                { provider: 'llama.cpp:8081', model: 'gemma-4-E2B', port: 8081 },
            ],
        };
        const rt = makeRouter();
        rt.orchestrator = makeOrchestrator([locked]);
        const eps = rt.getAllEndpoints();
        assert.strictEqual(eps.length, 1);
        assert.strictEqual(eps[0].model, 'gemma-4-E2B');
    });

    it('leaves offline and stale bees alone', () => {
        const rt = makeRouter();
        rt.orchestrator = makeOrchestrator([
            { ...ashy, node_id: 'a1', status: 'offline' },
            { ...ashy, node_id: 'a2', status: 'stale' },
        ]);
        assert.deepStrictEqual(rt.getAllEndpoints(), []);
    });
});

describe('_tryRelay — an embedder-only bee is never a relay candidate', () => {
    // The relay path had the same hole as capabilities: `some(m => !m.locked)`
    // let an embedder-only VOLUNTEER through, firstChatModel then fell back to
    // 'local', and the job came back HTTP 400 "does not support chat".
    //
    // Both cases return { ok:false }, so the observable difference is whether
    // a job was ever QUEUED for the bee — createJob is stubbed and counted.

    const volunteer = (models) => ({
        node_id: 'ashy', name: 'ashy', status: 'online', volunteer: true,
        lan_ip: '192.168.1.3', local_models: models,
    });

    async function tryRelay(node) {
        const rt = makeRouter();
        rt.orchestrator = { nodes: new Map([[node.node_id, node]]) };
        const relay = {
            calls: [],
            getConfig: () => ({ maxActivePerNode: 2 }),
            activeForNode: () => 0,
            createJob(job) { relay.calls.push(job); return { error: 'stubbed' }; },
        };
        rt.relay = relay;
        const stream = { setHeader() {}, write() {}, end() {} };
        await rt._tryRelay([{ role: 'user', content: 'hi' }], stream, {});
        return relay.calls;
    }

    it('queues NOTHING for a bee whose only model is an embedder', async () => {
        const calls = await tryRelay(volunteer([
            { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
        ]));
        assert.strictEqual(calls.length, 0,
            'an embedder-only volunteer was offered relay work');
    });

    it('still queues work for a bee with a chat model', async () => {
        // the control: the filter must not have become "no volunteers at all"
        const calls = await tryRelay(volunteer([
            { provider: 'llama.cpp:8090', model: 'gemma-4-E2B-it-Q4_K_M.gguf', port: 8090 },
            { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
        ]));
        assert.strictEqual(calls.length, 1);
    });

    it('a keyed (locked) model is still not servable', async () => {
        const calls = await tryRelay(volunteer([
            { provider: 'llama.cpp:8080', model: 'locked (api-key required)',
              locked: true, port: 8080 },
        ]));
        assert.strictEqual(calls.length, 0, 'a locked LLM leaked into relay');
    });
});

describe('deriveNodeCaps — a bee may only CLAIM what it could ANSWER', () => {
    // capability is a HARD routing gate, so this is the gate that decides
    // whether chat may be sent to a bee at all. Before this, any model
    // granted reasoning/coding/translation — an embedder-only bee claimed
    // them, was selected, and answered HTTP 400.
    const { deriveNodeCaps } = require('../lib/capabilities');

    const capsOf = models => deriveNodeCaps({ status: 'online', local_models: models });

    it('an embedder-only bee claims NO answer capability', () => {
        const caps = capsOf([{ provider: 'ollama', model: 'nomic-embed-text:latest',
                              port: 11434 }]);
        for (const c of ['reasoning', 'coding', 'translation', 'vision']) {
            assert.ok(!caps.includes(c),
                `an embedder-only bee claimed ${c}`);
        }
    });

    it('a bee with a chat model keeps every capability it had', () => {
        // the filter must not take anything away from a healthy bee
        const caps = capsOf([
            { provider: 'llama.cpp:8090', model: 'gemma-4-E2B-it-Q4_K_M.gguf', port: 8090 },
            { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
        ]);
        for (const c of ['reasoning', 'coding', 'translation']) {
            assert.ok(caps.includes(c), `lost ${c}`);
        }
    });

    it('a chat model listed AFTER the embedder still counts', () => {
        const caps = capsOf([
            { provider: 'ollama', model: 'nomic-embed-text:latest', port: 11434 },
            { provider: 'ollama', model: 'qwen2.5:0.5b', port: 11434 },
        ]);
        assert.ok(caps.includes('reasoning'));
    });

    it('vision comes from a VISION model, not from an embedder', () => {
        // VISION_RE contains 'gemini', so gemini-embed-* would otherwise
        // claim vision from a model that produces vectors
        assert.ok(!capsOf([{ model: 'gemini-embed-001', provider: 'ollama' }])
            .includes('vision'));
        assert.ok(capsOf([{ model: 'llava:7b', provider: 'ollama' }])
            .includes('vision'));
    });

    it('tools and volunteering are NOT gated on having a chat model', () => {
        // a bee may share tools (search, fetch) without serving chat — the
        // filter must narrow the MODEL claim only, never the whole profile
        const caps = deriveNodeCaps({
            status: 'online',
            local_models: [{ model: 'nomic-embed-text:latest' }],
            tools: ['search', 'fetch'],
            volunteer: true,
        });
        assert.ok(caps.includes('web.search'), caps.join(','));
        assert.ok(caps.includes('web.fetch'), caps.join(','));
        assert.ok(caps.includes('compute.donated'), caps.join(','));
        assert.ok(!caps.includes('reasoning'));
    });

    it('a bee with no models at all is unchanged', () => {
        assert.deepStrictEqual(deriveNodeCaps({ status: 'online' }).sort(),
                               deriveNodeCaps({ status: 'online', local_models: [] }).sort());
        assert.ok(!deriveNodeCaps({ status: 'online' }).includes('reasoning'));
    });

    it('tolerates a node with no model list', () => {
        // (a null NODE is unreachable: capability-routes 404s first and
        // hiveSummary walks Map values — so only the shape we do meet here)
        assert.ok(Array.isArray(deriveNodeCaps({})));
        assert.ok(Array.isArray(deriveNodeCaps({ local_models: [] })));
        assert.ok(Array.isArray(deriveNodeCaps({ local_models: [null] })));
    });
});

describe('one predicate, not two', () => {
    it('the router delegates to model-kind instead of keeping its own copy', () => {
        const modelKind = require('../lib/model-kind');
        // same object — not a second regex that can drift
        assert.strictEqual(AIRouter.EMBED_MODEL_RE, modelKind.EMBED_MODEL_RE);
        for (const n of ['nomic-embed-text:latest', 'qwen2.5:0.5b', '', null]) {
            assert.strictEqual(AIRouter.isEmbedModel(n),
                               modelKind.isEmbedModel(n), String(n));
        }
    });

    it('capabilities uses the same predicate as the router', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'lib', 'capabilities.js'), 'utf8');
        assert.ok(src.includes("require('./model-kind')"),
            'capabilities.js has its own copy of the family list again');
        assert.ok(!/EMBED_MODEL_RE\s*=\s*\//.test(src),
            'capabilities.js redeclared the regex');
    });
});

describe('wiring — the guards are actually in the source', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');

    it('the endpoint builder checks every model it walks', () => {
        // match the DEFINITION, not the first call site
        const body = src.split('getAllEndpoints() {')[1].split('\n    }')[0];
        assert.ok(body.includes('isEmbedModel'),
            'getAllEndpoints no longer filters embedders');
    });

    it('the relay job names a chat model, not local_models[0].name', () => {
        // that field never existed on a heartbeat (it is `model`), so every
        // relay job silently said 'local' — which ollama 404s.
        assert.ok(!src.includes('local_models[0]?.name'),
            'relay still reads the wrong key');
        assert.ok(src.includes('firstChatModel(node.local_models)'),
            'relay must pick through firstChatModel');
    });
});
