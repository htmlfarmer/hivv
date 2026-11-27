// api/lib/github-relay.js — the hive's ONE door to GitHub.
//
// WHY THIS EXISTS
// ───────────────
// A hive node can spot a real bug in the system it runs, and today it can do
// nothing about it. `hivv help submit suggestion` POSTs to /api/feedback,
// which lands in Postgres and NEVER LEAVES — the idea dies in a table. The
// actual source of truth is github.com/htmlfarmer/hivv, where CONTRIBUTING.md
// says branch → PR → deploy.sh.
//
// This is Stage 3 of the proposal funnel: the only component that holds a
// GitHub credential, and the only one that writes to api.github.com. Every
// other stage (verify → rate-limit → dedupe → screen → review → policy) is
// deliberately upstream of here, so this file stays small and boring.
//
// THE LAW IT ENFORCES
// ───────────────────
//   • Nodes NEVER hold a GitHub credential. One hub-side token, or none.
//   • No token → STUB MODE. Every write lands as a JSON file under
//     localMode.dataDir()/github-stub/. Zero network, zero secrets, no
//     GitHub account — which is the whole reason this exists as a module
//     instead of an inline fetch in server.js: the funnel can be built,
//     demoed and CI-tested BEFORE anyone issues a credential, and a clone
//     with no internet still runs (local-first, CONTRIBUTING rule #4).
//   • Idempotent. A proposal carries an invisible marker in its issue body,
//     and that marker IS the dedupe key — a retry, a re-submit, or a second
//     node with the same idea can never double-post.
//   • Every result says which mode produced it. A stub URL looks like
//     `stub://…` on purpose: nothing may pretend to be a real GitHub issue.
//
// ENVELOPE SCHEMA — v1 (confirmed; pinned by api/tests/github-relay.test.js)
// ──────────────────────────────────────────────────────────────────────────
// The relay takes the INNER proposal object. Signature verification is
// Stage 2's job (node-auth + attest); this module only enforces SHAPE.
//
//   {
//     "v":            1,
//     "kind":         "proposal",
//     "type":         "suggestion" | "bug" | "patch" | "complaint"
//                    | "help_request" | "praise" | "other",
//     "title":        string   ≤ 200, non-empty,
//     "body":         string   non-empty ≤ 20 000, the actual idea,
//     "evidence":     string   optional ≤ 4000  (same cap hivv_feedback uses),
//     "patch":        string   unified diff; REQUIRED when type === "patch",
//     "patch_sha256": string   64 hex — integrity over the FULL patch bytes,
//     "target":       string   optional ≤ 200, what is being flagged,
//     "node_id":      string   optional ≤ 100,
//     "ts":           integer  optional, unix seconds
//   }
//
// It wraps into the existing signed-envelope machinery with ZERO new crypto:
//
//   attest.buildEnvelope({
//     kind:    'proposal',                       // +1 line in attest.KINDS
//     subject: dedupeKey(title, body),           // 64 hex
//     issuer:  <hivv principal>,
//     body:    proposal
//   })
//
// Two deliberate design choices, both worth arguing about:
//
//   1. subject == dedupeKey. The dedupe key is the SIGNATURE subject, so
//      "same idea" is not a fuzzy match — it is a cryptographic identity.
//      Five bees signing the same normalized title+body derive the SAME
//      subject and therefore land on ONE issue with a +5 vote count. That
//      is the hive's actual advantage over one human filing issues.
//   2. patch_sha256 is NOT part of the subject. The idea and the patch are
//      different things: a second, DIFFERENT patch for the same idea must
//      not be silently merged into the first. It gets commented onto the
//      existing issue instead (see `patch_appended` in relayProposal).
//
// PRIVACY / SAFETY
//   • The token is read from the environment at call time and never
//     logged, never put in a URL, never written to disk.
//   • The stub writes only to localMode.dataDir() (0700, gitignored).
//   • Issue bodies are capped at 60 000 chars — GitHub's limit is 65 536,
//     and a runaway patch must never be the reason a proposal fails.
//   • Labels are best-effort: GitHub ignores labels the repo has not
//     defined, so `hive-proposal` is a one-time repo setup step, not a
//     runtime dependency.

const fs = require('fs');
const path = require('path');
const https = require('https');

const localMode = require('./local-mode');
const attest = require('./attest');

// ── constants ─────────────────────────────────────────────────────────────

const SCHEMA_V = 1;
const PROPOSAL_KIND = 'proposal';
const REPO = process.env.HIVV_REPO || 'htmlfarmer/hivv';
const LABEL = 'hive-proposal';

const TYPES = ['suggestion', 'bug', 'patch', 'complaint',
               'help_request', 'praise', 'other'];

const MAX_TITLE = 200;
const MAX_BODY_TEXT = 20000;     // the idea itself — long enough for a real bug report
const MAX_EVIDENCE = 4000;
const MAX_TARGET = 200;
const MAX_NODE_ID = 100;
const MAX_PATCH_BYTES = 64 * 1024;   // refuse a patch we cannot faithfully store
const MAX_BODY = 60000;              // GitHub's issue body limit is 65536

const API = 'https://api.github.com';

// ── mode ──────────────────────────────────────────────────────────────────
//
// 'real' only when a token is present AND stub mode was not forced. Tests
// and offline clones must never be able to reach GitHub by accident, so
// HIVV_GITHUB_STUB=1 wins over a token that happens to be in the env.

function getMode() {
  if (String(process.env.HIVV_GITHUB_STUB || '').toLowerCase()
      === '1') return 'stub';
  return process.env.HIVV_GITHUB_TOKEN ? 'real' : 'stub';
}

function stubDir() {
  const explicit = process.env.HIVV_GITHUB_STUB_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(localMode.dataDir(), 'github-stub');
}

// ── identity: the dedupe key is the signature subject ────────────────────

function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 64 lowercase hex. Whitespace/case-insensitive so "Fix  the tools" and
// "fix the tools" are the same idea — that is the point of dedupe.
function dedupeKey(title, body) {
  return attest.sha256Hex(`${normalize(title)}\n${normalize(body)}`);
}

function proposalMarker(key) {
  return `<!-- hive-proposal:${key} -->`;
}

function patchMarker(sha) {
  return `<!-- hive-patch-sha256:${sha} -->`;
}

function markerFromBody(body, re) {
  const m = re.exec(String(body || ''));
  return m ? m[1] : null;
}

// ── validation ────────────────────────────────────────────────────────────
//
// Returns { ok, problems } and never throws: a malformed proposal is a
// normal, expected input (a bee wrote it), not an exception.

function _str(v) { return typeof v === 'string' ? v : null; }

function validateProposal(p) {
  const problems = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, problems: ['proposal must be an object'] };
  }

  if (p.v !== SCHEMA_V) problems.push(`v must be ${SCHEMA_V}`);
  if (p.kind !== PROPOSAL_KIND) problems.push(`kind must be "${PROPOSAL_KIND}"`);

  if (!TYPES.includes(p.type)) {
    problems.push(`type must be one of: ${TYPES.join(', ')}`);
  }

  const title = _str(p.title);
  if (!title || !title.trim()) problems.push('title is required');
  else if (title.length > MAX_TITLE) {
    problems.push(`title too long (${title.length} > ${MAX_TITLE})`);
  }

  const body = _str(p.body);
  if (!body || !body.trim()) problems.push('body is required');
  else if (body.length > MAX_BODY_TEXT) {
    problems.push(`body too long (${body.length} > ${MAX_BODY_TEXT})`);
  }

  if (p.evidence !== undefined && p.evidence !== null) {
    const ev = _str(p.evidence);
    if (ev === null) problems.push('evidence must be a string');
    else if (ev.length > MAX_EVIDENCE) {
      problems.push(`evidence too long (${ev.length} > ${MAX_EVIDENCE})`);
    }
  }

  if (p.target !== undefined && p.target !== null) {
    const t = _str(p.target);
    if (t === null) problems.push('target must be a string');
    else if (t.length > MAX_TARGET) {
      problems.push(`target too long (${t.length} > ${MAX_TARGET})`);
    }
  }

  if (p.node_id !== undefined && p.node_id !== null) {
    const n = _str(p.node_id);
    if (n === null) problems.push('node_id must be a string');
    else if (n.length > MAX_NODE_ID) {
      problems.push(`node_id too long (${n.length} > ${MAX_NODE_ID})`);
    }
  }

  if (p.ts !== undefined && p.ts !== null
      && !Number.isSafeInteger(p.ts)) {
    problems.push('ts must be an integer (unix seconds)');
  }

  const patch = p.patch === undefined || p.patch === null ? null : _str(p.patch);
  if (p.patch !== undefined && p.patch !== null && patch === null) {
    problems.push('patch must be a string');
  }
  if (p.type === 'patch' && !patch) {
    problems.push('type "patch" requires a patch');
  }
  if (patch && Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    problems.push(`patch too large (${Buffer.byteLength(patch, 'utf8')} > `
      + `${MAX_PATCH_BYTES} bytes)`);
  }

  // Integrity: if the sender told us the patch hash, it must match. This
  // catches a patch edited between signing and relay — cheap, and it is the
  // difference between "we relayed what was signed" and "we relayed what
  // arrived".
  if (p.patch_sha256 !== undefined && p.patch_sha256 !== null) {
    const sha = _str(p.patch_sha256);
    if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) {
      problems.push('patch_sha256 must be 64 lowercase hex');
    } else if (patch) {
      const actual = attest.sha256Hex(patch);
      if (actual !== sha) {
        problems.push('patch_sha256 does not match the patch');
      }
    }
  } else if (patch) {
    problems.push('patch requires patch_sha256');
  }

  return { ok: problems.length === 0, problems };
}

// ── rendering ─────────────────────────────────────────────────────────────
//
// Markdown for the GitHub issue body. The two HTML markers go FIRST so they
// survive any truncation — a truncated body must still be findable by
// findIssueByMarker(), or idempotency silently breaks.

function renderProposalBody(p, opts = {}) {
  const key = opts.key || dedupeKey(p.title, p.body);
  const marker = proposalMarker(key);
  const patchSha = p.patch_sha256 ? patchMarker(p.patch_sha256) : '';
  const mode = opts.mode || getMode();

  const sections = [];
  sections.push(marker);
  if (patchSha) sections.push(patchSha);
  sections.push(`**Hive proposal** · \`${p.type}\` · schema v${SCHEMA_V}`);
  sections.push('');
  sections.push('### What the hive said');
  sections.push('');
  sections.push(String(p.body || '').trim());

  if (p.target) {
    sections.push('');
    sections.push('### Target');
    sections.push('');
    sections.push(String(p.target).trim());
  }

  if (p.evidence) {
    sections.push('');
    sections.push('### Evidence');
    sections.push('');
    sections.push(String(p.evidence).trim());
  }

  if (p.patch) {
    sections.push('');
    sections.push('### Patch');
    sections.push('');
    sections.push('```diff');
    sections.push(String(p.patch).replace(/\s+$/, ''));
    sections.push('```');
  }

  sections.push('');
  sections.push('---');
  sections.push(
    `node \`${p.node_id || 'unknown'}\` · ${p.ts ? `ts ${p.ts}` : 'ts unknown'}`
    + ` · relayed in ${mode} mode`);

  let out = sections.join('\n');
  if (out.length > MAX_BODY) {
    // Keep the head (markers + idea), cut the tail (the patch), and say so.
    // The suffix is counted FIRST: an ellipsis that overshoots the limit
    // would make the cap a suggestion rather than a cap.
    const suffix = '\n\n… [body truncated by the relay — patch omitted, '
      + 'full patch is attached to the proposal record]';
    out = out.slice(0, Math.max(0, MAX_BODY - suffix.length))
      // never leave a lone surrogate behind (emoji in a proposal body)
      .replace(/[\uD800-\uDBFF]$/, '') + suffix;
  }
  return out;
}

// ── transport: one request function, two implementations ─────────────────
//
// Both modes answer { status, data }:
//   status — HTTP code, or 0 when the network failed outright
//   data   — parsed JSON body (or { error } on failure)
// Never throws: callers branch on status, and a GitHub outage must surface
// as a status code the funnel can retry, not as an exception in a request.

// ALWAYS a promise, in both modes. The stub is synchronous by nature (it is
// a file write), but a transport that is sometimes-sync is a trap for every
// caller — so the seam normalises the return shape here, once.
function _request(method, apiPath, body) {
  if (getMode() === 'stub') {
    // .then() rather than Promise.resolve(): a sync throw inside the stub
    // (a full disk, a locked temp dir) must become a REJECTION, not an
    // exception thrown from the caller's await.
    return Promise.resolve().then(() => _stubRequest(method, apiPath, body));
  }
  return _realRequest(method, apiPath, body);
}

function _realRequest(method, apiPath, body) {
  const token = process.env.HIVV_GITHUB_TOKEN;
  if (!token) return Promise.resolve({ status: 0, data: { error: 'no token' } });

  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'hivv-hub',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(`${API}${apiPath}`, {
        method, headers, timeout: 15000,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
          resolve({ status: res.statusCode, data });
        });
      });
    } catch (e) {
      resolve({ status: 0, data: { error: e.message } });
      return;
    }
    req.on('error', (e) => resolve({ status: 0, data: { error: e.message } }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── the stub ──────────────────────────────────────────────────────────────
//
// The same endpoint shapes as the real API, backed by three JSON files, so
// the calling code has no idea which mode it is in. Issue and PR numbers
// share one sequence (as GitHub does), starting at 1000 so a stub number can
// never be mistaken for a real one.

const STUB_START = 1000;

function _stubFile(name) { return path.join(stubDir(), `${name}.json`); }

function _readStub(name, fallback) {
  try {
    const raw = fs.readFileSync(_stubFile(name), 'utf8');
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_) { return fallback; }
}

function _writeStub(name, value) {
  const dir = stubDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = _stubFile(name) + `.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, _stubFile(name));
}

function _nextNumber(state) {
  let max = STUB_START;
  for (const i of state.issues) max = Math.max(max, i.number || 0);
  for (const p of state.prs) max = Math.max(max, p.number || 0);
  return max + 1;
}

function _stubState() {
  return {
    issues: _readStub('issues', []),
    refs: _readStub('refs', {}),
    prs: _readStub('pulls', []),
  };
}

function _parsePath(apiPath) {
  const [p, query] = String(apiPath).split('?');
  const params = {};
  if (query) {
    for (const kv of query.split('&')) {
      const [k, v] = kv.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { p: p.replace(/\/+$/, ''), params };
}

function _stubRequest(method, apiPath, body) {
  const { p, params } = _parsePath(apiPath);
  const m = String(method).toUpperCase();
  const state = _stubState();

  // POST /repos/:repo/issues
  if (m === 'POST' && p === `/repos/${REPO}/issues`) {
    const number = _nextNumber(state);
    const issue = {
      number,
      title: String((body && body.title) || ''),
      body: String((body && body.body) || ''),
      labels: Array.isArray(body && body.labels) ? body.labels.slice() : [],
      state: 'open',
      comments: [],
      created_at: new Date().toISOString(),
      // Deliberately fake scheme: a stub must never look like a real issue.
      html_url: `stub://github.com/${REPO}/issues/${number}`,
      mode: 'stub',
    };
    state.issues.push(issue);
    _writeStub('issues', state.issues);
    return { status: 201, data: issue };
  }

  // GET /repos/:repo/issues?labels=&state=  (list — used for marker lookup)
  if (m === 'GET' && p === `/repos/${REPO}/issues`) {
    const wantLabel = params.labels || null;
    const wantState = params.state || 'open';
    const list = state.issues.filter((i) => {
      if (wantState !== 'all' && i.state !== wantState) return false;
      if (wantLabel && !i.labels.includes(wantLabel)) return false;
      return true;
    }).map(({ comments, ...rest }) => rest);   // the real API has no comments here
    return { status: 200, data: list };
  }

  // POST /repos/:repo/issues/:n/comments
  let m2 = p.match(new RegExp(`^/repos/[^/]+/[^/]+/issues/(\\d+)/comments$`));
  if (m2 && m === 'POST') {
    const issue = state.issues.find((i) => i.number === Number(m2[1]));
    if (!issue) return { status: 404, data: { message: 'Not Found' } };
    const c = {
      id: issue.comments.length + 1,
      body: String((body && body.body) || ''),
      created_at: new Date().toISOString(),
      mode: 'stub',
    };
    issue.comments.push(c);
    _writeStub('issues', state.issues);
    return { status: 201, data: c };
  }
  if (m2 && m === 'GET') {
    const issue = state.issues.find((i) => i.number === Number(m2[1]));
    if (!issue) return { status: 404, data: { message: 'Not Found' } };
    return { status: 200, data: issue.comments };
  }

  // PATCH /repos/:repo/issues/:n
  m2 = p.match(new RegExp(`^/repos/[^/]+/[^/]+/issues/(\\d+)$`));
  if (m2 && m === 'PATCH') {
    const issue = state.issues.find((i) => i.number === Number(m2[1]));
    if (!issue) return { status: 404, data: { message: 'Not Found' } };
    if (body && body.state) issue.state = String(body.state);
    if (body && body.title !== undefined) issue.title = String(body.title);
    if (body && body.body !== undefined) issue.body = String(body.body);
    if (body && Array.isArray(body.labels)) issue.labels = body.labels.slice();
    _writeStub('issues', state.issues);
    return { status: 200, data: issue };
  }

  // POST /repos/:repo/git/refs
  if (m === 'POST' && p === `/repos/${REPO}/git/refs`) {
    const ref = String((body && body.ref) || '');
    const sha = String((body && body.sha) || '');
    if (!/^refs\/heads\/[\w./-]+$/.test(ref)) {
      return { status: 422, data: { message: 'invalid ref' } };
    }
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return { status: 422, data: { message: 'sha must be 64 hex' } };
    }
    if (state.refs[ref]) {
      return { status: 422, data: { message: 'Reference already exists' } };
    }
    state.refs[ref] = { sha, created_at: new Date().toISOString() };
    _writeStub('refs', state.refs);
    return { status: 201, data: { ref } };
  }

  // POST /repos/:repo/pulls
  if (m === 'POST' && p === `/repos/${REPO}/pulls`) {
    const number = _nextNumber(state);
    const pr = {
      number,
      title: String((body && body.title) || ''),
      body: String((body && body.body) || ''),
      head: String((body && body.head) || ''),
      base: String((body && body.base) || 'main'),
      state: 'open',
      created_at: new Date().toISOString(),
      html_url: `stub://github.com/${REPO}/pull/${number}`,
      mode: 'stub',
    };
    state.prs.push(pr);
    _writeStub('pulls', state.prs);
    return { status: 201, data: pr };
  }

  return { status: 404, data: { message: `stub: no route for ${m} ${p}` } };
}

// ── public operations ─────────────────────────────────────────────────────

function createIssue({ title, body, labels = [] }) {
  return _request('POST', `/repos/${REPO}/issues`, { title, body, labels });
}

// Look a proposal up by its marker. Uses the issues LIST endpoint (label +
// state), not the search endpoint: GitHub's search index lags by seconds to
// minutes, and an idempotency key that is eventually consistent will
// double-post under retry.
function findIssueByMarker(marker) {
  return _request(
    'GET', `/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=100`)
    .then(({ status, data }) => {
      if (status !== 200 || !Array.isArray(data)) {
        return { status, data: null };
      }
      const hit = data.find((i) => String(i.body || '').includes(marker));
      return { status, data: hit || null };
    });
}

function comment(issueNumber, body) {
  return _request('POST',
    `/repos/${REPO}/issues/${Number(issueNumber)}/comments`, { body });
}

function closeIssue(issueNumber) {
  return _request('PATCH', `/repos/${REPO}/issues/${Number(issueNumber)}`,
    { state: 'closed' });
}

function createBranch(name, sha) {
  if (!/^[\w./-]+$/.test(String(name)) || String(name).includes('..')) {
    return Promise.resolve({ status: 422,
      data: { error: 'invalid branch name' } });
  }
  return _request('POST', `/repos/${REPO}/git/refs`,
    { ref: `refs/heads/${name}`, sha });
}

function openPullRequest({ title, body, head, base = 'main' }) {
  return _request('POST', `/repos/${REPO}/pulls`, { title, body, head, base });
}

// ── the composite: one proposal → exactly one issue ──────────────────────
//
// The whole point of the module. In order:
//   1. shape-check (never throws — a bad proposal is normal input)
//   2. derive the key + marker
//   3. LOOK FIRST. If an issue already carries this marker, we are done:
//      deduped = true, no new issue. Same idea from another bee, or a
//      retried submit, both land here.
//   4. if the existing issue carries a DIFFERENT patch hash, the idea is the
//      same but the fix is not — append the new diff as a comment rather
//      than pretending they are the same change.
//   5. otherwise create the issue.
//
// Returns { ok, mode, deduped, number, url, marker, problems? }.

async function relayProposal(proposal, opts = {}) {
  const mode = getMode();
  const check = validateProposal(proposal);
  if (!check.ok) {
    return { ok: false, mode, deduped: false, problems: check.problems };
  }

  const key = dedupeKey(proposal.title, proposal.body);
  const marker = proposalMarker(key);
  const labels = [LABEL, proposal.type, ...(opts.labels || [])];

  const found = await findIssueByMarker(marker);
  if (found.status === 0) {
    // Could not reach GitHub at all (or the stub dir is unreadable). Report
    // it plainly — the funnel upstream decides whether to retry.
    return { ok: false, mode, deduped: false, marker,
      problems: [`could not list issues: ${JSON.stringify(found.data)}`] };
  }

  if (found.data) {
    const existingSha = markerFromBody(
      found.data.body, /<!-- hive-patch-sha256:([0-9a-f]{64}) -->/);
    const newSha = proposal.patch_sha256 || null;

    if (newSha && existingSha && newSha !== existingSha) {
      // Same idea, different fix: keep both visible, add no second issue.
      const appended = await comment(found.data.number,
        renderProposalBody(proposal, { key, mode })
        + `\n\n> A different patch for this same proposal arrived — `
        + `carried forward as a comment so neither fix is lost.`);
      return { ok: appended.status < 400, mode, deduped: true,
        patch_appended: true, number: found.data.number,
        url: found.data.html_url, marker };
    }

    return { ok: true, mode, deduped: true, patch_appended: false,
      number: found.data.number, url: found.data.html_url, marker };
  }

  const created = await createIssue({
    title: `[hive] ${String(proposal.title).trim().slice(0, MAX_TITLE)}`,
    body: renderProposalBody(proposal, { key, mode }),
    labels,
  });

  if (created.status < 200 || created.status >= 300 || !created.data) {
    return { ok: false, mode, deduped: false, marker,
      problems: [`issue create failed: HTTP ${created.status} `
        + `${(created.data && (created.data.message || created.data.error)) || ''}`] };
  }

  return {
    ok: true, mode, deduped: false,
    number: created.data.number,
    url: created.data.html_url,
    marker, labels,
  };
}

module.exports = {
  SCHEMA_V,
  PROPOSAL_KIND,
  REPO,
  LABEL,
  TYPES,
  MAX_TITLE,
  MAX_BODY_TEXT,
  MAX_EVIDENCE,
  MAX_PATCH_BYTES,
  MAX_BODY,
  getMode,
  stubDir,
  normalize,
  dedupeKey,
  proposalMarker,
  patchMarker,
  validateProposal,
  renderProposalBody,
  createIssue,
  findIssueByMarker,
  comment,
  closeIssue,
  createBranch,
  openPullRequest,
  relayProposal,
  // exposed for tests only — do not call from routes
  _stubRequest,
};
