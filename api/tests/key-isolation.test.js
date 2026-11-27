// K1 — key isolation in selectKey (HIVV_PERSONAL_MODELS_PLAN.md §5 P1).
//
// The old fallback (`candidates = keys.filter(k => k.key.isAvailable())`) dropped
// BOTH the ownership and model filters: any private key (userId set, is_shared=false)
// became the catch-all for other users — and for anonymous visitors — whenever their
// own filtered set came up empty (no matching model, or nothing owned by them).
//
// Contract pinned here:
//   - the fallback may relax the MODEL pin (an owner whose key is pinned to model X
//     can still spend it on a request for model Y),
//   - the fallback may NEVER relax ownership (a stranger spends nothing of mine),
//   - donated keys (user_id NULL) and is_shared=true keys remain hive-wide by design.
const { test } = require('node:test');
const assert = require('node:assert');
const AIRouter = require('../lib/router');

// selectKey is a pure-ish class method: it only reads this.keysByProvider and
// this.loadBalancingStrategy, so the prototype can be exercised without
// constructing the whole router (no DB, no timers, no network).
const selectKey = AIRouter.prototype.selectKey;

function keyPair({ userId = null, isShared = false, model = '*', available = true, priority = 1 } = {}) {
    return {
        key: {
            userId,
            isShared,
            model,
            priority,
            weight: 1,
            lastUsedAt: null,
            isAvailable: () => available,
        },
    };
}

function picker(keys) {
    const ctx = {
        keysByProvider: new Map([[7, keys]]),
        loadBalancingStrategy: 'priority',
    };
    return (preferredModel = null, userId = null) => selectKey.call(ctx, 7, preferredModel, userId);
}

test('a private key is never selected for ANOTHER user, even as the only key', () => {
    const sel = picker([keyPair({ userId: 1, isShared: false })])(null, 2);
    assert.strictEqual(sel, null, 'stranger must not receive user 1\'s private key');
});

test('a private key is never selected for an ANONYMOUS visitor', () => {
    const sel = picker([keyPair({ userId: 1, isShared: false })])(null, null);
    assert.strictEqual(sel, null, 'anonymous traffic must not spend a private key');
});

test('the owner still gets their own private key', () => {
    const k = keyPair({ userId: 1, isShared: false });
    assert.strictEqual(picker([k])(null, 1), k);
});

test('a model pin mismatch on MY key still falls back to my key (fallback relaxes model only)', () => {
    const k = keyPair({ userId: 1, isShared: false, model: 'gpt-4o' });
    // primary filter rejects on model → fallback must keep ownership and return it
    assert.strictEqual(picker([k])('some-other-model', 1), k);
});

test('the model fallback does NOT leak: stranger + model mismatch → null', () => {
    const k = keyPair({ userId: 1, isShared: false, model: 'gpt-4o' });
    assert.strictEqual(picker([k])('some-other-model', 2), null);
    assert.strictEqual(picker([k])('some-other-model', null), null);
});

test('donated keys (user_id NULL) stay available to everyone — by design', () => {
    const k = keyPair({ userId: null });
    const sel = picker([k]);
    assert.strictEqual(sel(null, 1), k);
    assert.strictEqual(sel(null, 2), k);
    assert.strictEqual(sel(null, null), k);
});

test('is_shared=true keys stay available to everyone — by design', () => {
    const k = keyPair({ userId: 1, isShared: true });
    const sel = picker([k]);
    assert.strictEqual(sel(null, 2), k);
    assert.strictEqual(sel(null, null), k);
});

test('mixed pool: caller receives the donated key, never a stranger\'s private key', () => {
    const mine = keyPair({ userId: 2, isShared: false });
    const stranger = keyPair({ userId: 1, isShared: false });
    const donated = keyPair({ userId: null });
    const sel = picker([stranger, mine, donated])(null, 2);
    assert.ok(sel === mine || sel === donated, 'own or donated key only');
    assert.notStrictEqual(sel, stranger);
});

test('unavailable keys are skipped even for their owner', () => {
    const k = keyPair({ userId: 1, available: false });
    assert.strictEqual(picker([k])(null, 1), null);
});

test('nobody gets anything when every key is foreign', () => {
    const sel = picker([
        keyPair({ userId: 1 }),
        keyPair({ userId: 3, isShared: false }),
    ])(null, 2);
    assert.strictEqual(sel, null);
});
