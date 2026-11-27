// api/lib/fast-scan.js — deterministic, AI-free source screening.
//
// WHY THIS EXISTS
// ───────────────
// Before spending an LLM (and real money) on a review, we want a cheap,
// reproducible answer to mechanical questions:
//   * how big is this file (bytes / chars / lines)?
//   * which commands, APIs, file paths and network targets does it touch?
//   * does it contain hard-danger patterns?
//   * what is the deterministic risk score and level?
//
// The answer is deterministic, so two nodes always agree, and it can be
// cached by source hash. It is NOT an approval: the deterministic scan can
// only make a verdict WORSE (safe -> unsafe/review), never better. That
// fail-closed direction is what makes it safe to run before the AI review.
//
// PRIVACY
// ───────
// Nothing leaves the process. The result contains metadata and bounded
// excerpts, never the source itself.

const crypto = require('crypto');
const { analyzeCode, riskLevel } = require('./code-analysis');

// ── language detection ────────────────────────────────────────────────────
const LANG_BY_EXT = {
  '.py': 'python', '.pyi': 'python',
  '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.jsx': 'node',
  '.ts': 'node', '.tsx': 'node',
  '.rb': 'ruby', '.php': 'php', '.pl': 'perl', '.pm': 'perl',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.cs': 'csharp',
  '.sql': 'sql', '.html': 'html', '.htm': 'html', '.css': 'css',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
};

function detectLanguage(code, hint) {
  if (hint && String(hint).toLowerCase() !== 'unknown') return String(hint).toLowerCase();
  const first = String(code || '').slice(0, 4000);
  if (/^#!.*\bpython[0-9.]*\b/m.test(first)) return 'python';
  if (/^#!.*\b(?:node|deno|bun)\b/m.test(first)) return 'node';
  if (/^#!.*\b(?:ba|z|)sh\b/m.test(first)) return 'bash';
  if (/\bdef\s+\w+\s*\(/.test(first) || /^\s*import\s+\w+/m.test(first)) return 'python';
  if (/^\s*(?:const|let|var|function|class)\s+/m.test(first)) return 'node';
  if (/console\s*\.\s*(?:log|error|warn)\s*\(/.test(first)) return 'node';
  if (/\b(?:require|import)\s*\(?\s*['"][^'"]+['"]/.test(first)) return 'node';
  return 'unknown';
}

// ── hard-danger patterns ───────────────────────────────────────────────────
// Deliberately precise. A pattern here flips `safe` to `unsafe`; a sloppy
// pattern would train people to ignore the scanner.
const HARD_PATTERNS = [
  { id: 'dynamic_exec', level: 'critical', re: /(?<![.\w])(?:eval|exec)\s*\(\s*[^\s)]/g,
    label: 'dynamic code execution' },
  { id: 'shell_true', level: 'critical', re: /shell\s*=\s*True/g,
    label: 'shell command interpolation' },
  { id: 'os_system', level: 'critical', re: /\bos\.system\s*\(/g,
    label: 'shell command execution' },
  { id: 'subprocess_shell', level: 'high', re: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g,
    label: 'process spawning' },
  // The flag CLUSTER: -[rf] matched ONE character and the trailing \b
  // then failed on "rm -rf" (the r|f is followed by another word char), so
  // the most destructive command in the shell slipped through BOTH
  // implementations. The cluster is what actually appears on disk.
  { id: 'destructive_delete', level: 'critical', re: /\b(?:shutil\.rmtree|fs\.rmSync|rm\s+-[a-z]*[rf][a-z]*)\b/g,
    label: 'recursive/destructive delete' },
  { id: 'credential_paths', level: 'critical', re: /(?:^|[\s"'=])(?:\/etc\/(?:passwd|shadow)|\.ssh\/id_[a-z0-9]+|~?\/\.aws\/credentials)/gim,
    label: 'credential file access' },
  { id: 'env_secret_read', level: 'high', re: /\b(?:os\.environ(?:\.get)?\s*\(?\s*['"][^'"]*(?:SECRET|TOKEN|PASSWORD|KEY)|process\.env\.[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY))/g,
    label: 'secret environment variable read' },
  { id: 'network_socket', level: 'high', re: /\b(?:socket\.socket|socket\.create_connection|requests\.(?:get|post|put|delete)|urllib\.request\.urlopen|httpx\.(?:get|post))\s*\(/g,
    label: 'network request' },
  { id: 'reverse_shell', level: 'critical', re: /\b(?:nc|ncat|netcat)\b[^\n]{0,80}(?:\-e|\/bin\/(?:ba)?sh)|\/dev\/tcp\//g,
    label: 'possible reverse shell' },
  { id: 'obfuscation', level: 'high', re: /\b(?:base64\.(?:b64decode|decodebytes)|marshal\.loads|pickle\.loads|exec\s*\(\s*['"]|eval\s*\(\s*['"])/g,
    label: 'encoded/executable payload' },
  { id: 'privilege_escalation', level: 'critical', re: /\b(?:sudo\s|chmod\s+[467][0-7]{2}\b|os\.setuid|setuid\s*\()/g,
    label: 'privilege escalation' },
  { id: 'persistence', level: 'high', re: /(?:crontab\s+-|systemctl\s+enable|authorized_keys|\.bashrc|\.zshrc)/g,
    label: 'persistence mechanism' },
  { id: 'pipe_to_shell', level: 'critical', re: /(?:curl|wget)[^|\n]{0,120}\|\s*(?:ba)?sh\b/g,
    label: 'download piped to shell' },
  { id: 'child_process', level: 'high', re: /\b(?:child_process\.)?(?:exec|execSync|spawn|spawnSync|fork)\s*\(/g,
    label: 'child process spawn' },
];

function matchHardPatterns(code) {
  const findings = [];
  for (const p of HARD_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    let m;
    let count = 0;
    let firstIndex = null;
    let sample = null;
    while ((m = re.exec(code)) !== null) {
      count++;
      if (firstIndex === null) firstIndex = m.index;
      if (!sample) sample = m[0].slice(0, 120);
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
      if (count >= 50) break;
    }
    if (count > 0) {
      findings.push({
        id: p.id,
        label: p.label,
        level: p.level,
        count,
        position: firstIndex,
        sample,
      });
    }
  }
  return findings;
}

// ── entropy / obfuscation heuristic ────────────────────────────────────────
function shannonEntropy(text) {
  if (!text || !text.length) return 0;
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  // Whole number: the fast-scan result travels inside a signed envelope and
  // canonical JSON permits integers only.
  return Math.round(h);
}

function longStringLiterals(code) {
  const out = [];
  const re = /(["'])([^"'\\\n]{40,500})\1/g;
  let m;
  while ((m = re.exec(code)) !== null && out.length < 20) {
    out.push({ length: m[2].length, entropy: shannonEntropy(m[2]) });
  }
  return out;
}

// ── secrets heuristics (never stores the secret itself) ───────────────────
const SECRET_PATTERNS = [
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

function findSecrets(code) {
  const findings = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    const m = re.exec(code);
    if (m) {
      findings.push({
        id: p.id,
        // Fingerprint only: never store the secret value.
        fingerprint: crypto.createHash('sha256').update(m[0]).digest('hex').slice(0, 16),
        position: m.index,
      });
    }
  }
  return findings;
}

// ── imports ────────────────────────────────────────────────────────────────
function extractImports(code, language) {
  const out = new Set();
  if (language === 'python') {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m;
    while ((m = re.exec(code)) !== null) out.add((m[1] || m[2] || '').split('.')[0]);
  } else if (language === 'node' || language === 'javascript' || language === 'typescript') {
    const re = /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;
    let m;
    while ((m = re.exec(code)) !== null) out.add(m[1] || m[2]);
  } else {
    const re = /^\s*import\s+([\w@./-]+)/gm;
    let m;
    while ((m = re.exec(code)) !== null) out.add(m[1]);
  }
  return [...out].filter(Boolean).slice(0, 100);
}

// ── executable bits (permissions) ──────────────────────────────────────────
function permissionBits(mode) {
  if (!Number.isSafeInteger(mode)) return null;
  return (mode & 0o777).toString(8).padStart(3, '0');
}

// ── main entry point ──────────────────────────────────────────────────────
// `fastScan(code, opts)` is deliberately synchronous and dependency-free so
// it can run in a hot path, a worker, a CLI, or a test with no setup.
function fastScan(code, options = {}) {
  const started = Date.now();
  const source = String(code == null ? '' : code);
  const bytes = Buffer.byteLength(source, 'utf8');
  const chars = source.length;
  const lines = source.split(/\r?\n/).length;
  const language = detectLanguage(source, options.language);
  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

  const analysis = analyzeCode(source, language === 'unknown' ? 'python' : language);
  const hard = matchHardPatterns(source);
  const secrets = findSecrets(source);
  const imports = extractImports(source, language);
  const literals = longStringLiterals(source);

  // Deterministic score: the analyzer's weighted categories, then hard-pattern
  // and secret escalation. Clamped to 0..100. This is evidence, not a verdict.
  let score = analysis.risks.score;
  for (const h of hard) {
    score += h.level === 'critical' ? 25 : h.level === 'high' ? 15 : 8;
  }
  score += secrets.length * 20;
  score = Math.max(0, Math.min(100, score));
  const level = riskLevel(score);

  // AI-free verdict: hard patterns or embedded secrets can only make it
  // unsafe/review; nothing here can approve code.
  let verdict = 'safe';
  if (hard.some((h) => h.level === 'critical') || secrets.length) verdict = 'unsafe';
  else if (hard.length || level === 'medium' || level === 'high' || level === 'critical') verdict = 'review';

  const mostUsed = analysis.most_used_commands || [];
  const result = {
    schema: 'hivv.fast-scan.v1',
    source_sha256: sha256,
    language,
    size: {
      bytes,
      chars,
      lines,
      non_empty_lines: source.split(/\r?\n/).filter((l) => l.trim()).length,
      max_line_length: source.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0),
      // Integers only — the fast-scan result is embedded in the signed
      // envelope, and canonical JSON forbids floats.
      avg_line_length: lines ? Math.round(chars / lines) : 0,
    },
    entropy: {
      whole_file: shannonEntropy(source),
      long_literals: literals.length,
      max_literal_entropy: literals.reduce((m, l) => Math.max(m, l.entropy), 0),
    },
    imports,
    commands: analysis.commands,
    command_count: analysis.command_count,
    most_used_commands: mostUsed,
    most_used: mostUsed[0] || null,
    riskiest_operations: analysis.risks.riskiest_operations || [],
    files: analysis.files,
    network: analysis.network,
    permissions: permissionBits(options.mode),
    hard_findings: hard,
    secret_findings: secrets,
    risks: {
      score,
      level,
      categories: analysis.risks.categories,
      category_scores: analysis.risks.category_scores,
    },
    verdict,
    // `safe` here means "no hard-danger signal found by the deterministic
    // scanner" — it is NOT an AI approval and NOT a signed attestation.
    verdict_basis: 'deterministic-only',
    scanned_at_ms: Date.now(),
    scan_duration_ms: Date.now() - started,
    needs_ai_review: verdict !== 'safe' || score >= 20,
  };

  return result;
}

module.exports = {
  fastScan,
  detectLanguage,
  matchHardPatterns,
  findSecrets,
  extractImports,
  shannonEntropy,
  permissionBits,
  HARD_PATTERNS,
  SECRET_PATTERNS,
};
