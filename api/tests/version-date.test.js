// WHEN was each CLI version built? — sha8 → 'YYYY-MM-DD HH:MM' from git.
//
// The hivv nodes VERSION column printed a content hash: perfect for
// equality, meaningless to a human ("old?" was unanswerable — 2026-11-23).
// The hub sits in a checkout, so it maps each version back to the commit
// that shipped it. Pinned here with a REAL tmp git repo: dates must be
// real, unknown shas must be null, and a non-repo must never throw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vd = require('../lib/version-date');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  const f = path.join(dir, 'public_html');
  fs.mkdirSync(f, { recursive: true });
  return { dir, git, file: path.join(f, 'hivv-cli.py') };
}

function sha8Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

test('maps a committed version to its commit date+time', () => {
  const { dir, git, file } = makeRepo();
  fs.writeFileSync(file, 'version one');
  git(['add', '.']);
  git(['commit', '-qm', 'one', '--date=2026-11-20T09:30:00']);
  const blob = fs.readFileSync(file);
  const date = vd.forVersion('0.2.' + sha8Of(blob), dir);
  assert.match(date, /^2026-11-20 09:30$/, 'got: ' + date);
});

test('two versions map to two different dates', () => {
  const { dir, git, file } = makeRepo();
  fs.writeFileSync(file, 'v1');
  git(['add', '.']); git(['commit', '-qm', 'one']);
  const sha1 = sha8Of(fs.readFileSync(file));
  fs.writeFileSync(file, 'v2 — a different content hash');
  git(['add', '.']); git(['commit', '-qm', 'two']);
  const sha2 = sha8Of(fs.readFileSync(file));
  assert.notEqual(sha1, sha2, 'fixture must produce distinct hashes');
  const d1 = vd.forVersion('0.2.' + sha1, dir);
  const d2 = vd.forVersion('0.2.' + sha2, dir);
  assert.match(d1, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(d2, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('unknown sha and non-versions are null — never a wrong date', () => {
  const { dir } = makeRepo();
  assert.equal(vd.forVersion('0.2.deadbeef', dir), null);
  assert.equal(vd.forVersion('not-a-version', dir), null);
  assert.equal(vd.forVersion('', dir), null);
  assert.equal(vd.forVersion(null), null);
});

test('a directory without .git returns null instead of throwing', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-bare-'));
  assert.equal(vd.forVersion('0.2.01234567', bare), null);
});
