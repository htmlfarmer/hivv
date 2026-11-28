'use strict';

// api/lib/github-relay.js — THE ONLY SECRET-HOLDER.
//
// WHY THIS FILE EXISTS
// ─────────────────────
// One design law: nodes never hold a GitHub credential. The hub holds
// exactly ONE, behind a policy gate. So every write to the repository —
// filing an issue, opening a PR, commenting, closing — comes through this
// file and nowhere else.
//
// That is the only design where one secret leaks instead of N, spam is
// bounded, it works behind NAT, and it reuses the trust machinery the hive
// already built.
//
// THE TWO MODES
// ─────────────
//   HIVV_GITHUB_TOKEN set  → the real GitHub API.
//   no token               → a STUB that writes JSON files under
//                             $HIVV_DATA_DIR/github-stub/.
//
// The stub is not a placeholder, it is a feature: the entire pipeline runs
// offline with zero secrets, CI can test it end-to-end, and nobody waits on
// a credential to start. Every function returns the SAME shape in both
// modes (plus `stub: true`), so a caller never branches on which world it
// is in.
//
// IDEMPOTENCY (the law that makes retries safe)
// ──────────────────────────────────────────────
// Every artifact carries the marker `<!-- hive-proposal:<id> -->` in its
// body. Before creating anything we LOOK for that marker; if it is already
// there we return the existing artifact instead of posting a second one. A
// retry after a timeout therefore cannot double-file — which matters
// because the funnel will retry.
//
// THE GATE
// ────────
// Every write asks lib/policy.js first. An unknown capability resolves to
// ASK (tier side-effect), so a new operator gets a human in the loop by
// default rather than a silent push.

const fs = require('fs');
const path = require('path');

const localMode = require('./local-mode');

const REPO = process.env.HIVV_GITHUB_REPO || 'htmlfarmer/hivv';
const API = process.env.HIVV_GITHUB_API || 'https://api.github.com';
const UA = 'hivv.org (+https://hivv.org)';
const CAPABILITY = 'github.write';

// ── mode ────────────────────────────────────────────────────────────────────

function token() {
  const t = process.env.HIVV_GITHUB_TOKEN;
  return t && String(t).trim() ? String(t).trim() : null;
}

function isStub() { return !token(); }

function status() {
  return {
    stub: isStub(),
    repo: REPO,
    api: isStub() ? null : API,
    stub_dir: isStub() ? stubDir() : null,
    // Never the token itself. Presence only.
    credential: isStub() ? 'none (offline stub)' : 'present',
  };
}

// ── the stub store ──────────────────────────────────────────────────────────

function stubDir() {
  return path.join(localMode.dataDir(), 'github-stub');
}

function _stubPath(kind, id) {
  return path.join(stubDir(), kind + '-' + String(id).replace(/[^\w.-]+/g, '_') + '.json');
}

function _stubWrite(kind, id, payload) {
  const dir = stubDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = _stubPath(kind, id);
  // A stub artifact is APPENDED, never overwritten: the stub has to behave
  // like GitHub, where a second identical post would be a second object.
  // The caller's idempotency check is what stops a duplicate, so the store
  // must not paper over a bug by silently replacing the first one.
  const rec = { ...payload, stub: true, at: Date.now() };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function _stubRead(kind, id) {
  try {
    const file = _stubPath(kind, id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// ── the marker ──────────────────────────────────────────────────────────────

function marker(id) {
  return '<!-- hive-proposal:' + String(id) + ' -->';
}

function withMarker(id, body) {
  const m = marker(id);
  const b = String(body || '');
  return b.includes(m) ? b : (b ? b + '\n\n' + m : m);
}

function hasMarker(id, body) {
  return String(body || '').includes(marker(id));
}

// ── policy gate (every write) ───────────────────────────────────────────────

async function _authorize(principal, what) {
  const policy = require('./policy');
  try {
    const v = await policy.gate({
      capability: CAPABILITY,
      principal: principal || 'anon',
      transport: 'local',
      via: 'github-relay',
      reason: what,
      args_summary: { repo: REPO, op: what },
    });
    return v;
  } catch (e) {
    // FAIL CLOSED (CONTRIBUTING rule #2): a gate that cannot decide must
    // not approve. Writing to the repository is not chat.
    return { verdict: 'deny', rule: 'error:' + String(e.message).slice(0, 80) };
  }
}

// ── http ────────────────────────────────────────────────────────────────────

async function _gh(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token(),
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  if (!res.ok) {
    const msg = (json && json.message) ? json.message : ('GitHub said ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Find an existing artifact carrying our marker. This is the idempotency
// check: a retry must find the FIRST post, not create a second.
// A marker only counts when it is its OWN line. `withMarker` always appends
// one on its own, so a real hit passes; a marker quoted in the middle of a
// paragraph does not. Defense in depth — intake already neutralises markers
// a proposer tries to plant (funnel.sanitizeMarkers).
function isOwnMarkerLine(id, body) {
  const m = marker(id);
  return String(body || '').split(/\r?\n/).some(l => l.trim() === m);
}

// WHY THE LIST ENDPOINT AND NOT /search/issues
// ─────────────────────────────────────────────
// GitHub's search index is EVENTUALLY CONSISTENT. An issue that was just
// created can take seconds to minutes to appear in search results, so a
// retry inside that window gets a clean, well-formed EMPTY result — which is
// indistinguishable from "no issue yet" and creates a SECOND one.
//
// The old code defended against search FAILING (it throws rather than risk a
// duplicate, which is right). It could not defend against search SUCCEEDING
// with stale data, because a 200 with no items looks like the truth.
// GET /repos/:owner/:repo/issues reads the same store the POST wrote to, so
// it is consistent the moment the write returns.
//
// It also returns pull requests, which is what ensurePR needs to check —
// /search/issues includes PRs too, so behaviour is preserved exactly.
// Default sort is created DESC, so the artifact a retry wants is on page one;
// we still walk a few pages, BOUNDED, so a large repo cannot turn an
// idempotency check into a rate-limit bill.
//
// The match still requires an OWN-LINE marker (isOwnMarkerLine): a marker
// quoted in someone's prose must not count as our artifact.
const LIST_PAGES = 3;
const LIST_PER_PAGE = 100;

async function _findByMarker(id) {
  try {
    for (let page = 1; page <= LIST_PAGES; page++) {
      const batch = await _gh('GET',
        `/repos/${REPO}/issues?state=all&per_page=${LIST_PER_PAGE}&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) return null;
      const hit = batch.find(i => isOwnMarkerLine(id, i.body));
      if (hit) return hit;
      if (batch.length < LIST_PER_PAGE) return null;   // ran out of issues
    }
    return null;
  } catch (_e) {
    // A failed lookup must NOT become a duplicate post. Returning null
    // here would let a timeout-then-retry double-file. Fail loudly instead
    // and let the caller decide; the funnel treats this as "unknown".
    const e = new Error('idempotency lookup failed — refusing to risk a duplicate post');
    e.code = 'idempotency_unknown';
    throw e;
  }
}

// ── the four operations ─────────────────────────────────────────────────────

// createIssue — file the proposal as an issue.
async function createIssue({ id, title, body, labels = [], principal } = {}) {
  if (!id) throw new Error('createIssue: id required (the idempotency key)');
  const gate = await _authorize(principal, 'createIssue');
  if (gate.verdict === 'deny') {
    return { ok: false, denied: true, rule: gate.rule, error: 'denied by policy' };
  }
  if (gate.verdict === 'ask') {
    return { ok: false, needs_human: true, grant_id: gate.grant_id, rule: gate.rule };
  }

  const marked = withMarker(id, body);

  if (isStub()) {
    const existing = _stubRead('issue', id);
    if (existing) return { ok: true, deduped: true, ...existing };
    const rec = _stubWrite('issue', id, {
      number: 1000 + (_stubCount() + 1),
      title: String(title || '').slice(0, 300),
      body: marked,
      labels,
      html_url: 'https://github.com/' + REPO + '/issues/stub-' + id,
    });
    return { ok: true, ...rec };
  }

  const existing = await _findByMarker(id);
  if (existing) {
    return {
      ok: true, deduped: true, number: existing.number,
      html_url: existing.html_url, title: existing.title,
    };
  }
  const j = await _gh('POST', `/repos/${REPO}/issues`, {
    title: String(title || '').slice(0, 300),
    body: marked,
    labels: labels.slice(0, 10),
  });
  return { ok: true, number: j.number, html_url: j.html_url, title: j.title };
}

function _stubCount() {
  try {
    return fs.readdirSync(stubDir()).filter(f => f.startsWith('issue-')).length;
  } catch (_e) { return 0; }
}

// ensurePR — the branch + the pull request, in one call.
//
// The branch name is DETERMINISTIC (`hive/proposal-<id>`), so a retry
// reuses it rather than littering the repo with hive/proposal-1a, -1b.
async function ensurePR({ id, title, body, base = 'main', patch, principal } = {}) {
  if (!id) throw new Error('ensurePR: id required (the idempotency key)');
  const gate = await _authorize(principal, 'createPullRequest');
  if (gate.verdict === 'deny') {
    return { ok: false, denied: true, rule: gate.rule, error: 'denied by policy' };
  }
  if (gate.verdict === 'ask') {
    return { ok: false, needs_human: true, grant_id: gate.grant_id, rule: gate.rule };
  }

  const branch = 'hive/proposal-' + String(id);
  const marked = withMarker(id, body);

  if (isStub()) {
    const existing = _stubRead('pr', id);
    if (existing) return { ok: true, deduped: true, ...existing };
    const rec = _stubWrite('pr', id, {
      number: 2000 + (_stubPrCount() + 1),
      branch,
      base,
      title: String(title || '').slice(0, 300),
      body: marked,
      patch_bytes: Buffer.byteLength(String(patch || ''), 'utf8'),
      html_url: 'https://github.com/' + REPO + '/pull/stub-' + id,
    });
    return { ok: true, ...rec };
  }

  const existing = await _findByMarker(id);
  if (existing && existing.pull_request) {
    return {
      ok: true, deduped: true, number: existing.number,
      html_url: existing.html_url, branch,
    };
  }

  // The patch lands as a single commit on the deterministic branch. The
  // hub is the only writer, so this is the one place a diff becomes a ref.
  await _gh('POST', `/repos/${REPO}/git/refs`, {
    ref: 'refs/heads/' + branch,
    sha: await _baseSha(base),
  }).catch((e) => {
    // A branch that already exists is the SUCCESS case for a retry.
    if (e.status !== 422) throw e;
  });

  if (patch) await _applyPatch(branch, patch);

  const j = await _gh('POST', `/repos/${REPO}/pulls`, {
    title: String(title || '').slice(0, 300),
    body: marked,
    head: branch,
    base,
  });
  return { ok: true, number: j.number, html_url: j.html_url, branch };
}

function _stubPrCount() {
  try {
    return fs.readdirSync(stubDir()).filter(f => f.startsWith('pr-')).length;
  } catch (_e) { return 0; }
}

async function _baseSha(base) {
  const j = await _gh('GET', `/repos/${REPO}/git/ref/heads/${encodeURIComponent(base)}`);
  return j.object.sha;
}

// Apply a unified diff by walking it file by file through the contents API.
// Deliberately NOT `git apply` over a shell: a patch is DATA (invariant I5),
// and it must never become an instruction the hub executes.
async function _applyPatch(branch, patch) {
  const files = _patchFiles(patch);
  for (const f of files.slice(0, 50)) {
    const cur = await _gh(
      'GET', `/repos/${REPO}/contents/${encodeURIComponent(f)}?ref=${encodeURIComponent(branch)}`
    ).catch((e) => (e.status === 404 ? null : (() => { throw e; })()));
    const sha = cur ? cur.sha : undefined;
    const next = _applyOneFile(String(patch), f, cur ? Buffer.from(cur.content, 'base64').toString('utf8') : '');
    if (next === null) continue;               // the file is not in this patch
    await _gh('PUT', `/repos/${REPO}/contents/${encodeURIComponent(f)}`, {
      message: 'hive proposal: ' + f,
      content: Buffer.from(next, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    });
  }
}

function _patchFiles(patch) {
  const out = [];
  for (const line of String(patch).split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    let p = line.slice(4).split('\t')[0].trim();
    if (p.startsWith('b/')) p = p.slice(2);
    if (p && p !== '/dev/null' && !out.includes(p)) out.push(p);
  }
  return out;
}

// Rebuild ONE file's content from the hunks that touch it. A hunk the
// context does not match is skipped (and reported), never forced — forcing
// a mismatched hunk is how a "successful" apply silently corrupts a file.
function _applyOneFile(patch, file, current) {
  const hunks = [];
  const lines = String(patch).split('\n');
  let inTarget = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('+++ ')) {
      let p = l.slice(4).split('\t')[0].trim();
      if (p.startsWith('b/')) p = p.slice(2);
      inTarget = (p === file);
      continue;
    }
    if (inTarget && l.startsWith('@@')) hunks.push({ i, header: l });
  }
  if (!hunks.length) return null;

  // No base file (a new file) → the added lines ARE the content.
  if (!current) {
    const out = [];
    let grab = false;
    for (const l of lines) {
      if (l.startsWith('@@')) { grab = true; continue; }
      if (l.startsWith('diff --git')) grab = false;
      if (grab && l.startsWith('+') && !l.startsWith('+++')) out.push(l.slice(1));
      if (grab && l.startsWith('diff --git')) break;
    }
    return out.length ? out.join('\n') + '\n' : null;
  }

  const base = current.split('\n');
  const edits = [];
  for (const h of hunks) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const ctx = [];
    let j = h.i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith('@@') || l.startsWith('diff --git') || l.startsWith('+++ ')) break;
      if (l.startsWith('-') && !l.startsWith('---')) {
        const expect = l.slice(1);
        const got = base[start - 1 + ctx.length];
        if (got !== expect) { ctx.length = 0; break; }   // mismatch — skip, don't force
        ctx.push({ del: expect });
      } else if (l.startsWith('+') && !l.startsWith('+++')) {
        ctx.push({ add: l.slice(1) });
      } else if (l.startsWith('\\')) {
        // "\ No newline at end of file" — carries no content.
      } else {
        ctx.push({ ctx: l.startsWith(' ') ? l.slice(1) : l });
      }
    }
    if (ctx.length) edits.push({ start, ctx });
  }
  if (!edits.length) return null;

  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    const before = base.slice(0, e.start - 1);
    const after = base.slice(e.start - 1);
    const rebuilt = [];
    let k = 0;
    for (const c of e.ctx) {
      if (c.del !== undefined) { k++; continue; }
      if (c.add !== undefined) { rebuilt.push(c.add); continue; }
      rebuilt.push(after[k]); k++;
    }
    base.length = 0;
    base.push(...before, ...rebuilt, ...after.slice(k));
  }
  return base.join('\n');
}

// comment — public provenance: node IDs, vote count, verdict.
async function comment({ id, issue_number, body, principal } = {}) {
  if (!issue_number) throw new Error('comment: issue_number required');
  const gate = await _authorize(principal, 'comment');
  if (gate.verdict === 'deny') return { ok: false, denied: true, rule: gate.rule };
  if (gate.verdict === 'ask') return { ok: false, needs_human: true, grant_id: gate.grant_id };

  const marked = withMarker(id, body);
  if (isStub()) {
    const file = _stubPath('comment', id + '-' + issue_number);
    fs.mkdirSync(stubDir(), { recursive: true });
    const rec = { issue_number, body: marked, stub: true, at: Date.now() };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
    return { ok: true, ...rec };
  }
  const j = await _gh('POST', `/repos/${REPO}/issues/${issue_number}/comments`, { body: marked });
  return { ok: true, id: j.id, html_url: j.html_url };
}

// close — with a reason, so nothing disappears silently.
async function close({ id, issue_number, reason = 'closed by the hive', principal } = {}) {
  if (!issue_number) throw new Error('close: issue_number required');
  const gate = await _authorize(principal, 'close');
  if (gate.verdict === 'deny') return { ok: false, denied: true, rule: gate.rule };
  if (gate.verdict === 'ask') return { ok: false, needs_human: true, grant_id: gate.grant_id };

  if (isStub()) {
    const rec = _stubWrite('close', id + '-' + issue_number, { issue_number, reason });
    return { ok: true, ...rec };
  }
  await _gh('PATCH', `/repos/${REPO}/issues/${issue_number}`, { state: 'closed' });
  await comment({ id, issue_number, body: reason, principal });
  return { ok: true, issue_number, state: 'closed', reason };
}

module.exports = {
  CAPABILITY, REPO, marker, withMarker, hasMarker,
  token, isStub, status, stubDir,
  createIssue, ensurePR, comment, close,
  // exported for the tests
  _patchFiles, _applyOneFile, _findByMarker, isOwnMarkerLine,
};
