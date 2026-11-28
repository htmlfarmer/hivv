// api/tests/install-tabs.test.js — the homepage install command, per OS.
//
// WHY THIS FILE EXISTS
// A visitor pasted the homepage's "curl -sSL ... | bash" into PowerShell and
// got:  bash : The term 'bash' is not recognized as the name of a cmdlet.
// The Windows installer (install-hivv.ps1) already existed — the page just
// never showed it. The banner now carries three labelled OS tabs
// (macOS/Linux · Windows · WSL), picks the default from the visitor's own
// platform, and the copy button copies what is ON SCREEN.
//
// This file does not just grep the HTML: it EXTRACTS the inline script and
// RUNS it against a stubbed DOM, so "Windows shows the PowerShell line" is a
// behaviour, not a string that happens to be in the source.
//
// Run with:  cd api && node --test tests/install-tabs.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'public_html');
const UNIX_CMD = 'curl -sSL https://hivv.org/install-hivv.sh | bash';
const WIN_CMD = 'iwr -useb https://hivv.org/install-hivv.ps1 | iex';

function read(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

function inlineBlockContaining(html, needle) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].includes(needle)) return m[1];
  }
  throw new Error('no inline <script> contains: ' + needle);
}

// ── a tiny DOM: just enough for the banner script ──────────────────────
function makeBanner(platform, storage) {
  const els = {};
  const btn = (os) => ({
    attrs: { 'data-os': os },
    style: {},
    classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  });
  const tabs = {
    children: [btn('unix'), btn('win'), btn('wsl')],
    _handlers: {},
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
  };
  const get = (id) => {
    if (id === 'hivv-os-tabs') return tabs;
    if (!els[id]) els[id] = { textContent: '', style: {}, onclick: null };
    return els[id];
  };
  const store = storage || {};
  const sandbox = {
    document: { getElementById: get },
    navigator: {
      userAgentData: { platform },
      clipboard: {
        _copied: null,
        writeText(t) { this._copied = t; return Promise.resolve(); },
      },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    Array,
    setTimeout: () => 0,
    console,
  };
  const src = inlineBlockContaining(read('index.html'), 'hivv-os-tabs');
  vm.runInNewContext(src, sandbox, { filename: 'index-install-tabs.js' });
  return { els, tabs, store, sandbox };
}

test('a Windows visitor is handed the PowerShell installer, never "curl | bash"', () => {
  const { els } = makeBanner('Windows');
  assert.equal(els['hivv-install-cmd'].textContent, WIN_CMD);
  assert.equal(els['hivv-install-prompt'].textContent, 'PS>');
  assert.match(els['hivv-install-hint'].textContent, /Win\+X/,
    'a Windows visitor needs to be told WHERE to paste this');
});

test('everyone else keeps the shell one-liner', () => {
  for (const p of ['MacIntel', 'Linux x86_64', '']) {
    const { els } = makeBanner(p);
    assert.equal(els['hivv-install-cmd'].textContent, UNIX_CMD, 'platform: ' + p);
    assert.equal(els['hivv-install-prompt'].textContent, '$');
  }
});

test('a remembered choice beats platform detection', () => {
  const { els } = makeBanner('Windows', { 'hivv-install-os': 'unix' });
  assert.equal(els['hivv-install-cmd'].textContent, UNIX_CMD,
    'the visitor already told us they want the shell command');
});

test('clicking a tab swaps the command, the prompt AND the hint', () => {
  const { els, tabs } = makeBanner('MacIntel');
  const wslBtn = tabs.children.find((b) => b.getAttribute('data-os') === 'wsl');
  tabs._handlers.click({ target: { closest: () => wslBtn } });
  assert.equal(els['hivv-install-cmd'].textContent, UNIX_CMD);
  assert.match(els['hivv-install-hint'].textContent, /wsl --install/,
    'the WSL tab must say how to get WSL first');
  const winBtn = tabs.children.find((b) => b.getAttribute('data-os') === 'win');
  tabs._handlers.click({ target: { closest: () => winBtn } });
  assert.equal(els['hivv-install-cmd'].textContent, WIN_CMD);
});

test('the copy button copies what is ON SCREEN, not a hard-coded line', async () => {
  const { els, sandbox } = makeBanner('Windows');     // Windows tab is showing
  assert.equal(typeof els['hivv-install-copy'].onclick, 'function');
  els['hivv-install-copy'].onclick.call(els['hivv-install-copy']);
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.navigator.clipboard._copied, WIN_CMD,
    'copy must read the DOM — a hard-coded string would copy the bash line');
});

test('cli.html switches a Windows visitor to its PowerShell tab', () => {
  const html = read('cli.html');
  const mkBtn = (tab) => ({
    dataset: { tab },
    classList: { toggle() {} },
    style: {},
    click() { if (this.onclick) this.onclick(); },
  });
  const unix = mkBtn('unix');
  const win = mkBtn('win');
  const cmds = [
    { dataset: { tab: 'unix' }, style: { display: 'block' } },
    { dataset: { tab: 'win' }, style: { display: 'none' } },
  ];
  const sandbox = {
    document: {
      querySelectorAll: (sel) =>
        sel === '.platform-tabs button' ? [unix, win]
        : sel === '.install-cmd' ? cmds : [],
      querySelector: (sel) =>
        sel === '.platform-tabs button[data-tab="win"]' ? win : null,
    },
    navigator: { userAgentData: { platform: 'Windows' } },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
  };
  vm.runInNewContext(inlineBlockContaining(html, '.platform-tabs'), sandbox,
    { filename: 'cli-tabs.js' });
  assert.equal(cmds[0].style.display, 'none', 'the bash line must be hidden');
  assert.equal(cmds[1].style.display, 'block', 'the PowerShell line must show');
});
