// api/tests/file-permissions.test.js — a page the web server cannot read is
// a 404, and nothing else in the suite would ever notice.
//
// WHAT HAPPENED
// A patch script that rewrote the site wrote each file through a temporary
// file (mkstemp creates 0600) and renamed it into place. The result looked
// perfect in git — the content was right — but Caddy serves the site as
// www-data, and 46 pages had become owner-only. On the live site that is a
// 404 for the homepage and a 403 for every script. The test suite was
// GREEN: it reads the files as the owner, exactly like the broken site.
//
// THE LAW
//   Every file the web server serves must be readable by others.
//   A patch must PRESERVE the mode it found, not invent one.
//
// Run with:  cd api && node --test tests/file-permissions.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__pycache__') continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

test('every web-served file is readable by the web server (not owner-only)', () => {
  const bad = [];
  for (const p of walk(PUBLIC)) {
    const mode = fs.statSync(p).mode & 0o777;
    // Caddy serves as www-data: it needs the OTHER read bit.
    if ((mode & 0o004) === 0) {
      bad.push(path.relative(PUBLIC, p) + ' (mode ' + mode.toString(8).slice(-3) + ')');
    }
  }
  assert.equal(bad.length, 0,
    'these files cannot be read by the web server (they will 404/403): ' + bad.join(', '));
});

test('every web-served directory is traversable by the web server', () => {
  const bad = [];
  const walkDirs = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === '__pycache__') continue;
      const mode = fs.statSync(p).mode & 0o777;
      if ((mode & 0o001) === 0) {
        bad.push(path.relative(PUBLIC, p) + ' (mode ' + mode.toString(8).slice(-3) + ')');
      }
      walkDirs(p);
    }
  };
  walkDirs(PUBLIC);
  assert.equal(bad.length, 0,
    'these directories cannot be entered by the web server: ' + bad.join(', '));
});

test('the secrets stay secret (the mode rule has an exception, and it is here)', () => {
  // The opposite mistake is just as bad: a key that anyone can read.
  for (const f of ['api/.control-token', 'api/.session-secret', 'api/.lyrz-api-key']) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue;
    const mode = fs.statSync(p).mode & 0o777;
    assert.equal(mode & 0o077, 0, f + ' must NOT be group/other readable (mode ' + mode.toString(8).slice(-3) + ')');
  }
});
