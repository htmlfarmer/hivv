// api/lib/sandbox.js — isolated execution backend for the `coding.execute`
// capability (hivv OS §1 "Isolated Tool Sandboxing", backlog F3).
//
// Every run is EPHEMERAL and HARD-ISOLATED:
//   · docker (preferred): --network=none (zero egress) · --memory/--memory-swap
//     (RAM quota) · --cpus (CPU quota) · --pids-limit (fork bomb guard) ·
//     --read-only + tmpfs /tmp (no host FS writes) · --cap-drop=ALL ·
//     --security-opt=no-new-privileges · default seccomp profile (restricted
//     syscalls) · --rm (container destroyed on exit).
//   · bwrap (fallback): --unshare-all (user/net/pid/ipc namespaces → no egress,
//     no host pid view) · --die-with-parent · read-only host binds · tmpfs.
//   · neither present → refuse (never fall back to running on the host).
//
// Code is passed via a temp file mounted read-only — NEVER through a shell —
// so there is no interpolation/injection surface. Output is size-capped and the
// whole run is bounded by a watchdog timeout that force-kills the sandbox.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Hard resource ceilings (the policy layer decides IF code runs; this decides
// HOW MUCH damage a single run can do). Callers may lower, never raise.
const LIMITS = {
  memMB: 256,
  cpus: 0.5,
  pids: 64,
  tmpfsMB: 16,
  timeoutMsDefault: 10000,
  timeoutMsMax: 30000,
  outputBytes: 64 * 1024,
  codeBytes: 256 * 1024,
};

// language → { docker:{image, argv}, bwrap:{interp, ext}, ext }
const LANGS = {
  python:     { ext: 'py', docker: { image: 'python:3.12-alpine', argv: ['python', '/script.py'] }, bwrap: { interp: 'python3', argv: ['/script.py'] } },
  python3:    { ext: 'py', docker: { image: 'python:3.12-alpine', argv: ['python', '/script.py'] }, bwrap: { interp: 'python3', argv: ['/script.py'] } },
  bash:       { ext: 'sh', docker: { image: 'bash:5.2',           argv: ['bash', '/script.sh'] },   bwrap: { interp: 'bash',    argv: ['/script.sh'] } },
  sh:         { ext: 'sh', docker: { image: 'bash:5.2',           argv: ['bash', '/script.sh'] },   bwrap: { interp: 'bash',    argv: ['/script.sh'] } },
  node:       { ext: 'js', docker: { image: 'node:22-alpine',     argv: ['node', '/script.js'] },   bwrap: { interp: 'node',    argv: ['/script.js'] } },
  javascript: { ext: 'js', docker: { image: 'node:22-alpine',     argv: ['node', '/script.js'] },   bwrap: { interp: 'node',    argv: ['/script.js'] } },
};

let _dockerOk = null;   // cached tri-state: null=unknown, true/false
let _bwrapOk = null;

function _has(bin) {
  // 'command -v' is a shell builtin, so scan PATH directly (no shell).
  for (const dir of (process.env.PATH || '').split(':')) {
    try {
      const p = path.join(dir, bin);
      if (dir && fs.existsSync(p) && (fs.statSync(p).mode & 0o111)) return true;
    } catch {}
  }
  return false;
}

function dockerAvailable() {
  if (_dockerOk !== null) return _dockerOk;
  if (!_has('docker')) { _dockerOk = false; return false; }
  try {
    // synchronous-ish probe with a short timeout; daemon must be reachable
    const { execFileSync } = require('child_process');
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] });
    _dockerOk = true;
  } catch { _dockerOk = false; }
  return _dockerOk;
}

function bwrapAvailable() {
  if (_bwrapOk !== null) return _bwrapOk;
  _bwrapOk = _has('bwrap');
  return _bwrapOk;
}

function runtime() {
  if (dockerAvailable()) return 'docker';
  if (bwrapAvailable()) return 'bwrap';
  return null;
}

function _cap(n, max) { const s = String(n == null ? '' : n); return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]` : s; }

function _tmpScript(code, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivv-sbx-'));
  const file = path.join(dir, `script.${ext}`);
  fs.writeFileSync(file, code, { mode: 0o444 });
  return { dir, file };
}

// Run argv under docker with a hard watchdog. Resolves {stdout,stderr,exitCode,timedOut}.
function _runDocker(lang, code, timeoutMs) {
  return new Promise((resolve) => {
    const { dir, file } = _tmpScript(code, lang.ext);
    const name = 'hivvsbx_' + crypto.randomBytes(6).toString('hex');
    const args = [
      'run', '--rm', '--name', name, '--init',
      '--network', 'none',
      '--memory', `${LIMITS.memMB}m`, '--memory-swap', `${LIMITS.memMB}m`,
      '--cpus', String(LIMITS.cpus),
      '--pids-limit', String(LIMITS.pids),
      '--read-only', '--tmpfs', `/tmp:size=${LIMITS.tmpfsMB}m`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${file}:/script.${lang.ext}:ro`,
      lang.docker.image, ...lang.docker.argv,
    ];
    let out = '', err = '', done = false, timedOut = false;
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { try { execFile('docker', ['rm', '-f', name], { timeout: 5000 }, () => {}); } catch {} };
    const watchdog = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > LIMITS.outputBytes) { out = _cap(out, LIMITS.outputBytes); } });
    child.stderr.on('data', d => { err += d; if (err.length > LIMITS.outputBytes) { err = _cap(err, LIMITS.outputBytes); } });
    child.on('error', e => { if (done) return; done = true; clearTimeout(watchdog); cleanup(dir); resolve({ ok: false, error: e.message, runtime: 'docker', stdout: out, stderr: err, exitCode: -1, timedOut }); });
    child.on('close', (code2) => { if (done) return; done = true; clearTimeout(watchdog); cleanup(dir); resolve({ ok: !timedOut, stdout: _cap(out, LIMITS.outputBytes), stderr: _cap(err, LIMITS.outputBytes), exitCode: code2, timedOut, runtime: 'docker' }); });
  });
}

function _runBwrap(lang, code, timeoutMs) {
  return new Promise((resolve) => {
    if (!_has(lang.bwrap.interp)) {
      return resolve({ ok: false, error: `bwrap fallback needs '${lang.bwrap.interp}' on the host`, runtime: 'bwrap', stdout: '', stderr: '', exitCode: -1, timedOut: false });
    }
    const { dir, file } = _tmpScript(code, lang.ext);
    const args = [
      '--unshare-all', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--ro-bind', '/etc/ssl', '/etc/ssl',
      '--proc', '/proc', '--dev', '/dev',
      '--tmpfs', '/tmp', '--tmpfs', '/home',
      '--ro-bind', file, `/script.${lang.ext}`,
      '--', lang.bwrap.interp, ...lang.bwrap.argv,
    ];
    let out = '', err = '', done = false, timedOut = false;
    const child = spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const watchdog = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > LIMITS.outputBytes) out = _cap(out, LIMITS.outputBytes); });
    child.stderr.on('data', d => { err += d; if (err.length > LIMITS.outputBytes) err = _cap(err, LIMITS.outputBytes); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(watchdog); cleanup(dir); resolve({ ok: false, error: e.message, runtime: 'bwrap', stdout: out, stderr: err, exitCode: -1, timedOut }); });
    child.on('close', (code2) => { if (done) return; done = true; clearTimeout(watchdog); cleanup(dir); resolve({ ok: !timedOut, stdout: _cap(out, LIMITS.outputBytes), stderr: _cap(err, LIMITS.outputBytes), exitCode: code2, timedOut, runtime: 'bwrap' }); });
  });
}

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

// Public entry. Returns {ok, stdout, stderr, exitCode, timedOut, runtime} or
// {ok:false, refused:true, error} when there is no safe runtime / bad input.
async function execute({ code, language = 'python', timeoutMs } = {}) {
  const rt = runtime();
  if (!rt) {
    return { ok: false, refused: true, error: 'no sandbox runtime available (need docker daemon or bwrap) — refusing to run code on the host' };
  }
  const key = String(language || 'python').toLowerCase();
  const lang = LANGS[key];
  if (!lang) {
    return { ok: false, refused: true, error: `unsupported language '${language}' — allowed: ${Object.keys(LANGS).join(', ')}` };
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, refused: true, error: 'code is required' };
  }
  if (Buffer.byteLength(code) > LIMITS.codeBytes) {
    return { ok: false, refused: true, error: `code too large (>${LIMITS.codeBytes} bytes)` };
  }
  const to = Math.min(Math.max(parseInt(timeoutMs) || LIMITS.timeoutMsDefault, 1000), LIMITS.timeoutMsMax);
  return rt === 'docker' ? _runDocker(lang, code, to) : _runBwrap(lang, code, to);
}

module.exports = { execute, runtime, dockerAvailable, bwrapAvailable, LANGS, LIMITS };
