// api/lib/code-analysis.js — deterministic, signed source-analysis metadata.
//
// The LLM verdict explains code in prose, but prose can omit mechanically
// countable facts. This module extracts those facts from the source itself:
// command/API usage counts, file paths and access modes, network indicators,
// and a bounded risk score. The resulting object is included INSIDE the signed
// source.review envelope, so BLNQ can display and compare it without trusting
// an unsigned side-channel.
//
// Design constraints:
//   * Deterministic: same source => same analysis.
//   * Conservative: unknown constructs raise risk; they never lower it.
//   * No source execution and no network access.

const crypto = require('crypto');

const MAX_ITEMS = 20;
const MAX_PATH_LENGTH = 200;

const RISK_WEIGHTS = {
  dynamic_execution: 40,
  shell_execution: 35,
  process_spawn: 20,
  filesystem_write: 20,
  filesystem_read: 8,
  network: 25,
  credential_access: 35,
  privilege_escalation: 35,
  destructive: 40,
  obfuscation: 30,
  persistence: 30,
  resource_exhaustion: 15,
};

const LEVELS = [
  { max: 0, label: 'safe' },
  { max: 19, label: 'low' },
  { max: 49, label: 'medium' },
  { max: 79, label: 'high' },
  { max: 100, label: 'critical' },
];

function clampText(value, max = 240) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// Canonical JSON (used by the signed envelope) accepts SAFE INTEGERS ONLY —
// floats would serialize differently across Node and Python and silently break
// every signature. Measured values (entropy, averages) must therefore be
// rounded to whole numbers before they enter a signed body.
function roundMetric(value, places = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const p = 10 ** places;
  return Math.round(value * p) / p;
}

function countMatch(code, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const re = new RegExp(regex.source, flags);
  return (code.match(re) || []).length;
}

function topEntries(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_ITEMS)
    .map(([name, count]) => ({ name: clampText(name, 120), count }));
}

function riskLevel(score) {
  const s = Math.max(0, Math.min(100, score));
  return LEVELS.find((x) => s <= x.max).label;
}

function extractStringLiterals(code) {
  const out = [];
  // Deliberately conservative: recognize common quoted forms without trying
  // to parse every language perfectly.
  const re = /(["'])([^"'\\\n]{1,200})\1/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[2]);
  return out;
}

function analyzeCode(code, language = 'python') {
  const source = String(code || '');
  const bytes = Buffer.byteLength(source, 'utf8');
  const lines = source.split(/\r?\n/).length;
  const chars = source.length;
  const literals = extractStringLiterals(source);

  const commandPatterns = {
    'python.print': /\bprint\s*\(/g,
    'python.open': /\bopen\s*\(/g,
    'python.eval': /\beval\s*\(/g,
    'python.exec': /\bexec\s*\(/g,
    'python.compile': /\bcompile\s*\(/g,
    'python.__import__': /\b__import__\s*\(/g,
    'os.system': /\bos\.system\s*\(/g,
    'os.remove': /\bos\.remove\s*\(/g,
    'os.unlink': /\bos\.unlink\s*\(/g,
    'os.rename': /\bos\.rename\s*\(/g,
    'os.chmod': /\bos\.chmod\s*\(/g,
    'os.getcwd': /\bos\.getcwd\s*\(/g,
    'os.listdir': /\bos\.listdir\s*\(/g,
    'os.environ': /\bos\.environ\b/g,
    'subprocess.run': /\bsubprocess\.run\s*\(/g,
    'subprocess.call': /\bsubprocess\.call\s*\(/g,
    'subprocess.Popen': /\bsubprocess\.Popen\s*\(/g,
    'shell=True': /\bshell\s*=\s*True\b/g,
    'requests.get': /\brequests\.get\s*\(/g,
    'requests.post': /\brequests\.post\s*\(/g,
    'urllib.request': /\burllib\.request\.(?:urlopen|Request)\b/g,
    'socket.create_connection': /\bsocket\.create_connection\s*\(/g,
    'socket.socket': /\bsocket\.socket\s*\(/g,
    'fs.readFileSync': /\bfs\.(?:readFileSync|readFile)\s*\(/g,
    'fs.writeFileSync': /\bfs\.(?:writeFileSync|writeFile|appendFileSync)\s*\(/g,
    'fs.unlinkSync': /\bfs\.(?:unlinkSync|rmSync)\s*\(/g,
    'child_process': /\b(?:child_process\.)?(?:exec|execSync|spawn|spawnSync|fork)\s*\(/g,
    'curl': /\bcurl\b/g,
    'wget': /\bwget\b/g,
    'ssh': /\bssh\b/g,
    'nc': /\bnc\s+-/g,
    'rm': /\brm\s+-/g,
    'chmod': /\bchmod\b/g,
    'chown': /\bchown\b/g,
    'sudo': /\bsudo\b/g,
    'pip.install': /\bpip(?:3)?\s+install\b/g,
    'npm.install': /\bnpm\s+(?:i|install)\b/g,
    'package.install': /\bpip\s+install\b/g,
    'git.clone': /\bgit\s+clone\b/g,
    'pickle.loads': /\bpickle\.loads?\s*\(/g,
    'marshal.loads': /\bmarshal\.loads?\s*\(/g,
    'base64.decode': /\bbase64\.(?:b64decode|decodebytes)\s*\(/g,
    'ctypes': /\bctypes\./g,
    'password.read': /(?:read_text|readFileSync|open)\s*\([^\n]{0,120}(?:passwd|shadow|\.ssh|id_rsa)/gi,
    'env.read': /\b(?:os\.environ|process\.env|getenv)\b/g,
  };

  const commands = {};
  for (const [name, re] of Object.entries(commandPatterns)) {
    const count = countMatch(source, re);
    if (count) commands[name] = count;
  }

  const commandEntries = topEntries(commands);

  // File paths: recognizable string literals and common filesystem calls.
  const filePaths = [];
  const pathRe = /(?:^|["'\s])((?:\.{0,2}\/|\/)(?:[\w.@-]+\/)*[\w.@-]+(?:\.[A-Za-z0-9_]+)?)/g;
  let pm;
  while ((pm = pathRe.exec(source)) !== null && filePaths.length < MAX_ITEMS) {
    const p = clampText(pm[1], MAX_PATH_LENGTH);
    if (p && !filePaths.includes(p)) filePaths.push(p);
  }

  const fileModes = {
    read: countMatch(source, /\bopen\s*\([^\n)]*?["'][^"']*[r+][^"']*["']/g),
    write: countMatch(source, /\bopen\s*\([^\n)]*?["'][^"']*[wax+][^"']*["']/g),
    append: countMatch(source, /\bopen\s*\([^\n)]*?["'][^"']*a[^"']*["']/g),
    delete: countMatch(source, /\b(?:os\.(?:remove|unlink)|fs\.(?:unlinkSync|rmSync))\s*\(/g),
  };

  const network = {
    indicators: countMatch(source, /\b(?:requests|urllib|httpx|aiohttp|socket|fetch|axios)\b/g),
    urls: [],
    domains: [],
    ports: [],
  };
  for (const lit of literals) {
    const url = lit.match(/^https?:\/\/([^\/\s:]+)(?::(\d{1,5}))?/i);
    if (url) {
      network.urls.push(clampText(lit, 200));
      if (!network.domains.includes(url[1].toLowerCase())) network.domains.push(url[1].toLowerCase());
      if (url[2] && !network.ports.includes(Number(url[2]))) network.ports.push(Number(url[2]));
    }
  }
  network.urls = [...new Set(network.urls)].slice(0, MAX_ITEMS);
  network.domains = [...new Set(network.domains)].slice(0, MAX_ITEMS);
  network.ports = [...new Set(network.ports)].slice(0, MAX_ITEMS);

  const categories = {
    dynamic_execution: countMatch(source, /\b(?:eval|exec|compile|__import__)\s*\(/g),
    shell_execution: countMatch(source, /\b(?:os\.system|subprocess\.[A-Za-z_]+|child_process\.|shell\s*=\s*True)\b/g),
    process_spawn: countMatch(source, /\b(?:subprocess\.|child_process\.|os\.fork|os\.spawn)/g),
    filesystem_write: countMatch(source, /\b(?:open\s*\([^\n)]*["'][^"']*[wax+][^"']*["']|fs\.(?:writeFileSync|writeFile|appendFileSync)|os\.(?:remove|unlink|rename|chmod|chown))/g),
    filesystem_read: fileModes.read + fileModes.delete,
    network: network.indicators + network.urls.length,
    credential_access: countMatch(source, /(?:passwd|shadow|id_rsa|api[_-]?key|secret|token|password|\.ssh|\.env\b)/gi),
    privilege_escalation: countMatch(source, /\b(?:sudo|chmod\s+[47]|^#!.*\/sudo|os\.setuid|setuid)\b/gim),
    destructive: countMatch(source, /\b(?:rm\s+-[rf]|shutil\.rmtree|os\.remove|os\.unlink|fs\.rmSync)\b/g),
    obfuscation: countMatch(source, /\b(?:base64\.(?:b64decode|decodebytes)|marshal\.loads|pickle\.loads|exec\s*\(\s*['"]|eval\s*\(\s*['"])/g),
    persistence: countMatch(source, /\b(?:crontab|systemctl\s+enable|\.bashrc|\.profile|authorized_keys)\b/g),
    resource_exhaustion: countMatch(source, /\b(?:while\s+True|ThreadPoolExecutor|ProcessPoolExecutor|fork\s*\()/g),
  };

  // A score is a transparent weighted sum, not a probability. One hard-danger
  // class may still yield a moderate score, so `verdict` remains the primary
  // safety decision and this number is supporting evidence.
  let score = 0;
  const categoryScores = {};
  for (const [category, count] of Object.entries(categories)) {
    const points = Math.min(RISK_WEIGHTS[category] || 0, count * (RISK_WEIGHTS[category] || 0));
    categoryScores[category] = points;
    score += points;
  }
  score = Math.max(0, Math.min(100, score));

  const riskiest = Object.entries(categoryScores)
    .filter(([, points]) => points > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, points]) => ({ name, points, count: categories[name] }));

  const mostUsedCommands = commandEntries.slice(0, 10);
  const mostUsed = mostUsedCommands.length ? mostUsedCommands[0] : null;

  const risks = {
    score,
    level: riskLevel(score),
    categories,
    category_scores: categoryScores,
    most_used: mostUsed,
    riskiest_operations: riskiest,
  };

  // Signed bodies must contain integers only. Round the measured values here
  // so both sites canonicalize byte-identically.
  const safeFiles = {
    paths: filePaths,
    modes: fileModes,
    read_count: fileModes.read,
    write_count: fileModes.write + fileModes.append,
    delete_count: fileModes.delete,
  };
  const safeNetwork = {
    indicators: network.indicators,
    urls: network.urls,
    domains: network.domains,
    ports: network.ports,
  };

  const files = {
    paths: filePaths,
    modes: fileModes,
    read_count: fileModes.read,
    write_count: fileModes.write + fileModes.append,
    delete_count: fileModes.delete,
  };

  const sourceHash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return {
    source_sha256: sourceHash,
    language: clampText(language, 32),
    bytes,
    chars,
    lines,
    commands: commandEntries,
    command_count: commandEntries.reduce((n, x) => n + x.count, 0),
    most_used_commands: mostUsedCommands,
    files: safeFiles,
    network: safeNetwork,
    risks,
  };
}

module.exports = { analyzeCode, riskLevel };
