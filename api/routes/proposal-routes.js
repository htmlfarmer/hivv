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

const CONTROL_TOKEN = process.env.HIVV_CONTROL_TOKEN || '';

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

async function _principal(req) {
    try {
        const serverPath = require.resolve('../server');
        if (require.cache[serverPath]) {
            const s = await require('../server').getSession(req);
            if (s && s.userId) return 'user:' + s.userId;
        }
    } catch (_e) { /* fall through */ }
    const v = req.headers['x-visitor-id'];
    return v ? String(v).slice(0, 128) : null;
}

function timingSafeEq(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length) return false;
    try { return crypto.timingSafeEqual(x, y); } catch (_e) { return false; }
}

function _isAdmin(req) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
    if (ip.includes('127.0.0.1') || ip.includes('::1')) return true;
    const t = req.headers['x-control-token'];
    return Boolean(CONTROL_TOKEN && t && timingSafeEq(t, CONTROL_TOKEN));
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
router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
    const rl = _limit('c:' + _requester(req), CREATE_MAX, CREATE_WINDOW_MS);
    if (!rl.allowed) {
        res.set('Retry-After', String(rl.retry_after_s || 60));
        return res.status(429).json({ error: 'proposal rate limit', retry_after_s: rl.retry_after_s });
    }
    const body = req.body || {};
    const principal = (await _principal(req)) || _requester(req);
    const out = proposal.create({
        principal,
        repo: body.repo,
        base_ref: body.base_ref,
        base_sha: body.base_sha,
        branch: body.branch,
        title: body.title,
        summary: body.summary,
        patch: body.patch,
        files_changed: body.files_changed,
        baseline_suite_digest: body.baseline_suite_digest,
        ttl_ms: body.ttl_ms,
    });
    if (!out.ok) return res.status(400).json({ error: out.error });
    console.log('[PROPOSAL] ' + out.proposal.id + ' intake (' +
        out.proposal.files_changed.length + ' files' +
        (out.proposal.protected_hit ? ', PROTECTED' : '') + ')');
    res.status(201).json(out.proposal);
});

// ── reads ───────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
    const state = req.query.state ? String(req.query.state) : null;
    const limit = parseInt(req.query.limit, 10) || 50;
    res.json({ proposals: proposal.list({ state, limit }) });
});

router.get('/stats', (req, res) => {
    const all = proposal.list({ limit: 500 });
    const counts = {};
    for (const p of all) counts[p.state] = (counts[p.state] || 0) + 1;
    res.json({ counts, total: all.length, gates: proposal.GATE_ORDER });
});

router.get('/:id', (req, res) => {
    const p = proposal.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'proposal not found' });
    res.json(p);
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
    res.json(out.proposal);
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
    res.json(out.proposal);
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
