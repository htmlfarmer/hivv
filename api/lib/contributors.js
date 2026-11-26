// api/lib/contributors.js — who is helping, published.
//
// WHY THIS EXISTS
// A distributed project lives or dies on people feeling their work counted.
// The honey leaderboard counts COMPUTE contribution (a bee that serves
// tokens). But a huge share of the real work is CODE — and code
// contribution was invisible: a contributor had no number, no card, no
// place on a page. GitHub knows the truth; this module surfaces it.
//
// WHAT IT DOES
// Reads the public GitHub API for the repo's contributors and commit
// activity, normalises it into a stable shape, and CACHES it. The cache is
// the important part: the GitHub API is rate-limited (60/hour unauthenticated
// per IP) and a public web page must never burn that budget on every
// visitor.
//
// PRIVACY / SAFETY
//   • Only PUBLIC GitHub data is read. Nothing is sent anywhere.
//   • No token is used, so there is no secret to leak — and the repo is
//     public, so the API works unauthenticated.
//   • The cache is keyed on the repo, and a failed fetch serves the LAST
//     GOOD cache rather than an error: a transient GitHub outage must not
//     take the contributors page down.

const https = require('https');

const REPO = process.env.HIVV_REPO || 'htmlfarmer/hivv';
const API = 'https://api.github.com';

const TTL_MS = Number(process.env.HIVV_CONTRIB_TTL_MS || 30 * 60 * 1000); // 30 min
const TIMEOUT_MS = Number(process.env.HIVV_CONTRIB_TIMEOUT_MS || 8000);

let _cache = null;        // { ts, data }
let _inflight = null;     // in-flight promise (no thundering herd)

function _get(path) {
  return new Promise((resolve) => {
    const req = https.request(`${API}/repos/${REPO}${path}`, {
      method: 'GET',
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': 'hivv-hub',
        'x-github-api-version': '2022-11-28',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
        try { return resolve({ ok: true, data: JSON.parse(body) }); }
        catch (_e) { return resolve({ ok: false, status: 'parse' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout' }); });
    req.on('error', () => resolve({ ok: false, status: 'error' }));
    req.end();
  });
}

function _normContributor(c) {
  return {
    login: c.login || '?',
    name: c.name || null,
    // The avatar goes through the HUB, not straight to github: the CSP is
    // img-src 'self' data:, so a browser can never load an avatar from
    // avatars.githubusercontent.com. Handing out the proxy URL keeps the raw
    // github URL out of the page entirely - the page escapes it as before.
    avatar_url: c.avatar_url
      ? '/api/github/avatar?u=' + encodeURIComponent(c.avatar_url)
      : null,
    html_url: c.html_url || `https://github.com/${c.login}`,
    contributions: Number(c.contributions) || 0,
    type: c.type || 'User',
  };
}

// Fetch a full picture: contributors + repo + recent commit activity.
async function _fetchAll() {
  const [contribs, repo] = await Promise.all([
    _get('/contributors?per_page=100&anon=0'),
    _get(''),
  ]);

  const list = (contribs.ok && Array.isArray(contribs.data))
    ? contribs.data.map(_normContributor)
    : [];

  // The commit-activity endpoint is expensive to compute on GitHub's side
  // and 202s for a young repo, so it is optional: the contributor list is
  // the important half.
  let weekly = [];
  const acts = await _get('/stats/commit_activity');
  if (acts.ok && Array.isArray(acts.data)) {
    weekly = acts.data.slice(-12).map(w => ({ week: w.week, total: w.total }));
  }

  const total = list.reduce((s, c) => s + c.contributions, 0);

  return {
    repo: REPO,
    repo_url: repo.ok && repo.data ? repo.data.html_url : `https://github.com/${REPO}`,
    stars: repo.ok && repo.data ? (repo.data.stargazers_count || 0) : 0,
    forks: repo.ok && repo.data ? (repo.data.forks_count || 0) : 0,
    open_issues: repo.ok && repo.data ? (repo.data.open_issues_count || 0) : 0,
    description: repo.ok && repo.data ? (repo.data.description || '') : '',
    contributors: list,
    contributor_count: list.length,
    total_commits: total,
    weekly_activity: weekly,
    fetched_at: new Date().toISOString(),
  };
}

// Public entry point. Serves the cache when fresh; otherwise fetches.
// A failed fetch serves the LAST GOOD cache (never an error to a visitor)
// and, if there is no cache at all, a well-formed empty result.
async function get({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cache.ts) < TTL_MS) {
    return { ..._cache.data, cached: true };
  }
  // one fetch at a time — a burst of page views must not become a burst of
  // GitHub API calls (and would trip the rate limit anyway)
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const data = await _fetchAll();
      if (!data.contributors.length && _cache) {
        // a fetch that returns nothing (rate limited) must NOT wipe a good
        // cache — that would blank the page because someone else burned the
        // rate limit
        return { ..._cache.data, cached: true, stale: true };
      }
      _cache = { ts: Date.now(), data };
      return { ...data, cached: false };
    } catch (_e) {
      if (_cache) return { ..._cache.data, cached: true, stale: true };
      return {
        repo: REPO,
        repo_url: `https://github.com/${REPO}`,
        contributors: [],
        contributor_count: 0,
        total_commits: 0,
        weekly_activity: [],
        stars: 0, forks: 0, open_issues: 0,
        description: '',
        fetched_at: new Date().toISOString(),
        unavailable: true,
      };
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

// A tiny SVG "contributor wall" — embeddable, cached by the CDN, and
// readable in a dark terminal. It shows the top hands by commit count.
function shareCardSvg(data) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const W = 640, H = 200;
  const top = (data.contributors || []).slice(0, 5);
  const rows = top.map((c, i) => {
    const y = 92 + i * 22;
    const bar = Math.round(220 * (c.contributions / (top[0]?.contributions || 1)));
    return `<text x="28" y="${y}" fill="#e6edf3" font-family="monospace" font-size="13">${esc(c.login.slice(0, 18))}</text>`
      + `<rect x="180" y="${y - 11}" width="${bar}" height="12" rx="3" fill="#58a6ff"/>`
      + `<text x="${188 + bar}" y="${y}" fill="#8b949e" font-family="monospace" font-size="12">${c.contributions}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#0d1117"/>
<text x="28" y="44" fill="#e6edf3" font-family="monospace" font-size="20" font-weight="bold">HIVV contributors</text>
<text x="28" y="66" fill="#8b949e" font-family="monospace" font-size="12">${esc(REPO)} · ${data.contributor_count} contributor(s) · ${data.total_commits} commit(s)</text>
${rows}</svg>`;
}

module.exports = { get, shareCardSvg, REPO };
