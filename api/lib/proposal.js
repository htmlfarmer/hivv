'use strict';

// api/lib/proposal.js — THE PROPOSAL STATE MACHINE.
//
// WHY THIS FILE EXISTS
// ─────────────────────
// HIVV can already write code (routes/coding-routes.js dispatches to coder
// bees) and already has a request system (lib/policy.js gates every action,
// mints grants, and keeps a hash-chained audit). What it did NOT have was the
// thing that makes a self-modifying project SAFE:
//
//     a change to the source, travelling from "a diff someone made" to
//     "a merge that landed", with the evidence attached to every step.
//
// So this module introduces ONE unit of work — the PROPOSAL — and ONE law:
//
//     A GATE MAY BE MARKED 'passed' ONLY WHEN EVERY EARLIER GATE IS 'passed'.
//
// There is no skip, no force, no override. A proposal that tries to merge
// without a green test run is refused BY THE MACHINE, not by a reviewer
// remembering to check. That is the difference between "we review changes"
// and "we can prove what we reviewed".
//
// THE GATES
// ─────────
//   study     → what does this change DO?    (deterministic scan + votes)
//   authorize → may it happen at all?        (lib/policy.js — source.modify)
//   test      → does it work?                (baseline suite is authoritative)
//   approve   → do enough parties say yes?   (quorum + diversity + human)
//   merge     → land it                      (signed + rollback artifact)
//
// THE FIVE INVARIANTS (see HIVV_SELF_MODIFICATION_PLAN.md §1)
// ───────────────────────────────────────────────────────────────
//   I1 no change lands without evidence — every receipt binds patch_sha256
//   I2 the reviewer is never the reviewed — the author cannot approve; a
//      protected path needs a human
//   I3 the verifier is not the verified — the BASELINE suite (from base_sha)
//      is authoritative, never the suite the change ships
//   I4 the rollback never depends on the change — a merge needs a rollback
//      artifact that lives outside the changed tree
//   I5 diffs are untrusted input — the study evidence is checked against
//      fixed findings, and a patch is data, never an instruction
//
// HOUSE LAWS
// ──────────
//   * LOCAL-FIRST — no database is a valid configuration.
//   * FAIL CLOSED — a gate that cannot decide must NOT approve.
//   * HONEST — a pending human approval is NOT a failure (the proposal stays
//     alive, like task-queue's AUTH_REQUIRED).
//   * NO SILENT LOSS — every terminal transition records WHY.

const crypto = require('crypto');
const path = require('path');

const identity = require('./identity');
const attest = require('./attest');
const policy = require('./policy');

// ── configuration ───────────────────────────────────────────────────────────

const CFG = {
    maxProposals: 2000,        // bounded memory
    defaultTtlMs: 7 * 24 * 60 * 60 * 1000,   // a proposal waits at most a week
    maxTtlMs: 30 * 24 * 60 * 60 * 1000,
    maxPatchChars: 400 * 1024,
    maxFiles: 2000,
    minQuorum: 2,              // G4 — how many approvals
    minFamilies: 2,            // G4 — how many DISTINCT model families
    janitorMs: 60 * 1000,
};

// The gate order IS the law. Index order is the order.
const GATE_ORDER = ['study', 'authorize', 'test', 'approve', 'merge'];
const GATE_STATE = {
    study: 'studied', authorize: 'authorized', test: 'tested',
    approve: 'approved', merge: 'merged',
};
const STATES = ['draft', 'studied', 'authorized', 'tested', 'approved',
    'merged', 'deployed', 'rejected', 'expired', 'failed'];

// PROTECTED PATHS — the parts that decide. The hive may not rewrite them
// alone; a human must sign (invariant I2). These are the files whose
// behaviour decides whether OTHER changes are allowed, so a change to them
// must not be approved by the machinery it modifies.
// THE GUARDRAIL (non-negotiable): these files DECIDE whether nodes are
// trusted. One compromised bee must never rewrite the thing that decides
// whether bees are trusted — so a change here needs a HUMAN signature
// regardless of how many models voted yes (invariant I2, CONTRIBUTING #2).
//   policy.js      — the verdict engine
//   attest.js      — the signature contract (and blnq's byte-identical twin)
//   node-auth.js   — the bee<->hub shared secret
//   fast-scan.js   — the deterministic screen every other gate leans on
//   .keys/         — the key material itself
const PROTECTED_PATHS = [
    'api/lib/policy.js',
    'api/lib/proposal.js',
    'api/lib/proposal-funnel.js',
    'api/lib/identity.js',
    'api/lib/capabilities.js',
    'api/lib/sandbox.js',
    'api/lib/attest.js',
    'api/lib/attestation-contract.js',
    'api/lib/node-auth.js',
    'api/lib/fast-scan.js',
    'api/lib/github-relay.js',
    'api/server.js',
    'scripts/deploy.sh',
];
const PROTECTED_PREFIXES = ['api/migrations/', '.keys/', 'api/.keys/'];
const PROTECTED_PATTERNS = [/^api\/lib\/attest.*\.js$/];

// HIGH-RISK — not protected, but they carry the machinery. A human or a
// raised quorum is expected.
const HIGH_RISK_PREFIXES = ['api/lib/', 'api/routes/', 'scripts/', '.github/'];
const HIGH_RISK_FILES = ['public_html/hivv-cli.py', 'api/server.js', 'scripts/deploy.sh'];

// ── the store ───────────────────────────────────────────────────────────────

const proposals = new Map();    // id -> proposal
let pool = null;
let janitor = null;

function _id() { return 'prop_' + crypto.randomBytes(10).toString('hex'); }
function _now() { return Date.now(); }

function _clampInt(v, min, max, dflt) {
    const x = parseInt(v, 10);
    if (!Number.isFinite(x)) return dflt;
    return Math.min(Math.max(x, min), max);
}

function _sha256(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ── path classification ─────────────────────────────────────────────────────

function _norm(p) {
    return String(p || '').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isProtected(file) {
    const p = _norm(file);
    if (!p) return false;
    if (PROTECTED_PATHS.includes(p)) return true;
    for (const pre of PROTECTED_PREFIXES) if (p.startsWith(pre)) return true;
    for (const re of PROTECTED_PATTERNS) if (re.test(p)) return true;
    return false;
}

function isHighRisk(file) {
    const p = _norm(file);
    if (!p) return false;
    if (HIGH_RISK_FILES.includes(p)) return true;
    for (const pre of HIGH_RISK_PREFIXES) if (p.startsWith(pre)) return true;
    return false;
}

function classifyPaths(files) {
    const protectedPaths = [];
    const highRiskPaths = [];
    for (const f of files || []) {
        const p = _norm(f);
        if (isProtected(p)) protectedPaths.push(p);
        else if (isHighRisk(p)) highRiskPaths.push(p);
    }
    return {
        protected_hit: protectedPaths.length > 0,
        protected_paths: protectedPaths,
        high_risk: highRiskPaths.length > 0,
        high_risk_paths: highRiskPaths,
    };
}

// ── the gate order law ──────────────────────────────────────────────────────

// The one law: a gate opens only when every earlier gate has passed.
function _orderCheck(p, gate) {
    const idx = GATE_ORDER.indexOf(gate);
    if (idx < 0) return { ok: false, error: 'unknown_gate', gate };
    for (let i = 0; i < idx; i++) {
        const g = GATE_ORDER[i];
        const st = p.gates[g].status;
        if (st !== 'passed') {
            return { ok: false, error: 'gate_out_of_order', gate, need: g, have: st };
        }
    }
    return { ok: true };
}

// ── evidence validation (the machine CHECKS; it does not trust) ────────────

// G1 · STUDY — the deterministic findings must be EMPTY, and no reviewer may
// have voted RISKY. A study with a finding in it is not a passed study.
function _validateStudy(e) {
    const problems = [];
    if (!e || typeof e !== 'object') return { ok: false, problems: ['evidence required'] };
    // hard_danger and secrets BLOCK — they are deterministic and
    // high-confidence. injection does NOT block: the same phrases appear in
    // this project's own documentation about injection, so a hard block would
    // make the project unmergeable. Instead it forces a HUMAN to look (the
    // approve gate) — which is the honest answer to a low-confidence signal.
    for (const key of ['hard_danger', 'secrets']) {
        const v = e[key];
        if (!Array.isArray(v)) { problems.push(key + ' must be an array'); continue; }
        if (v.length) problems.push(key + ': ' + v.length + ' finding(s)');
    }
    if (!Array.isArray(e.injection)) problems.push('injection must be an array');
    // A RISKY vote does NOT block. The review is a MODEL's opinion, and the
    // small local models are harsh — one of them called a two-line function
    // an undocumented, potentially unused function and voted RISKY, which
    // would have made the whole project unmergeable. So a RISKY vote is a
    // SIGNAL: it raises the bar (a human must sign) instead of killing the
    // change. Only the deterministic findings — hard_danger and secrets —
    // block.
    const votes = e.votes;
    if (!Array.isArray(votes)) {
        problems.push('votes must be an array');
    } else if (!votes.length && e.deterministic_only !== true) {
        problems.push('votes required (at least one review)');
    }
    return { ok: problems.length === 0, problems };
}

// G3 · TEST — the BASELINE suite is authoritative (invariant I3). The digest
// of the suite that ran must equal the digest recorded at intake, so a
// change cannot pass by shipping its own (weakened) tests.
function _validateTest(p, e) {
    const problems = [];
    if (!e || typeof e !== 'object') return { ok: false, problems: ['evidence required'] };
    if (e.base_sha !== p.base_sha) {
        problems.push('the test run was against a different base commit');
    }
    if (!e.baseline_suite_digest) {
        problems.push('baseline suite digest required');
    } else if (p.baseline_suite_digest && e.baseline_suite_digest !== p.baseline_suite_digest) {
        problems.push('the suite that ran is not the baseline suite — the change may have weakened it');
    }
    const passed = Number(e.passed);
    const failed = Number(e.failed);
    if (!Number.isFinite(passed) || !Number.isFinite(failed)) {
        problems.push('passed/failed counts required');
    } else if (failed > 0) {
        problems.push(failed + ' test(s) failed');
    } else if (passed < 1) {
        problems.push('no tests ran');
    }
    return { ok: problems.length === 0, problems };
}

// G4 · APPROVE — quorum + diversity + no self-approval + a human for
// protected paths (invariant I2).
function _validateApprove(p, e) {
    const problems = [];
    if (!e || typeof e !== 'object') return { ok: false, problems: ['evidence required'] };
    const votes = Array.isArray(e.votes) ? e.votes : [];
    const approvals = votes.filter(v => String(v.verdict || '').toLowerCase() === 'approve');
    if (approvals.length < CFG.minQuorum) {
        problems.push('quorum not met (' + approvals.length + '/' + CFG.minQuorum + ')');
    }
    const families = new Set(
        approvals.map(v => String(v.family || '').toLowerCase()).filter(Boolean));
    if (families.size < CFG.minFamilies) {
        problems.push('not enough distinct model families (' + families.size + '/' + CFG.minFamilies + ')');
    }
    // No single bee may hold more than half the quorum.
    const byBee = new Map();
    for (const v of approvals) {
        const who = String(v.bee || v.by || '?');
        byBee.set(who, (byBee.get(who) || 0) + 1);
    }
    let max = 0;
    for (const n of byBee.values()) if (n > max) max = n;
    if (approvals.length && max * 2 > approvals.length) {
        problems.push('one bee holds over half the quorum — the quorum must be independent');
    }
    // The author cannot certify their own change.
    if (approvals.some(v => String(v.bee || v.by || '') === String(p.principal || ''))) {
        problems.push('the author cannot approve their own proposal');
    }
    // A protected path needs a HUMAN, always. So does a diff the study
    // flagged as possibly carrying a directive (invariant I5).
    if ((p.protected_hit || p.needs_human) && !e.human) {
        problems.push(p.protected_hit
            ? 'protected path — a human must approve (' +
              p.protected_paths.join(', ') + ')'
            : 'the study flagged a possible directive inside the diff — a human must approve');
    }
    return { ok: problems.length === 0, problems };
}

// G5 · MERGE — signed, bound to the exact bytes, and undoable (invariant I4).
function _validateMerge(p, e) {
    const problems = [];
    if (!e || typeof e !== 'object') return { ok: false, problems: ['evidence required'] };
    if (!/^[0-9a-f]{7,64}$/i.test(String(e.merge_sha || ''))) {
        problems.push('merge sha required');
    }
    if (!e.rollback_ref) {
        problems.push('rollback artifact required — the undo may not live in the changed tree');
    }
    if (e.patch_sha256 && e.patch_sha256 !== p.patch_sha256) {
        problems.push('the merge is bound to different patch bytes');
    }
    return { ok: problems.length === 0, problems };
}

// ── receipts + chain ────────────────────────────────────────────────────────

function _evidenceHash(e) {
    if (!e || typeof e !== 'object') return null;
    try {
        return _sha256(attest.canonicalize(e));
    } catch (_e) {
        return null;
    }
}

// Append a SIGNED receipt for a gate and re-derive the chain hash.
function _receipt(p, gate, outcome, evidence) {
    const evHash = _evidenceHash(evidence);
    const signed = identity.proposalReceipt({
        proposalId: p.id,
        gate,
        outcome,
        patchSha256: p.patch_sha256,
        evidenceSha256: evHash,
    });
    const receipt = {
        gate,
        outcome,
        at: Date.now(),
        evidence_sha256: evHash,
        statement: signed ? signed.statement : null,
        signature: signed ? signed.signature : null,
        public_key: signed ? signed.public_key : null,
    };
    p.receipts.push(receipt);
    p.chain_hash = chainHash(p);
    return receipt;
}

// The chain hash covers every receipt in order. Tamper with one receipt and
// the hash stops matching — the same property the audit chain has, applied to
// a change.
function chainHash(p) {
    const h = crypto.createHash('sha256');
    h.update('hivv.proposal.chain.v1');
    for (const r of p.receipts || []) {
        h.update('|');
        if (r.statement) {
            h.update(attest.canonicalize(r.statement));
        } else {
            // An unsigned receipt still contributes — it cannot be removed
            // from the chain without changing the hash.
            h.update(r.gate + '|' + r.outcome + '|' + r.at);
        }
    }
    return h.digest('hex');
}

// Verify the receipts: the chain hash matches AND every signed receipt
// verifies against the hub key that signed it.
function verifyChain(p) {
    const problems = [];
    if (!p) return { ok: false, problems: ['no proposal'] };
    if (chainHash(p) !== p.chain_hash) {
        problems.push('chain hash mismatch — a receipt was altered');
    }
    for (const r of p.receipts || []) {
        if (!r.statement) { problems.push('unsigned receipt at gate ' + r.gate); continue; }
        // The hub publishes its public key as 32 RAW bytes (the same shape
        // identity.js uses), so the SPKI structure has to be rebuilt before
        // Node will verify against it.
        let pub = null;
        try {
            const raw = Buffer.from(String(r.public_key || ''), 'base64');
            if (raw.length !== 32) throw new Error('public key is not 32 bytes');
            pub = crypto.createPublicKey({
                key: Buffer.concat([
                    Buffer.from('302a300506032b6570032100', 'hex'), raw,
                ]),
                format: 'der', type: 'spki',
            });
        } catch (e) {
            problems.push('bad public key at gate ' + r.gate);
            continue;
        }
        let ok = false;
        try {
            ok = crypto.verify(
                null,
                Buffer.from(attest.canonicalize(r.statement), 'utf8'),
                pub,
                Buffer.from(r.signature, 'base64')
            );
        } catch (_e) { ok = false; }
        if (!ok) problems.push('signature does not verify at gate ' + r.gate);
    }
    return { ok: problems.length === 0, problems };
}

// ── the proposal record ─────────────────────────────────────────────────────

function _blankGates() {
    const g = {};
    for (const name of GATE_ORDER) {
        g[name] = { status: 'pending', evidence: null, at: null, by: null, problems: [] };
    }
    return g;
}

function _public(p) {
    if (!p) return null;
    const state = stateOf(p);
    return {
        id: p.id,
        state,
        principal: p.principal,
        repo: p.repo,
        base_ref: p.base_ref,
        base_sha: p.base_sha,
        branch: p.branch,
        title: p.title,
        summary: p.summary,
        type: p.type || null,
        body: p.body || null,
        evidence: p.evidence || null,
        node_id: p.node_id || null,
        dedupe_key: p.dedupe_key || null,
        votes: p.votes || [],
        vote_count: (p.votes || []).length,
        verdict: p.verdict || null,
        screen: p.screen || null,
        reviews: p.reviews || [],
        issue_url: p.issue_url || null,
        issue_number: p.issue_number || null,
        filed_at: p.filed_at || null,
        filed_via: p.filed_via || null,
        patch_sha256: p.patch_sha256,
        files_changed: p.files_changed,
        protected_hit: p.protected_hit,
        protected_paths: p.protected_paths,
        high_risk: p.high_risk,
        high_risk_paths: p.high_risk_paths,
        baseline_suite_digest: p.baseline_suite_digest,
        needs_human: !!p.needs_human,
        gates: p.gates,
        receipts: p.receipts,
        chain_hash: p.chain_hash,
        created_at: p.created_at,
        updated_at: p.updated_at,
        expires_at: p.expires_at,
        merged_at: p.merged_at || null,
        deployed_at: p.deployed_at || null,
        rejection: p.rejection || null,
    };
}

function stateOf(p) {
    if (!p) return null;
    if (p.status === 'rejected') return 'rejected';
    if (p.status === 'expired') return 'expired';
    if (p.status === 'failed') return 'failed';
    let st = 'draft';
    for (const g of GATE_ORDER) {
        if (p.gates[g].status === 'passed') st = GATE_STATE[g];
        else break;
    }
    if (st === 'merged' && p.deployed_at) st = 'deployed';
    return st;
}

// ── create ──────────────────────────────────────────────────────────────────

function create({
    principal, repo, base_ref, base_sha, branch, title, summary,
    patch, files_changed, baseline_suite_digest, ttl_ms,
    // ── the intake funnel's fields (035) ──
    type, body, evidence, node_id, dedupe_key, votes, verdict,
    screen, reviews, issue_url, issue_number, filed_via,
    needs_human,
} = {}) {
    // A proposal is about THIS hive's source. The route and the CLI both
    // default it; requiring it here made every caller re-state the obvious.
    const repoName = (repo && typeof repo === 'string' && repo.trim())
        ? repo.trim() : 'htmlfarmer/hivv';
    const patchText = typeof patch === 'string' ? patch : '';
    const hasText = Boolean(body && String(body).trim());
    // A bug report or a suggestion is a PROPOSAL with no diff. Refusing it
    // for lacking a patch would throw away exactly the input this funnel
    // exists to collect. What must never be empty is the CONTENT.
    if (!patchText.trim() && !hasText) {
        return { ok: false, error: 'a patch or a body is required' };
    }
    if (patchText.length > CFG.maxPatchChars) {
        return { ok: false, error: 'patch too large (max ' + CFG.maxPatchChars + ' chars)' };
    }
    const files = (Array.isArray(files_changed) ? files_changed : [])
        .map(f => _norm(f)).filter(Boolean).slice(0, CFG.maxFiles);
    const cls = classifyPaths(files);
    const now = _now();
    const p = {
        id: _id(),
        principal: String(principal || 'anonymous'),
        repo: repoName,
        base_ref: base_ref ? String(base_ref).slice(0, 256) : null,
        base_sha: base_sha ? String(base_sha).slice(0, 64) : null,
        branch: branch ? String(branch).slice(0, 256) : null,
        title: String(title || '').slice(0, 300),
        summary: String(summary || '').slice(0, 4000),
        patch: patchText,
        patch_sha256: _sha256(patchText),
        files_changed: files,
        baseline_suite_digest: baseline_suite_digest ? String(baseline_suite_digest).slice(0, 64) : null,
        // The funnel sets this when the TEXT carries something that looks
        // like a directive (invariant I5). Without it the approve gate would
        // never demand a human for an injected diff — only for a protected
        // PATH — and I5 would be a comment instead of a rule.
        needs_human: !!needs_human || cls.protected_hit,
        protected_hit: cls.protected_hit,
        protected_paths: cls.protected_paths,
        high_risk: cls.high_risk,
        high_risk_paths: cls.high_risk_paths,
        gates: _blankGates(),
        receipts: [],
        chain_hash: null,
        // ── intake (035) ──
        type: type ? String(type).slice(0, 20) : null,
        body: body ? String(body).slice(0, 40000) : null,
        evidence: evidence ? String(evidence).slice(0, 4000) : null,
        node_id: node_id ? String(node_id).slice(0, 120) : null,
        dedupe_key: dedupe_key ? String(dedupe_key).slice(0, 64) : null,
        votes: Array.isArray(votes) ? votes.slice(0, 200) : [],
        verdict: verdict ? String(verdict).slice(0, 16) : null,
        screen: screen || null,
        reviews: Array.isArray(reviews) ? reviews.slice(0, 50) : [],
        issue_url: issue_url ? String(issue_url).slice(0, 500) : null,
        issue_number: Number.isFinite(issue_number) ? issue_number : null,
        filed_at: issue_url ? now : null,
        filed_via: filed_via ? String(filed_via).slice(0, 40) : null,
        status: 'open',
        created_at: now,
        updated_at: now,
        expires_at: now + _clampInt(ttl_ms, 60 * 1000, CFG.maxTtlMs, CFG.defaultTtlMs),
        merged_at: null,
        deployed_at: null,
    };
    p.chain_hash = chainHash(p);
    proposals.set(p.id, p);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── G1 · study ──────────────────────────────────────────────────────────────

function study(id, evidence, { by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    const order = _orderCheck(p, 'study');
    if (!order.ok) return { ok: false, ...order };
    const v = _validateStudy(evidence);
    p.gates.study.status = v.ok ? 'passed' : 'failed';
    // A diff-borne directive is a low-confidence signal that only a human can
    // settle — it routes the proposal to the approve gate, it does not kill
    // it. (Invariant I5: a diff is DATA, so we never let it instruct us.)
    if (evidence && Array.isArray(evidence.injection) && evidence.injection.length) {
        p.needs_human = true;
    }
    const studyVotes = (evidence && Array.isArray(evidence.votes)) ? evidence.votes : [];
    if (studyVotes.some(v => String(v.verdict || '').toUpperCase() === 'RISKY')) {
        p.needs_human = true;
    }
    // Nobody reviewed it — the contributor said so out loud. That is not a
    // block, but it does mean a human has to look before it lands.
    if (evidence && evidence.deterministic_only === true) {
        p.needs_human = true;
    }
    p.gates.study.evidence = evidence || null;
    p.gates.study.problems = v.problems;
    p.gates.study.at = Date.now();
    p.gates.study.by = by ? String(by).slice(0, 200) : null;
    p.updated_at = Date.now();
    if (!v.ok) {
        _receipt(p, 'study', 'failed', evidence);
        _persist(p);
        return { ok: false, error: 'study_failed', problems: v.problems, proposal: _public(p) };
    }
    _receipt(p, 'study', 'passed', evidence);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── G2 · authorize (the policy gate decides, not the caller) ───────────────

async function authorize(id, { principal, by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    const order = _orderCheck(p, 'authorize');
    if (!order.ok) return { ok: false, ...order };

    let verdict;
    try {
        verdict = await policy.gate({
            capability: 'source.modify',
            principal: principal || p.principal,
            transport: 'relay',
            via: 'proposal',
            args_summary: {
                repo: p.repo,
                patch_sha256: p.patch_sha256,
                files: p.files_changed.length,
                protected: p.protected_hit,
            },
        });
    } catch (e) {
        // FAIL CLOSED — a gate that cannot decide must not approve.
        p.gates.authorize.problems = ['policy gate unavailable: ' + e.message];
        p.updated_at = Date.now();
        _persist(p);
        return { ok: false, error: 'policy_unavailable', message: e.message, proposal: _public(p) };
    }

    if (verdict.verdict === 'deny') {
        p.status = 'rejected';
        p.gates.authorize.status = 'failed';
        p.gates.authorize.evidence = { rule: verdict.rule, verdict: 'deny' };
        p.gates.authorize.problems = ['denied by policy rule ' + verdict.rule];
        p.gates.authorize.at = Date.now();
        p.gates.authorize.by = by ? String(by).slice(0, 200) : null;
        p.updated_at = Date.now();
        _receipt(p, 'authorize', 'rejected', p.gates.authorize.evidence);
        _persist(p);
        return { ok: false, error: 'denied', rule: verdict.rule, proposal: _public(p) };
    }

    if (verdict.verdict === 'ask') {
        // A PENDING APPROVAL IS NOT A FAILURE. The proposal stays alive.
        p.gates.authorize.status = 'pending';
        p.gates.authorize.evidence = {
            grant_id: verdict.grant_id, rule: verdict.rule, memo: verdict.memo || null,
        };
        p.gates.authorize.problems = [];
        p.gates.authorize.at = Date.now();
        p.gates.authorize.by = by ? String(by).slice(0, 200) : null;
        p.updated_at = Date.now();
        _receipt(p, 'authorize', 'asked', p.gates.authorize.evidence);
        _persist(p);
        return {
            ok: false, verdict: 'MAYBE', grant_id: verdict.grant_id,
            message: 'human approval required — hivv approve ' + verdict.grant_id,
            proposal: _public(p),
        };
    }

    p.gates.authorize.status = 'passed';
    p.gates.authorize.evidence = {
        rule: verdict.rule, grant_id: verdict.grant_id || null, verdict: 'allow',
    };
    p.gates.authorize.problems = [];
    p.gates.authorize.at = Date.now();
    p.gates.authorize.by = by ? String(by).slice(0, 200) : null;
    p.updated_at = Date.now();
    _receipt(p, 'authorize', 'passed', p.gates.authorize.evidence);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── G3 · test ───────────────────────────────────────────────────────────────

function test(id, evidence, { by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    const order = _orderCheck(p, 'test');
    if (!order.ok) return { ok: false, ...order };
    const v = _validateTest(p, evidence);
    p.gates.test.status = v.ok ? 'passed' : 'failed';
    p.gates.test.evidence = evidence || null;
    p.gates.test.problems = v.problems;
    p.gates.test.at = Date.now();
    p.gates.test.by = by ? String(by).slice(0, 200) : null;
    p.updated_at = Date.now();
    if (!v.ok) {
        _receipt(p, 'test', 'failed', evidence);
        _persist(p);
        return { ok: false, error: 'test_failed', problems: v.problems, proposal: _public(p) };
    }
    _receipt(p, 'test', 'passed', evidence);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── G4 · approve ────────────────────────────────────────────────────────────

function approve(id, evidence, { by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    const order = _orderCheck(p, 'approve');
    if (!order.ok) return { ok: false, ...order };
    const v = _validateApprove(p, evidence);
    p.gates.approve.status = v.ok ? 'passed' : 'failed';
    p.gates.approve.evidence = evidence || null;
    p.gates.approve.problems = v.problems;
    p.gates.approve.at = Date.now();
    p.gates.approve.by = by ? String(by).slice(0, 200) : null;
    p.updated_at = Date.now();
    if (!v.ok) {
        _receipt(p, 'approve', 'failed', evidence);
        _persist(p);
        return { ok: false, error: 'approval_failed', problems: v.problems, proposal: _public(p) };
    }
    _receipt(p, 'approve', 'passed', evidence);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── G5 · merge ──────────────────────────────────────────────────────────────

function merge(id, evidence, { by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    const order = _orderCheck(p, 'merge');
    if (!order.ok) return { ok: false, ...order };
    const v = _validateMerge(p, evidence);
    p.gates.merge.status = v.ok ? 'passed' : 'failed';
    p.gates.merge.evidence = evidence || null;
    p.gates.merge.problems = v.problems;
    p.gates.merge.at = Date.now();
    p.gates.merge.by = by ? String(by).slice(0, 200) : null;
    p.updated_at = Date.now();
    if (!v.ok) {
        _receipt(p, 'merge', 'failed', evidence);
        _persist(p);
        return { ok: false, error: 'merge_failed', problems: v.problems, proposal: _public(p) };
    }
    p.merged_at = Date.now();
    _receipt(p, 'merge', 'passed', evidence);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// Mark it deployed (the deploy rails ran and the health check passed).
function deployed(id, { by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (stateOf(p) !== 'merged') {
        return { ok: false, error: 'proposal has not merged' };
    }
    p.deployed_at = Date.now();
    p.updated_at = Date.now();
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── rejection ───────────────────────────────────────────────────────────────

function reject(id, { reason, by } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (p.status !== 'open') return { ok: false, error: 'proposal is ' + p.status };
    p.status = 'rejected';
    p.updated_at = Date.now();
    p.rejection = { reason: String(reason || 'rejected').slice(0, 1000), by: by ? String(by).slice(0, 200) : null, at: Date.now() };
    _receipt(p, 'study', 'rejected', p.rejection);
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── dedupe + votes ──────────────────────────────────────────────────────────

// Find an existing proposal carrying the same normalized title+body. This is
// the whole point of the dedupe stage: five bees with the same idea must
// become ONE issue with +5 votes, not five issues nobody can compare.
function findByDedupe(key) {
    if (!key) return null;
    for (const p of proposals.values()) {
        if (p.dedupe_key && p.dedupe_key === key) return _public(p);
    }
    return null;
}

// A vote is an IDENTITY, not a counter — {node_id, principal, at}. A number
// can be inflated by a loop; a list of principals can be audited.
// The SAME bee voting twice on the same proposal counts ONCE.
const VERDICT_ORDER = { SAFE: 0, REVIEW: 1, RISKY: 2 };

function addVote(id, vote) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (!Array.isArray(p.votes)) p.votes = [];

    // LAW A — a later bee's screen may only make the record WORSE. If bee #2
    // found something bee #1 missed, keeping the original SAFE would launder
    // the finding through the dedupe path.
    const incoming = vote && vote.verdict;
    const current = p.verdict || 'SAFE';
    if (incoming && (VERDICT_ORDER[incoming] || 0) > (VERDICT_ORDER[current] || 0)) {
        p.verdict = incoming;
    }

    const node = String((vote && (vote.node_id || vote.principal)) || '').slice(0, 120);
    if (node && p.votes.some(v => String(v.node_id || v.principal || '') === node)) {
        p.updated_at = Date.now();
        _persist(p);
        return { ok: true, deduped_vote: true, votes: p.votes.length, proposal: _public(p) };
    }
    p.votes.push({
        node_id: (vote && vote.node_id) ? String(vote.node_id).slice(0, 120) : null,
        principal: (vote && vote.principal) ? String(vote.principal).slice(0, 120) : null,
        at: Date.now(),
    });
    p.updated_at = Date.now();
    _persist(p);
    return { ok: true, votes: p.votes.length, proposal: _public(p) };
}

// Record where it landed on GitHub. The relay is idempotent, so this is
// called on every attempt and simply records the first successful answer.
function fileIssue(id, { issue_number, issue_url, filed_via } = {}) {
    const p = proposals.get(id);
    if (!p) return { ok: false, error: 'proposal not found' };
    if (issue_number != null) p.issue_number = Number(issue_number);
    if (issue_url) p.issue_url = String(issue_url).slice(0, 500);
    if (filed_via) p.filed_via = String(filed_via).slice(0, 40);
    p.filed_at = p.filed_at || Date.now();
    p.updated_at = Date.now();
    _persist(p);
    return { ok: true, proposal: _public(p) };
}

// ── reads ───────────────────────────────────────────────────────────────────

function get(id) { return _public(proposals.get(id)); }

// The patch TEXT. Deliberately absent from _public(): it can be 400 KB and
// every list read would carry it. The relay needs it exactly once, when an
// approved change becomes a branch.
function patchOf(id) {
    const p = proposals.get(id);
    return p && typeof p.patch === 'string' ? p.patch : '';
}

function list({ state = null, principal = null, limit = 50 } = {}) {
    const out = [];
    for (const p of proposals.values()) {
        if (state && stateOf(p) !== state) continue;
        if (principal && p.principal !== principal) continue;
        out.push(_public(p));
    }
    out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return out.slice(0, _clampInt(limit, 1, 500, 50));
}

// ── expiry ──────────────────────────────────────────────────────────────────

function _sweep() {
    const now = Date.now();
    for (const p of proposals.values()) {
        if (p.status === 'open' && now > p.expires_at) {
            p.status = 'expired';
            p.updated_at = now;
            _receipt(p, 'study', 'expired', { expired_at: now });
            _persist(p);
        }
    }
    // bounded memory: drop the oldest TERMINAL proposals first
    if (proposals.size > CFG.maxProposals) {
        const terminal = [...proposals.values()]
            .filter(p => p.status !== 'open')
            .sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
        while (proposals.size > CFG.maxProposals && terminal.length) {
            proposals.delete(terminal.shift().id);
        }
    }
}

// ── optional Postgres mirror ───────────────────────────────────────────────

async function ensureSchema() {
    if (!pool) return false;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS hivv_proposals (
                id TEXT PRIMARY KEY,
                state TEXT NOT NULL DEFAULT 'draft',
                principal TEXT,
                repo TEXT,
                base_sha TEXT,
                branch TEXT,
                title TEXT,
                patch_sha256 TEXT,
                protected_hit BOOLEAN DEFAULT FALSE,
                high_risk BOOLEAN DEFAULT FALSE,
                gates JSONB NOT NULL DEFAULT '{}'::jsonb,
                receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
                chain_hash TEXT,
                created_at BIGINT,
                updated_at BIGINT,
                expires_at BIGINT,
                merged_at BIGINT,
                deployed_at BIGINT
            )`);
        return true;
    } catch (e) {
        console.warn('[PROPOSAL] schema ensure failed:', e.message);
        return false;
    }
}

function _persist(p) {
    if (!pool) return;
    pool.query(`
        INSERT INTO hivv_proposals
            (id, state, principal, repo, base_sha, branch, title, patch_sha256,
             protected_hit, high_risk, gates, receipts, chain_hash,
             created_at, updated_at, expires_at, merged_at, deployed_at,
             type, body, evidence, node_id, dedupe_key, votes, verdict,
             screen, reviews, issue_number, issue_url, filed_at, filed_via)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
        ON CONFLICT (id) DO UPDATE SET
            state=EXCLUDED.state, gates=EXCLUDED.gates, receipts=EXCLUDED.receipts,
            chain_hash=EXCLUDED.chain_hash, updated_at=EXCLUDED.updated_at,
            merged_at=EXCLUDED.merged_at, deployed_at=EXCLUDED.deployed_at,
            votes=EXCLUDED.votes, verdict=EXCLUDED.verdict,
            issue_number=EXCLUDED.issue_number, issue_url=EXCLUDED.issue_url,
            filed_at=EXCLUDED.filed_at, filed_via=EXCLUDED.filed_via`,
        [p.id, stateOf(p), p.principal, p.repo, p.base_sha, p.branch, p.title,
            p.patch_sha256, p.protected_hit, p.high_risk,
            JSON.stringify(p.gates), JSON.stringify(p.receipts), p.chain_hash,
            p.created_at, p.updated_at, p.expires_at, p.merged_at, p.deployed_at,
            p.type, p.body, p.evidence, p.node_id, p.dedupe_key,
            JSON.stringify(p.votes || []), p.verdict,
            p.screen ? JSON.stringify(p.screen) : null,
            JSON.stringify(p.reviews || []),
            p.issue_number, p.issue_url, p.filed_at, p.filed_via])
        .catch((err) => console.warn('[PROPOSAL] persist failed:', err.message));
}

async function init(pgPool) {
    pool = pgPool || null;
    if (pool) {
        await ensureSchema();
        try {
            const r = await pool.query(
                'SELECT * FROM hivv_proposals ORDER BY created_at DESC LIMIT 500');
            for (const row of r.rows) {
                if (proposals.has(row.id)) continue;
                proposals.set(row.id, {
                    id: row.id,
                    principal: row.principal, repo: row.repo,
                    base_ref: null, base_sha: row.base_sha, branch: row.branch,
                    title: row.title, summary: '', patch: '', patch_sha256: row.patch_sha256,
                    // ── intake (035) ──
                    type: row.type || null,
                    body: row.body || null,
                    evidence: row.evidence || null,
                    node_id: row.node_id || null,
                    dedupe_key: row.dedupe_key || null,
                    votes: Array.isArray(row.votes) ? row.votes : [],
                    verdict: row.verdict || null,
                    screen: row.screen || null,
                    reviews: Array.isArray(row.reviews) ? row.reviews : [],
                    issue_number: row.issue_number != null ? Number(row.issue_number) : null,
                    issue_url: row.issue_url || null,
                    filed_at: row.filed_at ? Number(row.filed_at) : null,
                    filed_via: row.filed_via || null,
                    files_changed: [], baseline_suite_digest: null,
                    protected_hit: !!row.protected_hit, protected_paths: [],
                    high_risk: !!row.high_risk, high_risk_paths: [],
                    gates: row.gates && typeof row.gates === 'object'
                        ? Object.assign(_blankGates(), row.gates) : _blankGates(),
                    receipts: Array.isArray(row.receipts) ? row.receipts : [],
                    chain_hash: row.chain_hash,
                    status: (row.state === 'rejected' || row.state === 'expired' || row.state === 'failed')
                        ? row.state : 'open',
                    created_at: Number(row.created_at) || Date.now(),
                    updated_at: Number(row.updated_at) || Date.now(),
                    expires_at: Number(row.expires_at) || (Date.now() + CFG.defaultTtlMs),
                    merged_at: row.merged_at ? Number(row.merged_at) : null,
                    deployed_at: row.deployed_at ? Number(row.deployed_at) : null,
                });
            }
        } catch (e) {
            console.warn('[PROPOSAL] restore failed:', e.message);
        }
    }
    if (!janitor) {
        janitor = setInterval(_sweep, CFG.janitorMs);
        if (janitor.unref) janitor.unref();
    }
    console.log('[PROPOSAL] started (' + (pool ? 'db mirror on' : 'memory only') + ')');
}

function _resetForTests() {
    proposals.clear();
    if (janitor) { clearInterval(janitor); janitor = null; }
    pool = null;
}

module.exports = {
    CFG, GATE_ORDER, GATE_STATE, STATES,
    PROTECTED_PATHS, HIGH_RISK_PREFIXES, HIGH_RISK_FILES,
    create, study, authorize, test, approve, merge, deployed, reject,
    findByDedupe, addVote, fileIssue, patchOf,
    get, list, stateOf, chainHash, verifyChain,
    isProtected, isHighRisk, classifyPaths,
    init, _resetForTests,
};
