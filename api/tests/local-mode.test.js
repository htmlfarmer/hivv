// api/tests/local-mode.test.js — local-first mode + partner surface contracts.
//
// These tests are pure (no database, no network) so they run anywhere.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Fresh module registry per test so env changes are honored.
function freshLocalMode(env = {}) {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('HIVV_')) delete process.env[k];
    }
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../lib/local-mode')];
    const mod = require('../lib/local-mode');
    return { mod, restore: () => { for (const k of Object.keys(process.env)) if (k.startsWith('HIVV_')) delete process.env[k]; Object.assign(process.env, saved); } };
}

test('mode defaults to auto and rejects nonsense', () => {
    const { mod, restore } = freshLocalMode({});
    assert.equal(mod.mode(), 'auto');
    restore();

    const b = freshLocalMode({ HIVV_MODE: 'bogus' });
    assert.equal(b.mod.mode(), 'auto');
    b.restore();
});

test('local mode never allows contacting the hive', () => {
    const { mod, restore } = freshLocalMode({ HIVV_MODE: 'local', HIVV_HIVE_JOIN: '1' });
    assert.equal(mod.isLocalOnly(), true);
    assert.equal(mod.isHiveAllowed(), false);
    restore();
});

test('hive join requires BOTH a non-local mode and the opt-in flag', () => {
    const a = freshLocalMode({ HIVV_MODE: 'auto' });
    assert.equal(a.mod.isHiveAllowed(), false, 'must not phone home by default');
    a.restore();

    const b = freshLocalMode({ HIVV_MODE: 'hive', HIVV_HIVE_JOIN: '1' });
    assert.equal(b.mod.isHiveAllowed(), true);
    b.restore();

    const c = freshLocalMode({ HIVV_MODE: 'hive' });
    assert.equal(c.mod.isHiveAllowed(), false);
    c.restore();
});

test('hive url is configurable and normalized', () => {
    const { mod, restore } = freshLocalMode({ HIVV_HIVE_URL: 'https://example.test/' });
    assert.equal(mod.hiveUrl(), 'https://example.test');
    restore();
});

test('describe() advertises the local-first promise', () => {
    const { mod, restore } = freshLocalMode({});
    const d = mod.describe({ dbConnected: false, localModels: [{ provider: 'llamacpp', model: 'gemma', port: 8090 }] });
    assert.equal(d.name, 'HIVV');
    assert.equal(d.local_first, true);
    assert.equal(d.offline_capable, true);
    assert.equal(d.database, 'degraded');
    assert.equal(d.local_models.length, 1);
    assert.ok(d.endpoints.manifest);
    assert.ok(d.endpoints.fast_scan);
    assert.ok(d.capabilities.includes('openai-compatible-chat'));
    restore();
});

test('the partner manifest never contains key material', () => {
    const { mod, restore } = freshLocalMode({});
    const d = mod.describe({});
    const text = JSON.stringify(d).toLowerCase();
    for (const forbidden of ['private_key', 'api_key', 'secret', 'password']) {
        assert.ok(!text.includes(forbidden), `manifest leaked: ${forbidden}`);
    }
    restore();
});

test('local provider key files are written 0600 and read back', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-keys-'));
    const { mod, restore } = freshLocalMode({ HIVV_DATA_DIR: dir });
    const file = mod.writeLocalKey('openai', {
        api_key: 'sk-test-not-a-real-key',
        api_endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
    });
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'key file must be 0600');

    const keys = mod.readLocalKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].api_key, 'sk-test-not-a-real-key');
    assert.equal(keys[0].model, 'gpt-4o-mini');
    assert.equal(keys[0].source, 'local-file');
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
});

test('malformed key files are skipped, not fatal', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-keys-'));
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'keys', 'nokey.json'), '{"name":"x"}');
    const { mod, restore } = freshLocalMode({ HIVV_DATA_DIR: dir });
    assert.deepStrictEqual(mod.readLocalKeys(), []);
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
});

test('instance id is stable across calls', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-inst-'));
    const { mod, restore } = freshLocalMode({ HIVV_DATA_DIR: dir });
    const a = mod.instanceId();
    const b = mod.instanceId();
    assert.equal(a, b);
    assert.match(a, /^local_[0-9a-f]{16}$/);
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
});
