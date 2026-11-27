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
const { _resetKeyWindows } = require('../lib/key-donation');

// selectKey is a pure-ish class method: it only reads this.keysByProvider and
// this.loadBalancingStrategy, so the prototype can be exercised without
// constructing the whole router (no DB, no timers, no network).
const selectKey = AIRouter.prototype.selectKey;

function keyPair({ userId = null, isShared = false, model = '*', available = true, priority = 1,
                   principal = null, id = null,
                   maxRequestsPerHour = null, maxTokensPerDay = null } = {}) {
    return {
        key: {
            id,
            userId,
            isShared,
            model,
            priority,
            principal,
            maxRequestsPerHour,
            maxTokensPerDay,
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
    return (preferredModel = null, userId = null, principals = null) =>
        selectKey.call(ctx, 7, preferredModel, userId, principals);
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

// ── K2: verified-scope bindings (principal) ───────────────────────────────

test('a key bound to node:ashy answers only to that proven node scope', () => {
    const k = keyPair({ principal: 'node:ashy' });
    const sel = picker([k]);
    assert.strictEqual(sel(null, null, ['node:ashy']), k, 'the bee itself may spend it');
    assert.strictEqual(sel(null, null, ['node:yalla']), null, 'another bee may not');
    assert.strictEqual(sel(null, null, null), null, 'nobody without a scope may');
    assert.strictEqual(sel(null, 9, null), null, 'a bare userId never crosses a scope binding');
});

test('a visitor-bound key keeps working after login (multi-scope)', () => {
    // Bound while logged out (signed cookie), caller later presents BOTH
    // their session and the still-valid cookie → no stranded key.
    const k = keyPair({ principal: 'visitor:v_deadbeef' });
    const sel = picker([k]);
    assert.strictEqual(
        sel(null, 5, ['user:5', 'visitor:v_deadbeef']), k,
        'any matching scope unlocks an owned key');
    assert.strictEqual(sel(null, 5, ['user:5']), null, 'the session alone is a different identity');
});

test('the spoofable x-visitor-id is NOT a scope: no scope, no key', () => {
    // keyScopesOf() never produces a scope from the raw header — a caller
    // that presents nothing verified gets nothing, even claiming any id.
    const k = keyPair({ principal: 'visitor:v_victim' });
    assert.strictEqual(picker([k])(null, null, []), null);
    assert.strictEqual(picker([k])(null, null, undefined), null);
});

// ── K2: spend caps enforced at selection (key-donation.js windows) ───────

test('an over-budget key steps aside — even for its own owner', () => {
    _resetKeyWindows();
    const k = keyPair({ userId: 1, id: 42, maxRequestsPerHour: 2 });
    const sel = picker([k]);
    assert.strictEqual(sel(null, 1), k, 'slot 1');
    assert.strictEqual(sel(null, 1), k, 'slot 2');
    assert.strictEqual(sel(null, 1), null, 'hourly budget spent → the key bows out');
    _resetKeyWindows();
});

test('caps bind DONATED keys too — the hive cannot blow past them', () => {
    _resetKeyWindows();
    const k = keyPair({ id: 7, maxRequestsPerHour: 1 });
    const sel = picker([k]);
    assert.strictEqual(sel(null, 1), k);
    assert.strictEqual(sel(null, 2), null, 'second caller finds the cap spent');
    _resetKeyWindows();
});

test('keys with no caps (personal / legacy rows) are never budget-blocked', () => {
    _resetKeyWindows();
    const k = keyPair({ userId: 1, id: 9 });   // maxRequestsPerHour null
    const sel = picker([k]);
    for (let i = 0; i < 50; i++) {
        assert.strictEqual(sel(null, 1), k);
    }
    _resetKeyWindows();
});
