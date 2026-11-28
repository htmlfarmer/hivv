'use strict';

// api/routes/proposal-routes.js — THE HTTP SURFACE for the proposal pipeline.
//
// A proposal is one proposed change to the source. This router is a THIN
// ADAPTER over api/lib/proposal.js — the state machine owns the law, this
// file only moves bytes.
//
// The routes, in gate order:
//   POST /api/proposals                 intake          (record the change)
//   POST /api/proposals/:id/study      G1 study        (what does it do?)
//   POST /api/proposals/:id/authorize  G2 authorize    (may it happen?)
//   POST /api/proposals/:id/test       G3 test         (does it work?)
//   POST /api/proposals/:id/approve    G4 approve      (do enough say yes?)
//   POST /api/proposals/:id/merge      G5 merge        (land it)
//   POST /api/proposals/:id/reject                    (kill it, with a reason)
//
// Reads:
//   GET  /api/proposals                 list
//   GET  /api/proposals/stats           counts
//   GET  /api/proposals/:id             one
//   GET  /api/proposals/:id/verify      verify the receipt chain
//
// THE LAW IS NOT HERE. "A gate may be marked passed only when every earlier
// gate is passed" lives in the state machine, so a new caller cannot invent a
// way around it. This file can only ASK the machine to advance.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const proposal = require('../lib/proposal');
const funnel = require('../lib/proposal-funnel');
const githubRelay = require('../lib/github-relay');

// The AIRouter is constructed in server.js and handed down (the same
// pattern ScanRoutes.inject uses) — requiring './router' would grab the
// CLASS, not the live instance, and the model board would vote with nothing.
let _pool = null;
router.inject = (aiRouter, pool) => {
  _pool = pool || null;
  funnel.inject(aiRouter, pool);
};

// The operator credential: env first, then the 0600 file the operator
// generates — the SAME fallback control-routes.js and ecosystem.config.js
// already use. proposal-routes was the only file that read the env alone, so
// wherever the token lived in the file and not the env, token auth here
// silently never worked and LOOPBACK was the only way to be an operator.
// control-routes.js documents that exact production state ("it was an empty
// string, so token auth simply never worked").
function _loadControlToken() {
    if (process.env.HIVV_CONTROL_TOKEN) return process.env.HIVV_CONTROL_TOKEN;
    try {
        const t = require('fs').readFileSync(
            require('path').join(__dirname, '..', '.control-token'), 'utf8').trim();
        return t || '';
    } catch (_e) { return ''; }
}
const CONTROL_TOKEN = _loadControlToken();
let _warnedNoToken = false;

// ── rate limits ─────────────────────────────────────────────────────────────
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_MAX = 20;          // proposals / min / requester
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX = 120;          // gate advances / min / requester

const hits = new Map();
function _limit(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
        hits.set(key, arr);
        return { allowed: false, retry_after_s: Math.ceil((arr[0] + windowMs - now) / 1000) };
    }
    arr.push(now);
    hits.set(key, arr);
    return { allowed: true };
}

// ── identity ────────────────────────────────────────────────────────────────
function _requester(req) {
    return String(req.headers['x-visitor-id'] || req.ip || 'anon').slice(0, 128);
}

// WHO is asking — VERIFIED, never claimed.
//
// This used to fall back to the raw `x-visitor-id` header. That header is
// documented at server.js:540 as spoofable — "rate-limiting wants a cheap
// label, not an identity" — and `p.principal` is PUBLIC: it comes back from
// GET /api/proposals/:id and is printed into the GitHub issue provenance.
// Put those together and anyone who could READ a proposal could CLAIM to be
// its author:
//
//     POST /api/proposals/<id>/reject  (no identity)          → 403
//     ... + x-visitor-id: <the public principal>              → 200, rejected
//
// Reproduced against the live gateway before this change.
//
// Two ways in now, both verified:
//   1. a session — getSession() is the server's own, so it is not claimable;
//   2. a FRESH signed statement, verified exactly the way intake verifies
//      one. verifyIncoming() refuses a REPLAYED nonce as fatal, so the block
//      that created the proposal cannot be reused to act on it — the node
//      signs this action separately, which is the whole point of a nonce.
//
// Anything else is null, and null is not an owner.
async function _principal(req) {
    try {
        const serverPath = require.resolve('../server');
        if (require.cache[serverPath]) {
            const s = await require('../server').getSession(req);
            if (s && s.userId) return 'user:' + s.userId;
        }
    } catch (_e) { /* fall through */ }

    const body = req.body || {};
    const block = body.identity;
    const nodeId = _cleanId(body.node_id || req.headers['x-hivv-node']);
    if (block && nodeId) {
        try {
            // _mayWrite needs WHO, not WHAT — the action is a separate
            // decision made by the route. 'proposal.create' is the kind the
            // identity system already knows how to sign, so a bee can mint
            // one with the signing code it already has.
            const v = require('../lib/identity').verifyIncoming({
                nodeId, identity: block, kind: 'proposal.create',
            });
            if (v && v.ok && v.principal) return v.principal;
        } catch (_e) { /* fail closed */ }
    }
    return null;
}

// node_id is attacker-influenced (a signed statement may carry any string).
// Strip control characters so it can never forge a log line or smuggle a
// header, and cap it — 120 is plenty for a bee name.
function _cleanId(v) {
    const s = String(v == null ? '' : v)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 120);
    return s || null;
}

function timingSafeEq(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length) return false;
    try { return crypto.timingSafeEqual(x, y); } catch (_e) { return false; }
}

// OPERATOR — a credential, never an address.
//
// Loopback used to grant admin here. Two ways in, and both are bad:
//
//   * SSRF. Any service on this box that can be talked into fetching
//     http://127.0.0.1:3011/... inherits operator rights, because the
//     request really does arrive from 127.0.0.1.
//   * X-Forwarded-For. server.js sets `trust proxy = 1`, so for a request
//     that reaches the origin WITHOUT the proxy, req.ip is the rightmost
//     X-Forwarded-For entry — a client can send
//     `X-Forwarded-For: 127.0.0.1` and become the operator outright.
//
// An address is not a credential. Fail closed (CONTRIBUTING rule #2): with
// no token configured nobody is an operator, and the fix is to generate
// api/.control-token — not to fall back to trusting the network.
function _isAdmin(req) {
    const t = req.headers['x-control-token'];
    if (CONTROL_TOKEN && t && timingSafeEq(t, CONTROL_TOKEN)) return true;
    if (!CONTROL_TOKEN && !_warnedNoToken) {
        _warnedNoToken = true;
        console.error('[PROPOSAL] no control token configured — operator ' +
            'actions (merge/approve) are refused for everyone. Generate ' +
            'api/.control-token (0600) or set HIVV_CONTROL_TOKEN.');
    }
    return false;
}

// Ownership: the author may read and advance their own proposal. An admin
// may do anything. Anyone else may only READ (a public proposal is a public
// proposal — that is the point of a transparent change log).
async function _mayWrite(req, p) {
    if (_isAdmin(req)) return true;
    const who = await _principal(req);
    return Boolean(who && p && p.principal === who);
}

// ── intake ──────────────────────────────────────────────────────────────────
// What the issue says. PUBLIC PROVENANCE: the node IDs, the vote count and
// the verdict ride along with the proposal, so anyone reading the issue can
// see which bees said it and what the screens found.
function _issueBody(out) {
    const lines = [];
    lines.push('## ' + (out.type || 'suggestion').toUpperCase() + ' — from the hive');
    lines.push('');
    if (out.body) lines.push(out.body);
    if (out.evidence) { lines.push('', '### Evidence', '', out.evidence); }
    lines.push('', '### Provenance', '');
    lines.push('- proposed by: ' + (out.node_id || 'unknown bee') + ' (' + out.principal + ')');
    lines.push('- verdict: **' + out.verdict + '**');
    const sc = out.screen || {};
    lines.push('- deterministic screen: ' + (sc.verdict || 'n/a')
        + ' (score ' + ((sc.risks && sc.risks.score) != null ? sc.risks.score : '?') + ')');
    const votes = (out.reviews || []).filter(v => v && v.ok);
    if (votes.length) {
        lines.push('- model board: ' + votes.map(v => v.model + ' → ' + v.verdict).join(' · '));
    } else {
        lines.push('- model board: no usable verdict (routed for human review)');
    }
    if ((out.problems || []).length) {
        lines.push('', '### Flags', '');
        for (const p of out.problems.slice(0, 10)) lines.push('- ' + p);
    }
    lines.push('', '---', 'Filed automatically by the hivv proposal funnel.');
    return lines.join('\n');
}

// Which bee said this, for the provenance comment. Falls back to the
// signed principal when the node id is missing — an identity is never empty.
// Run the REAL deploy rails — never a second, home-grown deploy path.
// DETACHED on purpose: deploy.sh restarts this very gateway, so waiting on
// it would kill the request that spawned it.
function _spawnDeploy(proposalId) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const logDir = path.join(root, 'logs');
    const log = path.join(logDir, 'proposal-deploy-' +
        String(proposalId).replace(/[^\w.-]+/g, '_') + '.log');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_e) { /* best effort */ }
    try {
        const fd = fs.openSync(log, 'a');
        const child = spawn('bash', [path.join(root, 'scripts', 'deploy.sh')], {
            cwd: root,
            detached: true,
            stdio: ['ignore', fd, fd],
            env: { ...process.env, HIVV_DEPLOY_PROPOSAL: String(proposalId) },
        });
        try { fs.closeSync(fd); } catch (_e) { /* the child owns its copy */ }
        child.unref();
        fs.appendFileSync(log, '\n[proposal] ' + proposalId +
            ' merged — deploy.sh spawned (pid ' + child.pid + ')\n');
        return { pid: child.pid, log };
    } catch (e) {
        return { error: String(e.message).slice(0, 200), log };
    }
}

function node_id_label(nodeId, principal) {
    if (nodeId) return nodeId;
    if (principal) return principal;
    return 'unknown bee';
}

// THE HIVE'S REPLY. The issue body states the verdict; this comment says
// WHY — every brain's verdict, its risk line and its notes, plus what the
// deterministic screen found. A proposal the board could not answer says so
// out loud instead of being read as approved (law B).
function _reviewBody(out) {
    const esc = (s) => String(s == null || s === '' ? '-' : s)
        .replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
    const lines = [];
    lines.push("### The hive's review");
    lines.push('');
    lines.push('**Verdict: ' + (out.verdict || 'unknown') + '**');
    lines.push('');

    const votes = (out.reviews || []).filter(v => v && v.ok);
    if (votes.length) {
        lines.push('| model | family | verdict | risk | notes |');
        lines.push('|---|---|---|---|---|');
        for (const v of votes) {
            lines.push('| ' + esc(v.model) + ' | ' + esc(v.family)
                + ' | **' + esc(v.verdict) + '** | ' + esc(v.risk)
                + ' | ' + esc(v.notes) + ' |');
        }
        const fams = [...new Set(votes.map(v => v.family))];
        lines.push('');
        lines.push(votes.length + ' brain(s) across ' + fams.length
            + ' famil' + (fams.length === 1 ? 'y' : 'ies') + ': ' + fams.join(', '));
    } else {
        lines.push('_No brain returned a usable verdict. This one is routed '
            + 'for human review — that is not the same as being approved._');
    }

    const sc = out.screen || {};
    if (sc.risks) {
        lines.push('');
        lines.push('Deterministic screen: **' + (sc.verdict || 'n/a')
            + '** · score ' + (sc.risks.score != null ? sc.risks.score : '?')
            + ' · ' + (sc.risks.level || ''));
    }
    if ((out.problems || []).length) {
        lines.push('');
        lines.push('Flags:');
        for (const p of out.problems.slice(0, 8)) lines.push('- ' + p);
    }
    if (out.needs_human) {
        lines.push('');
        lines.push('> A human signs this one before it lands: the text carries '
            + 'something that could be read as a directive.');
    }
    lines.push('');
    lines.push('_Posted automatically by the hivv proposal funnel._');
    return lines.join('\n');
}

// Would a patch walk the gate machine? (It only does when there is a diff.)
function patchWouldWalk(out) {
    return Boolean(out && out.patch && String(out.patch).trim());
}

function _labelsFor(out) {
    const labels = ['hive-proposal', out.type || 'suggestion'];
    if (out.verdict === 'RISKY' || out.verdict === 'REVIEW') labels.push('needs-review');
    return labels;
}

// ── STAGES 1-6 · THE FUNNEL ────────────────────────────────────────────────
//
// verify → limit → dedupe → screen → model board → policy gate.
// The order is the law (api/lib/proposal-funnel.js), and a stage may only
// make the outcome WORSE — nothing at intake can approve anything.
router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
    // TRANSPORT limit first — per IP, free, before any cryptography.
    const rl = _limit('c:' + _requester(req), CREATE_MAX, CREATE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'proposal rate limit', retry_after_s: rl.retry_after_s });
    }

    const body = req.body || {};
    const principal = (await _principal(req)) || _requester(req);
    const nodeId = _cleanId(body.node_id || req.headers['x-hivv-node']);
    // A pre-check is a query parameter, never a body field a client can
    // smuggle past a proxy that only inspects the payload.
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';

    let out;
    try {
        out = await funnel.run({
            body, identity: body.identity, nodeId, ip: req.ip, principal,
            pool: _pool, dryRun,
        });
    } catch (e) {
        // FAIL CLOSED — a funnel that threw could not decide, and a proposal
        // that could not be decided goes to a HUMAN, never onto GitHub.
        // The stack, not just the message: the first bug this route shipped
        // was a bare `pool` ReferenceError and the message alone said nothing.
        console.error('[PROPOSAL] funnel error:', e.message,
            '\n', String(e.stack || '').split('\n').slice(1, 5).join('\n'));
        return res.status(500).json({
            ok: false, stage: 'funnel', needs_human: true,
            problems: ['funnel unavailable: ' + String(e.message).slice(0, 200)],
        });
    }

    if (!out.ok) {
        const code = out.stage === 'verify' ? 403
            : out.stage === 'limit' ? 429
            : out.stage === 'validate' ? 400
            : out.stage === 'screen' ? 422 : 400;
        if (out.retry_after_s) res.set('Retry-After', String(out.retry_after_s));
        return res.status(code).json({
            ok: false, stage: out.stage, problems: out.problems || [],
            verdict: out.verdict || null, never_file: !!out.never_file,
        });
    }

    // ── THE PRE-CHECK (?dry_run=1) — run every check, write NOTHING ──────
    //
    // This is the safe half of "let me see what would happen before I send".
    // It is NOT a bypass: every stage still runs and still reports honestly,
    // including the rate limit (peeked, not spent) and the policy gate
    // (policy.gate dryRun never mints a grant). What it never does is leave
    // a mark — no record, no issue, no comment, no grant, no vote.
    //
    // A client may ask for this. A client may never use it to skip a check.
    if (dryRun) {
        const existing = proposal.findByDedupe(out.dedupe_key);
        const files = Array.isArray(body.files_changed) ? body.files_changed : [];
        const cls = proposal.classifyPaths(files);
        return res.json({
            ok: true,
            dry_run: true,
            verdict: out.verdict,
            dedupe_key: out.dedupe_key,
            would: {
                create: existing ? false : true,
                add_vote_to: existing ? existing.id : null,
                filing: out.filing,
                needs_human: !!out.needs_human,
                protected_path: cls.protected_hit,
                protected_paths: cls.protected_paths,
                gates: patchWouldWalk(out) ? ['study', 'authorize', 'test', 'approve', 'merge'] : [],
            },
            screen: out.screen
                ? { verdict: out.screen.verdict, risks: out.screen.risks,
                    hard: (out.screen.hard_findings || []).length,
                    secrets: (out.screen.secret_findings || []).length }
                : null,
            reviews: out.reviews || [],
            injection: out.injection || [],
            problems: out.problems || [],
            message: 'dry run — nothing was created, no grant was minted, '
                + 'your rate-limit allowance was not spent',
        });
    }

    // ── STAGE 3 · DEDUPE — five bees, ONE issue, +5 votes ────────────────
    const existing = proposal.findByDedupe(out.dedupe_key);
    if (existing) {
        const v = proposal.addVote(existing.id, {
            node_id: nodeId, principal: out.principal, verdict: out.verdict,
        });
        const votes = v.votes || existing.vote_count || 0;
        const merged = v.proposal || existing;
        console.log('[PROPOSAL] deduped -> ' + existing.id + ' (' + votes + ' votes)');

        // STAGE 4 — the vote is PUBLIC PROVENANCE. Anyone reading the issue
        // should see that another bee agreed, and with what verdict. Best
        // effort: a comment that fails must never lose the vote itself.
        // Only a DIFFERENT bee earns a comment. The same bee retrying its
        // own proposal is not new agreement, and an issue that comments on
        // every retry is noise nobody reads.
        if (existing.issue_number && !v.deduped_vote) {
            try {
                await githubRelay.comment({
                    id: existing.id,
                    issue_number: existing.issue_number,
                    body: 'Another bee agrees — **' + votes + '** vote(s) now.\n\n'
                        + '- bee: ' + (node_id_label(nodeId, out.principal))
                        + '\n- its verdict: ' + out.verdict
                        + '\n- board: ' + ((out.reviews || []).filter(x => x && x.ok)
                            .map(x => x.model + ' → ' + x.verdict).join(', ') || 'no usable verdict'),
                    principal: out.principal,
                });
            } catch (e) {
                console.error('[PROPOSAL] vote comment failed:', e.message);
            }
        }

        return res.status(200).json({
            ok: true,
            deduped: true,
            proposal: v.proposal || existing,
            votes,
            verdict: existing.verdict || out.verdict,
            issue_url: existing.issue_url || null,
            note: 'the same idea was already filed — your identity was added as a vote, not a second issue',
        });
    }

    // ── record it ────────────────────────────────────────────────────────
    const created = proposal.create({
        principal: out.principal,
        repo: body.repo || 'htmlfarmer/hivv',
        base_ref: body.base_ref,
        base_sha: body.base_sha,
        branch: body.branch,
        title: out.title,
        summary: body.summary || out.body || '',
        patch: out.patch || '',
        files_changed: body.files_changed,
        baseline_suite_digest: body.baseline_suite_digest,
        ttl_ms: body.ttl_ms,
        type: out.type,
        body: out.body,
        evidence: out.evidence,
        node_id: nodeId,
        dedupe_key: out.dedupe_key,
        votes: [{ node_id: nodeId, principal: out.principal, at: Date.now() }],
        verdict: out.verdict,
        screen: out.screen,
        reviews: out.reviews,
        needs_human: out.needs_human,
        red_team: !!out.red_team,
    });
    if (!created.ok) return res.status(400).json({ ok: false, error: created.error });

    const id = created.proposal.id;

    // ── STAGE 6 · policy gate → auto-file / needs-human / never-file ─────
    const filing = out.filing || { action: 'needs_human', rule: 'unknown' };
    let filed = null;
    if (filing.action === 'file') {
        try {
            filed = await githubRelay.createIssue({
                id,
                title: out.title,
                body: _issueBody(out),
                labels: _labelsFor(out),
                principal: out.principal,
            });
            if (filed && filed.ok) {
                proposal.fileIssue(id, {
                    issue_number: filed.number,
                    issue_url: filed.html_url,
                    filed_via: githubRelay.isStub() ? 'stub' : 'github',
                });
                // THE HIVE'S REPLY — the reasoning, not just the verdict.
                // Best effort: a comment that fails must never lose the
                // filing it is commenting on.
                try {
                    await githubRelay.comment({
                        id,
                        issue_number: filed.number,
                        body: _reviewBody(out),
                        principal: out.principal,
                    });
                } catch (e) {
                    console.error('[PROPOSAL] review comment failed:', e.message);
                }
            }
        } catch (e) {
            filed = { ok: false, error: String(e.message).slice(0, 200) };
            console.error('[PROPOSAL] relay failed for ' + id + ':', e.message);
        }
    }

    // ── the BACK HALF for a patch ────────────────────────────────────────
    //
    // A suggestion or a bug is finished once it is filed — there is no code
    // to land. A PATCH has to walk the gate machine (study → authorize →
    // test → approve → merge), and the funnel already computed exactly the
    // evidence G1 study wants, so the hub advances it here instead of asking
    // the node to send the same findings back. G3 test still needs a real
    // test run, and G5 merge still needs an operator — neither is ours to
    // assert.
    let gates = null;
    if (out.patch && String(out.patch).trim()) {
        const usableVotes = (out.reviews || []).filter(v => v && v.ok);
        if (!usableVotes.length) {
            // The board was unreachable (a busy bee, a timeout). Marking the
            // study gate FAILED would strand the proposal forever on a
            // transient, so DEFER it: study stays pending and can be run
            // again the moment the board answers. No data is not a verdict.
            gates = {
                study: 'deferred — the model board returned no usable verdict; re-run study later',
                authorize: 'not run',
            };
        } else {
        const studyEvidence = {
            hard_danger: (out.screen && out.screen.hard_findings) || [],
            secrets: (out.screen && out.screen.secret_findings) || [],
            injection: out.injection || [],
            votes: usableVotes.map(v => ({
                verdict: v.verdict,
                family: v.family,
                bee: v.bee || v.model,
            })),
        };
        const studied = proposal.study(id, studyEvidence, { by: 'funnel' });
        let authorized = null;
        if (studied && studied.ok) {
            authorized = await proposal.authorize(id, {
                principal: out.principal, by: 'funnel',
            });
        }
        gates = {
            study: studied && studied.ok ? 'passed'
                : (studied && studied.problems) || 'not run',
            authorize: authorized
                ? (authorized.verdict === 'MAYBE' ? 'MAYBE' : (authorized.ok ? 'passed' : 'refused'))
                : 'not run',
            grant_id: authorized && authorized.grant_id || null,
        };
        }
    }

    const refreshed = proposal.get(id) || created.proposal;
    console.log('[PROPOSAL] ' + id + ' ' + out.verdict
        + ' · ' + filing.action
        + ' · ' + filing.action
        + (refreshed.protected_hit ? ' · PROTECTED' : '')
        + (filed && filed.deduped ? ' · already filed' : ''));

    res.status(201).json({
        ok: true,
        proposal: refreshed,
        verdict: out.verdict,
        dedupe_key: out.dedupe_key,
        votes: (refreshed.votes || []).length,
        screen: out.screen
            ? { verdict: out.screen.verdict, risks: out.screen.risks,
                hard: (out.screen.hard_findings || []).length,
                secrets: (out.screen.secret_findings || []).length }
            : null,
        reviews: out.reviews || [],
        filing: {
            action: filing.action,
            grant_id: filing.grant_id || null,
            rule: filing.rule || null,
            issue_number: (filed && filed.number) || refreshed.issue_number || null,
            issue_url: (filed && filed.html_url) || refreshed.issue_url || null,
            stub: githubRelay.isStub(),
            detail: filed && !filed.ok ? filed.error : null,
        },
        protected_hit: !!refreshed.protected_hit,
        gates,
        problems: out.problems || [],
        message: filing.action === 'file'
            ? (filed && filed.deduped ? 'already filed — vote recorded' : 'filed')
            : filing.action === 'needs_human'
                ? 'held for a human — hivv approve ' + (filing.grant_id || '<grant>')
                : 'never filed (denied by policy rule ' + filing.rule + ')',
    });
});

// ── reads ───────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
    const state = req.query.state ? String(req.query.state) : null;
    const limit = parseInt(req.query.limit, 10) || 50;
    // Hostile-testing traffic is RECORDED (you need to see what the funnel
    // did with it) but never published — the public page is about what the
    // hive is actually working on. Ask for them with ?red_team=1.
    const wantRedTeam = req.query.red_team === '1' || req.query.red_team === 'true';
    const all = proposal.list({ state, limit: Math.max(limit, 500) });
    const rows = wantRedTeam ? all : all.filter(p => !p.red_team);
    res.json({
        proposals: rows.slice(0, limit),
        red_team_excluded: wantRedTeam ? 0 : all.filter(p => p.red_team).length,
    });
});

router.get('/stats', (req, res) => {
    // The SAME population as the list door: hostile-testing rows are counted
    // nowhere the public looks, or the two doors disagree about how many
    // proposals exist and the page publishes two different numbers.
    const wantRedTeam = req.query.red_team === '1' || req.query.red_team === 'true';
    const all = proposal.list({ limit: 500 })
        .filter(p => wantRedTeam || !p.red_team);
    const counts = {};
    for (const p of all) counts[p.state] = (counts[p.state] || 0) + 1;
    res.json({
        counts,
        total: all.length,
        red_team_excluded: wantRedTeam ? 0
            : proposal.list({ limit: 500 }).filter(p => p.red_team).length,
        gates: proposal.GATE_ORDER,
    });
});

// ── STAGE 4b · who is actually changing the hive ───────────────────────────
//
// Deliberately SEPARATE from /api/hive/contributors: that one reads GitHub
// commits, so a bee whose patch merged through the funnel — with no GitHub
// identity at all — would be invisible there. This one reads the proposals.
// Registered before /:id so 'contributors' is a word, not an id.
router.get('/contributors', async (_req, res) => {
    const all = proposal.list({ limit: 500 });
    const by = new Map();
    const row = (who) => {
        if (!by.has(who)) {
            by.set(who, { id: who, proposals: 0, merged: 0, votes_received: 0 });
        }
        return by.get(who);
    };
    for (const p of all) {
        const who = p.node_id || p.principal;
        if (!who) continue;
        const r = row(who);
        r.proposals += 1;
        if (p.state === 'merged' || p.state === 'deployed') r.merged += 1;
        r.votes_received += Number(p.vote_count) || 0;
    }
    // A vote is also a contribution: someone who reviewed another bee's
    // proposal did work on it.
    for (const p of all) {
        for (const v of (p.votes || [])) {
            const who = v.node_id || v.principal;
            if (!who) continue;
            const r = row(who);
            if (!('votes_cast' in r)) r.votes_cast = 0;
            r.votes_cast += 1;
        }
    }
    const list = [...by.values()].sort((a, b) =>
        (b.merged - a.merged) || (b.proposals - a.proposals)
        || ((b.votes_cast || 0) - (a.votes_cast || 0)));
    res.json({
        contributors: list,
        count: list.length,
        source: 'proposals',
        note: 'bees who proposed, merged or reviewed — see /api/hive/contributors for GitHub commits',
    });
});

// ── STAGE 4c · the activity feed — what is going on, right now ──────────────
//
// Derived from fields we ALREADY store (created_at, votes[].at, each gate's
// at, merged_at) — no new tracking, nothing that can drift from the records
// it summarizes. Registered before /:id so 'activity' is a word, not an id.
router.get('/activity', (req, res) => {
    const wantRedTeam = req.query.red_team === '1' || req.query.red_team === 'true';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const all = proposal.list({ limit: 500 })
        .filter(p => wantRedTeam || !p.red_team);

    const events = [];
    const brief = (p) => ({ id: p.id, title: p.title, type: p.type,
        node_id: p.node_id, state: p.state });

    for (const p of all) {
        if (p.created_at) {
            events.push({ at: p.created_at, kind: 'filed', ...brief(p),
                verdict: p.verdict });
        }
        for (const v of (p.votes || [])) {
            if (v.at) {
                events.push({ at: v.at, kind: 'voted', ...brief(p),
                    by: v.node_id || v.principal, verdict: v.verdict || null });
            }
        }
        for (const g of proposal.GATE_ORDER) {
            const gate = (p.gates || {})[g];
            if (gate && gate.status === 'passed' && gate.at) {
                events.push({ at: gate.at, kind: 'gate', gate: g, ...brief(p) });
            }
        }
        if (p.merged_at) {
            events.push({ at: p.merged_at, kind: 'merged', ...brief(p) });
        }
        if (p.filed_at && p.issue_url) {
            events.push({ at: p.filed_at, kind: 'published', ...brief(p),
                issue_url: p.issue_url });
        }
    }

    events.sort((a, b) => (b.at || 0) - (a.at || 0));
    res.json({ events: events.slice(0, limit), count: Math.min(events.length, limit),
        total: events.length });
});
// ── STAGE 4 · the feedback loop ────────────────────────────────────────────
// What THIS caller sent, with where each one got to. Registered before
// /:id so 'mine' is a word, not an id.
router.get('/mine', async (req, res) => {
    const who = await _principal(req);
    const nodeId = _cleanId(req.headers['x-hivv-node'] || req.query.node);
    const all = proposal.list({ limit: 500 });
    const mine = all.filter(p =>
        (nodeId && p.node_id === nodeId) || (who && p.principal === who));
    const counts = {};
    for (const p of mine) counts[p.state] = (counts[p.state] || 0) + 1;
    res.json({
        proposals: mine,
        count: mine.length,
        counts,
        principal: who,
        node_id: nodeId,
        gates: proposal.GATE_ORDER,
    });
});

router.get('/:id', (req, res) => {
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    // The diff is 400 KB and never rides along on a read — but a reviewer
    // cannot judge a patch they cannot see, so it is one flag away.
    if (req.query.include_patch === '1' || req.query.include_patch === 'true') {
        const patch = proposal.patchOf(req.params.id);
        if (patch) return res.json({ ...p, patch });
    }
    res.json(p);
});

// ── THE STUDY: one proposal, and everything it touches ──────────────────────
//
// The assembly lives in lib/proposal-study.js so this route and the MCP
// `proposals` tool ask the SAME question and cannot drift apart in what
// they report.
router.get('/:id/study', async (req, res) => {
    const studyOf = require('../lib/proposal-study');
    let out;
    try {
        out = await studyOf.study(req.params.id);
    } catch (e) {
        console.error('[PROPOSAL] study failed for ' + req.params.id + ':', e.message);
        return res.status(500).json({ error: 'study unavailable' });
    }
    if (!out) return res.status(404).json({ error: 'proposal not found' });
    res.json(out);
});


router.get('/:id/verify', (req, res) => {
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    const v = proposal.verifyChain(p);
    res.status(v.ok ? 200 : 409).json({
        ok: v.ok,
        problems: v.problems,
        chain_hash: p.chain_hash,
        receipts: (p.receipts || []).length,
    });
});

// ── the gates ───────────────────────────────────────────────────────────────

// G1 · study
router.post('/:id/study', express.json({ limit: '1mb' }), async (req, res) => {
    const rl = _limit('w:' + _requester(req), WRITE_MAX, WRITE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'rate limit', retry_after_s: rl.retry_after_s });
    }
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!await _mayWrite(req, p)) return res.status(403).json({ error: 'not your proposal' });
    const out = proposal.study(req.params.id, (req.body || {}).evidence || {},
        { by: await _principal(req) });
    if (!out.ok) {
        const code = out.error === 'proposal not found' ? 404 : 409;
        return res.status(code).json(out);
    }
    res.json(out.proposal);
});

// G2 · authorize — the MACHINE asks the policy gate; the caller cannot
// assert an approval.
router.post('/:id/authorize', express.json({ limit: '256kb' }), async (req, res) => {
    const rl = _limit('w:' + _requester(req), WRITE_MAX, WRITE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'rate limit', retry_after_s: rl.retry_after_s });
    }
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!await _mayWrite(req, p)) return res.status(403).json({ error: 'not your proposal' });
    const out = await proposal.authorize(req.params.id, {
        principal: await _principal(req),
        by: await _principal(req),
    });
    if (out.verdict === 'MAYBE') return res.status(202).json(out);
    if (!out.ok) {
        const code = out.error === 'proposal not found' ? 404 : 409;
        return res.status(code).json(out);
    }
    res.json(out.proposal);
});

// G3 · test
router.post('/:id/test', express.json({ limit: '1mb' }), async (req, res) => {
    const rl = _limit('w:' + _requester(req), WRITE_MAX, WRITE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'rate limit', retry_after_s: rl.retry_after_s });
    }
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!await _mayWrite(req, p)) return res.status(403).json({ error: 'not your proposal' });
    const out = proposal.test(req.params.id, (req.body || {}).evidence || {},
        { by: await _principal(req) });
    if (!out.ok) {
        const code = out.error === 'proposal not found' ? 404 : 409;
        return res.status(code).json(out);
    }
    res.json(out.proposal);
});

// G4 · approve — the AUTHOR may not submit their own approvals. The machine
// enforces the rest (quorum, diversity, no self-approval, human for
// protected paths).
router.post('/:id/approve', express.json({ limit: '1mb' }), async (req, res) => {
    const rl = _limit('w:' + _requester(req), WRITE_MAX, WRITE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'rate limit', retry_after_s: rl.retry_after_s });
    }
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    const who = await _principal(req);
    if (!await _mayWrite(req, p)) {
        return res.status(403).json({ error: 'not your proposal' });
    }
    if (who && p.principal === who && !_isAdmin(req)) {
        return res.status(403).json({
            error: 'the author cannot approve their own proposal',
            hint: 'the hive (or a human) has to sign this one',
        });
    }
    const out = proposal.approve(req.params.id, (req.body || {}).evidence || {}, { by: who });
    if (!out.ok) {
        const code = out.error === 'proposal not found' ? 404 : 409;
        return res.status(code).json(out);
    }

    // ── STAGE 3/5 · an approved patch becomes a real branch + PR ────────
    //
    // This is the ONLY place a diff becomes a ref, and it happens through
    // the relay — the one credential holder. The branch name is
    // deterministic (hive/proposal-<id>), so a re-approval reuses it rather
    // than littering the repo, and the relay is idempotent on the marker.
    let pr = null;
    const patchText = proposal.patchOf(req.params.id);
    if (patchText.trim()) {
        try {
            pr = await githubRelay.ensurePR({
                id: req.params.id,
                title: (p.title || 'hive proposal').slice(0, 300),
                body: 'Approved by the hive.\n\nProposal: ' + req.params.id
                    + '\nVotes: ' + ((p.votes || []).length)
                    + '\nVerdict: ' + (p.verdict || 'unknown'),
                base: 'main',
                patch: patchText,
                // Authorized as the PROPOSAL'S AUTHOR, not the clicker. The
                // write is about their proposal, and they already consented
                // to github.write when they filed it — otherwise opening the
                // PR would ask a SECOND principal for a grant the first one
                // already gave, and every approved change would stall here.
                principal: p.principal,
            });
            if (pr && pr.ok) {
                proposal.fileIssue(req.params.id, {
                    issue_number: pr.number,
                    issue_url: pr.html_url,
                    filed_via: githubRelay.isStub() ? 'stub' : 'github',
                });
            }
        } catch (e) {
            // A PR that could not be opened does NOT un-approve the change —
            // the approval stands; the operator can open it by hand.
            pr = { ok: false, error: String(e.message).slice(0, 200) };
            console.error('[PROPOSAL] ensurePR failed for ' + req.params.id + ':', e.message);
        }
    }
    res.json({ ...out.proposal, pull_request: pr });
});

// G5 · merge — an operator merges. The machine refuses if anything is missing.
router.post('/:id/merge', express.json({ limit: '512kb' }), async (req, res) => {
    const rl = _limit('w:' + _requester(req), WRITE_MAX, WRITE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'rate limit', retry_after_s: rl.retry_after_s });
    }
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!_isAdmin(req)) {
        return res.status(403).json({
            error: 'merging needs an operator',
            hint: 'a human merges; the hive studies, tests and approves',
        });
    }
    const out = proposal.merge(req.params.id, (req.body || {}).evidence || {},
        { by: await _principal(req) });
    if (!out.ok) {
        const code = out.error === 'proposal not found' ? 404 : 409;
        return res.status(code).json(out);
    }

    // ── STAGE 5 · the closed loop ───────────────────────────────────────
    //
    // A merge is an operator asserting the GitHub PR landed. What happens
    // next is the EXISTING rails — deploy.sh carries its own test gate and
    // rollback, and sync-mirrors.sh regenerates the site — so this route
    // never invents a second deploy path. It either RUNS the real one (only
    // when an operator has explicitly opted in) or says exactly what to run.
    //
    // Default OFF on purpose: deploy.sh restarts THIS gateway, so an
    // accidental merge would take the request down mid-flight.
    let autodeploy = null;
    if (process.env.HIVV_PROPOSAL_AUTODEPLOY === '1') {
        autodeploy = _spawnDeploy(req.params.id);
    }

    // ── STAGE 4b · a merged proposal earns honey ────────────────────────
    //
    // The bee changed the hive's own source — a different contribution from
    // serving tokens, so it gets its own award. It writes the same ledger
    // the sweep does, so the leaderboard and the ranks pick it up with no
    // extra wiring. HUB-side only, and never the author's own call.
    let honeyAward = null;
    if (p.node_id) {
        try {
            const honey = require('../lib/honey');
            honeyAward = await honey.award(
                p.node_id, honey.HONEY_PER.proposal_merged);
        } catch (e) {
            honeyAward = { ok: false, reason: e.message };
        }
    }

    res.json({
        ...out.proposal,
        honey: honeyAward,
        next_step: {
            deploy: 'scripts/deploy.sh',
            mirrors: 'scripts/sync-mirrors.sh',
            nodes: 'hivv update   (picks it up on every bee)',
            autodeploy: autodeploy
                ? 'spawned — see ' + autodeploy.log
                : 'disabled — set HIVV_PROPOSAL_AUTODEPLOY=1 to run deploy.sh on merge',
        },
    });
});

// The deploy rails ran and the health check passed.
router.post('/:id/deployed', express.json({ limit: '128kb' }), async (req, res) => {
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!_isAdmin(req)) return res.status(403).json({ error: 'operator only' });
    const out = proposal.deployed(req.params.id, { by: await _principal(req) });
    if (!out.ok) return res.status(409).json(out);
    res.json(out.proposal);
});

// ── rejection ───────────────────────────────────────────────────────────────
router.post('/:id/reject', express.json({ limit: '64kb' }), async (req, res) => {
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    if (!await _mayWrite(req, p)) return res.status(403).json({ error: 'not your proposal' });
    const out = proposal.reject(req.params.id, {
        reason: (req.body || {}).reason,
        by: await _principal(req),
    });
    if (!out.ok) return res.status(409).json(out);
    res.json(out.proposal);
});

module.exports = router;

// Exported for the tests ONLY — never call these from a route. They are the
// two functions that decide who may act on a proposal, so they are the two
// that must be pinned (api/tests/proposal-auth.test.js).
router._auth = { _isAdmin, _principal, _mayWrite };
