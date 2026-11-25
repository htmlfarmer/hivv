// api/lib/version-date.js — WHEN was each CLI version built?
//
// The VERSION column of `hivv nodes` shows a content hash (0.2.55b5bca1):
// perfect for equality, meaningless to a human — "is that from last week
// or last month?" (asked 2026-11-23). A hash IS a git blob: the hub sits
// in a checkout, so it can map every version sha8 back to the COMMIT that
// shipped it and hand out "2026-11-22 14:33".
//
// Design:
//   * one `git log` (H|ISO pairs) + one `git cat-file` per commit that
//     ever touched the file, scanned NEWEST FIRST (the live versions are
//     the newest commits, so the common case is 1-2 calls), cached for the
//     process lifetime;
//   * a version that is NOT in history (uncommitted worktree served live)
//     → rebuilds at most ONCE per unknown sha, then answers null until it
//     becomes a real commit — no rebuild storms;
//   * no .git (public hub installs) or git absent → null for everything,
//     the nodes table shows '—'. Never throws: a date is a nicety, not a
//     reason to fail a status page.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLI_REL = path.join('public_html', 'hivv-cli.py');
const REPO_ROOT = path.join(__dirname, '..', '..');

let _map = null;          // sha8 -> 'YYYY-MM-DD HH:MM'
let _revs = null;         // [[rev, iso], …] newest first
let _lastMiss = '';       // last unknown sha we already rebuilt for
let _lastBuildMs = 0;

function _fmt(iso) {
  // '2026-11-22T14:33:44-08:00' → '2026-11-22 14:33' (author date, own tz)
  return String(iso || '').slice(0, 16).replace('T', ' ');
}

function _git(args, root = REPO_ROOT) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024, timeout: 15000,
  });
}

function _ensureBuilt(force = false, root = REPO_ROOT) {
  if (_map && !force) return _map;
  if (!fs.existsSync(path.join(root, '.git'))) { _map = {}; return _map; }
  try {
    const out = _git(['log', '--format=%H|%aI', '--', CLI_REL], root).toString('utf8');
    _revs = out.split('\n').filter(Boolean).map(l => {
      const i = l.indexOf('|');
      return [l.slice(0, i), l.slice(i + 1)];
    });
    const map = {};
    for (const [rev, iso] of _revs) {          // newest first
      try {
        const blob = _git(['cat-file', 'blob', rev + ':' + CLI_REL], root);
        const sha8 = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 8);
        if (!map[sha8]) map[sha8] = _fmt(iso);
      } catch (_e) { /* rev raced away — skip */ }
    }
    _map = map;
  } catch (_e) {
    _map = {};            // no git, no history → '—' everywhere
  }
  return _map;
}

// forVersion('0.2.55b5bca1') or forVersion('55b5bca1') → '2026-11-22 14:33' | null
// repoRoot: injectable for tests (defaults to this checkout).
function forVersion(version, repoRoot) {
  try {
    const v = String(version || '');
    // '0.2.' is FOUR chars — slice(3) produced '.f54d1051' (leading dot),
    // which matched nothing and every date came back null.
    const sha8 = /^0\.2\.[0-9a-f]{8}$/.test(v) ? v.slice(4)
               : (/^[0-9a-f]{8}$/.test(v) ? v : null);
    if (!sha8) return null;
    let map = _ensureBuilt(false, repoRoot);
    if (map[sha8]) return map[sha8];
    // unknown sha: either a NEW commit (rebuild once) or uncommitted bytes
    // (rebuild won't help — remember the miss so we stop retrying it).
    if (sha8 !== _lastMiss && (Date.now() - _lastBuildMs) > 15000) {
      _lastMiss = sha8;
      _lastBuildMs = Date.now();
      map = _ensureBuilt(true, repoRoot);
      if (map[sha8]) return map[sha8];
    }
    return null;
  } catch (_e) {
    return null;
  }
}

module.exports = { forVersion };
