// api/routes/github-routes.js — GitHub, server-side.
//
// WHY: the site's Content-Security-Policy is
//   connect-src 'self'  and  img-src 'self' data:
// so a browser fetch straight to api.github.com is BLOCKED, and a GitHub
// avatar never loads. The bugs page and the contributor roster were both
// running blind because of it.
//
// The hub has no CSP. So the hub fetches GitHub and serves it to the page:
//   GET /api/github/issues   the open issues of the repo (public, cached)
//   GET /api/github/avatar   one avatar, proxied (cached on disk)
//
// Both are PUBLIC data about a PUBLIC repo. Nothing here needs auth, and
// nothing here accepts a token from the caller.
//
// Mounted at /api/github — see api/server.js.

const express = require('express');
const router = express.Router();

const REPO = process.env.HIVV_GITHUB_REPO || 'htmlfarmer/hivv';
const UA = 'hivv.org (+https://hivv.org)';

// ── open issues ────────────────────────────────────────────────────────────
let _issuesCache = { at: 0, value: null };

async function fetchIssues() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/issues?state=open&per_page=30`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
      signal: AbortSignal.timeout(8000),
    });
  if (!res.ok) throw new Error('GitHub said ' + res.status);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error('unexpected GitHub payload');
  // Pull requests come back from the issues endpoint too. They are not
  // bugs, but a PR IS a bug being fixed - so both are listed and the page
  // says which is which. Hiding them would hide the work.
  return j.map((i) => ({
    number: i.number,
    title: i.title,
    html_url: i.html_url,
    created_at: i.created_at,
    comments: i.comments || 0,
    labels: (i.labels || []).map((l) => l.name),
    is_pr: !!i.pull_request,
  }));
}

router.get('/issues', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  if (_issuesCache.value && Date.now() - _issuesCache.at < 120000) {
    return res.json({ ok: true, repo: REPO, issues: _issuesCache.value });
  }
  try {
    const issues = await fetchIssues();
    _issuesCache = { at: Date.now(), value: issues };
    res.json({ ok: true, repo: REPO, issues });
  } catch (e) {
    // Serve the last good answer rather than an empty page. A stale list of
    // real bugs beats no list at all.
    if (_issuesCache.value) {
      return res.json({ ok: true, repo: REPO, issues: _issuesCache.value, stale: true });
    }
    res.status(502).json({ ok: false, error: 'GitHub unreachable', detail: String(e.message).slice(0, 160) });
  }
});

// ── avatars ────────────────────────────────────────────────────────────────
// The avatar URL is baked into the contributor records, so the page asks US
// for the image and we fetch it. The URL is validated against github.com
// only — this endpoint must never become an open proxy.
const _avatarCache = new Map();   // url -> {buf, type, at}
const AVATAR_TTL_MS = 60 * 60 * 1000;

function _avatarAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_e) { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'avatars.githubusercontent.com' || h === 'github.com' || h.endsWith('.githubusercontent.com');
}

router.get('/avatar', async (req, res) => {
  const raw = String(req.query.u || '').slice(0, 600);
  if (!_avatarAllowed(raw)) {
    return res.status(400).json({ error: 'not a github avatar url' });
  }
  const hit = _avatarCache.get(raw);
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', hit.type);
    return res.end(hit.buf);
  }
  try {
    const r = await fetch(raw, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const type = String(r.headers.get('content-type') || 'image/jpeg');
    if (!/^image\//.test(type)) throw new Error('not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 512 * 1024) throw new Error('avatar too large');
    _avatarCache.set(raw, { buf, type, at: Date.now() });
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', type);
    return res.end(buf);
  } catch (e) {
    res.status(502).json({ error: 'avatar unavailable', detail: String(e.message).slice(0, 120) });
  }
});

module.exports = router;
