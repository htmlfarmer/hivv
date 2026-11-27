// api/tests/proposal.test.js — THE PROPOSAL STATE MACHINE.
//
// These tests need NO database and NO network.
//
// What is pinned here:
//   * THE LAW: a gate opens only when every earlier gate has passed
//   * I3: the BASELINE suite decides, not the suite the change ships
//   * I4: a merge with no rollback artifact is refused
//   * I2: the author cannot approve their own proposal; the quorum must be
//        family-diverse; no single bee may hold over half of it
//   * I5: an injection finding routes the proposal to a HUMAN (it does not
//        kill it, and it does not pass silently either)
//   * the receipt chain verifies, and a tampered receipt is caught
//   * a MAYBE is not a failure — the proposal stays alive

const test = require('node:test');
const assert = require('node:assert');
const proposal = require('../lib/proposal');

test.beforeEach(() => { proposal._resetForTests(); });

const DIGEST = 'd'.repeat(64);

function make(over = {}) {
    const out = proposal.create(Object.assign({
        principal: 'author-1',
        repo: 'htmlfarmer/hivv',
        base_sha: 'abc1234',
        branch: 'ai-test',
        title: 'a change',
        patch: 'diff --git a/x b/x\n+hello',
        files_changed: ['src/app.js'],
        baseline_suite_digest: DIGEST,
    }, over));
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.proposal;
}

function cleanStudy(over = {}) {
    return Object.assign({
        hard_danger: [], secrets: [], injection: [],
        votes: [{ verdict: 'SAFE', model: 'm', family: 'qwen' }],
    }, over);
}

async function throughStudy(p) {
    const s = proposal.study(p.id, cleanStudy());
    assert.equal(s.ok, true, JSON.stringify(s.problems));
    const a = await proposal.authorize(p.id, { principal: 'author-1' });
    assert.equal(a.ok, true, 'authorize: ' + JSON.stringify(a).slice(0, 200));
    return a.proposal;
}

// ── the law: no gate skipping ──────────────────────────────────────────────

test('a proposal starts as draft', () => {
    const p = make();
    assert.equal(p.state, 'draft');
    assert.equal(p.patch_sha256.length, 64);
});

test('merge BEFORE any other gate is refused', () => {
    const p = make();
    const out = proposal.merge(p.id, { merge_sha: 'deadbee', rollback_ref: 'r1' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'gate_out_of_order');
    assert.equal(out.need, 'study');
});

test('test BEFORE study is refused', () => {
    const p = make();
    const out = proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 3, failed: 0,
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'gate_out_of_order');
    assert.equal(out.need, 'study');
});

test('approve BEFORE test is refused', () => {
    const p = make();
    const out = proposal.approve(p.id, { votes: [{ verdict: 'approve', family: 'q', bee: 'b' }] });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'gate_out_of_order');
});

test('the state only advances through the gate order', () => {
    const p = make();
    proposal.study(p.id, cleanStudy());
    assert.equal(proposal.get(p.id).state, 'studied');
});

// ── G1 · study ──────────────────────────────────────────────────────────────

test('a study with a hard-danger finding FAILS the gate', () => {
    const p = make();
    const out = proposal.study(p.id, cleanStudy({
        hard_danger: [{ file: 'x.js', label: 'destructive delete' }],
    }));
    assert.equal(out.ok, false);
    assert.equal(out.error, 'study_failed');
    assert.ok(out.problems.some(x => x.includes('hard_danger')));
});

test('a study with a secret finding FAILS the gate', () => {
    const p = make();
    const out = proposal.study(p.id, cleanStudy({ secrets: [{ id: 'github_token' }] }));
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('secret')));
});

test('a RISKY vote does NOT block the study — it demands a human', async () => {
    const p = make();
    const out = proposal.study(p.id, cleanStudy({
        votes: [{ verdict: 'RISKY', model: 'm', family: 'qwen' }],
    }));
    assert.equal(out.ok, true, 'a model opinion must not be able to kill a change');
    assert.equal(out.proposal.needs_human, true);
    await throughStudy(p);
    proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 9, failed: 0,
    });
    const ap = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
        { verdict: 'approve', family: 'llama', bee: 'b2' },
    ] });
    assert.equal(ap.ok, false, 'no human signature must not pass the approve gate');
});

test('an unreviewed study (deterministic_only) is accepted but demands a human', () => {
    const p = make();
    const out = proposal.study(p.id, {
        hard_danger: [], secrets: [], injection: [], votes: [],
        deterministic_only: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.proposal.needs_human, true);
});

test('a study with no votes and no deterministic_only flag FAILS', () => {
    const p = make();
    const out = proposal.study(p.id, {
        hard_danger: [], secrets: [], injection: [], votes: [],
    });
    assert.equal(out.ok, false);
});

test('a study with NO votes FAILS (a review is required)', () => {
    const p = make();
    const out = proposal.study(p.id, cleanStudy({ votes: [] }));
    assert.equal(out.ok, false);
});

// ── I5 · an injection finding routes to a human, it does not kill it ───────

test('an injection finding does NOT block the study but DOES demand a human', async () => {
    const p = make();
    const s = proposal.study(p.id, cleanStudy({
        injection: [{ pattern: 'instruction_override', match: 'ignore previous instructions' }],
    }));
    assert.equal(s.ok, true, 'an injection finding must not block the study');
    assert.equal(s.proposal.needs_human, true);
    await throughStudy(p);
    const t = proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 9, failed: 0,
    });
    assert.equal(t.ok, true);
    const ap = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
        { verdict: 'approve', family: 'llama', bee: 'b2' },
    ] });
    assert.equal(ap.ok, false, 'no human signature must not pass the approve gate');
    assert.ok(ap.problems.some(x => x.includes('human')));
});

// ── I3 · the BASELINE suite decides ────────────────────────────────────────

test('a test run against a DIFFERENT base commit is refused', async () => {
    const p = make();
    await throughStudy(p);
    const out = proposal.test(p.id, {
        base_sha: 'deadbee', baseline_suite_digest: DIGEST, passed: 5, failed: 0,
    });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('base commit')));
});

test('a test run with the WRONG suite digest is refused (the change may have weakened it)', async () => {
    const p = make();
    await throughStudy(p);
    const out = proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: 'e'.repeat(64), passed: 5, failed: 0,
    });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('baseline suite')));
});

test('a FAILED test is refused', async () => {
    const p = make();
    await throughStudy(p);
    const out = proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 2,
    });
    assert.equal(out.ok, false);
});

test('a test run that ran NOTHING is refused (no data is not zero)', async () => {
    const p = make();
    await throughStudy(p);
    const out = proposal.test(p.id, {
        base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 0, failed: 0,
    });
    assert.equal(out.ok, false);
});

// ── I2 · the reviewer is never the reviewed ────────────────────────────────

test('one vote does not meet the quorum', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    const out = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
    ] });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('quorum')));
});

test('one model family twice is NOT a quorum (diversity)', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    const out = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
        { verdict: 'approve', family: 'qwen', bee: 'b2' },
    ] });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('distinct model families')));
});

test('one bee holding the whole quorum is refused', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    const out = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
        { verdict: 'approve', family: 'llama', bee: 'b1' },
    ] });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('over half')));
});

test('the AUTHOR cannot approve their own proposal', async () => {
    const p = make({ principal: 'author-1' });
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    const out = proposal.approve(p.id, { votes: [
        { verdict: 'approve', family: 'qwen', bee: 'author-1' },
        { verdict: 'approve', family: 'llama', bee: 'b2' },
    ] });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('author')));
});

test('a PROTECTED path needs a human signature', async () => {
    const p = make({ files_changed: ['api/lib/policy.js'] });
    assert.equal(p.protected_hit, true);
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    const votes = [
        { verdict: 'approve', family: 'qwen', bee: 'b1' },
        { verdict: 'approve', family: 'llama', bee: 'b2' },
    ];
    const noHuman = proposal.approve(p.id, { votes });
    assert.equal(noHuman.ok, false);
    assert.ok(noHuman.problems.some(x => x.includes('protected path')));
    const withHuman = proposal.approve(p.id, { votes, human: 'ash' });
    assert.equal(withHuman.ok, true, JSON.stringify(withHuman.problems));
});

// ── I4 · the rollback never depends on the change ──────────────────────────

test('a merge with NO rollback artifact is refused', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    proposal.approve(p.id, {
        votes: [
            { verdict: 'approve', family: 'qwen', bee: 'b1' },
            { verdict: 'approve', family: 'llama', bee: 'b2' },
        ],
    });
    const out = proposal.merge(p.id, { merge_sha: 'deadbee' });
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(x => x.includes('rollback')));
});

test('a merge bound to DIFFERENT patch bytes is refused', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    proposal.approve(p.id, {
        votes: [
            { verdict: 'approve', family: 'qwen', bee: 'b1' },
            { verdict: 'approve', family: 'llama', bee: 'b2' },
        ],
    });
    const out = proposal.merge(p.id, {
        merge_sha: 'deadbee', rollback_ref: 'artifact://r1', patch_sha256: 'f'.repeat(64),
    });
    assert.equal(out.ok, false);
});

// ── the receipts and the chain ─────────────────────────────────────────────

test('the full happy path reaches merged and the chain verifies', async () => {
    const p = make();
    await throughStudy(p);
    proposal.test(p.id, { base_sha: 'abc1234', baseline_suite_digest: DIGEST, passed: 5, failed: 0 });
    proposal.approve(p.id, {
        votes: [
            { verdict: 'approve', family: 'qwen', bee: 'b1' },
            { verdict: 'approve', family: 'llama', bee: 'b2' },
        ],
    });
    const m = proposal.merge(p.id, {
        merge_sha: 'deadbee', rollback_ref: 'artifact://r1', patch_sha256: p.patch_sha256,
    });
    assert.equal(m.ok, true, JSON.stringify(m.problems));
    assert.equal(m.proposal.state, 'merged');
    const v = proposal.verifyChain(m.proposal);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.ok(m.proposal.receipts.length >= 4);
});

test('a TAMPERED receipt breaks the chain (and the signature)', async () => {
    const p = make();
    await throughStudy(p);
    const rec = proposal.get(p.id);
    assert.ok(rec.receipts.length >= 1);
    const tampered = JSON.parse(JSON.stringify(rec));
    tampered.receipts[0].statement.outcome = 'failed';
    const v = proposal.verifyChain(tampered);
    assert.equal(v.ok, false);
});

test('every receipt is signed by the hub key and carries the patch digest', async () => {
    const p = make();
    await throughStudy(p);
    const rec = proposal.get(p.id);
    for (const r of rec.receipts) {
        assert.ok(r.signature, 'a receipt must be signed');
        assert.ok(r.public_key, 'a receipt must carry its key');
        assert.equal(r.statement.kind, 'proposal.gate');
        assert.equal(r.statement.patch_sha256, p.patch_sha256);
    }
});

// ── paths ───────────────────────────────────────────────────────────────────

test('the protected list covers the parts that decide', () => {
    for (const f of ['api/lib/policy.js', 'api/lib/proposal.js', 'api/lib/identity.js',
        'api/lib/capabilities.js', 'api/lib/sandbox.js', 'api/server.js',
        'scripts/deploy.sh', 'api/migrations/035_x.sql', 'api/lib/attest.js']) {
        assert.equal(proposal.isProtected(f), true, f + ' must be protected');
    }
    assert.equal(proposal.isProtected('public_html/index.html'), false);
});

test('the high-risk list covers the machinery but is not protected', () => {
    assert.equal(proposal.isProtected('api/lib/router.js'), false);
    assert.equal(proposal.isHighRisk('api/lib/router.js'), true);
    assert.equal(proposal.isHighRisk('public_html/hivv-cli.py'), true);
});

// ── a MAYBE is not a failure ───────────────────────────────────────────────

test('the proposal survives a rejected study as a record (with a reason)', () => {
    const p = make();
    const out = proposal.study(p.id, cleanStudy({ hard_danger: [{ label: 'x' }] }));
    assert.equal(out.ok, false);
    const rec = proposal.get(p.id);
    assert.equal(rec.gates.study.status, 'failed');
    assert.ok(rec.gates.study.problems.length > 0, 'a failure must say WHY');
});

test('rejection records the reason and the name', () => {
    const p = make();
    const out = proposal.reject(p.id, { reason: 'not wanted', by: 'ash' });
    assert.equal(out.ok, true);
    const rec = proposal.get(p.id);
    assert.equal(rec.state, 'rejected');
});

test('a proposal needs CONTENT — a patch or a body, never neither', () => {
    // The funnel collects bug reports and suggestions too: those carry a
    // body and no diff. What must never be empty is the CONTENT — and the
    // repo defaults to this hive's source, because the route and the CLI
    // both default it and requiring it made every caller re-state it.
    assert.equal(proposal.create({}).ok, false, 'no patch and no body');
    assert.equal(proposal.create({ patch: '', body: '   ' }).ok, false,
        'blank in both places is still nothing');
    assert.equal(proposal.create({ patch: 'diff --git a/x b/x' }).ok, true,
        'a patch alone is a proposal');
    assert.equal(
        proposal.create({ body: 'the tools server restarts too often' }).ok,
        true, 'a body alone is a proposal — a suggestion has no diff');
    const p = proposal.create({ body: 'hello' });
    assert.equal(p.proposal.repo, 'htmlfarmer/hivv', 'repo defaults to this hive');
});
