// api/tests/fast-scan.test.js — deterministic AI-free scanner.
//
// The fast scanner runs BEFORE the AI review, so its contract is strict:
//   * deterministic (same input => same output, modulo timestamps)
//   * fail-closed (it can never APPROVE anything)
//   * never stores the source or a secret value

const test = require('node:test');
const assert = require('node:assert');
const { fastScan, detectLanguage, matchHardPatterns, findSecrets } = require('../lib/fast-scan');

test('detects language from content and shebang', () => {
  assert.equal(detectLanguage('#!/usr/bin/env python3\nprint(1)'), 'python');
  assert.equal(detectLanguage('console.log(1)'), 'node');
  assert.equal(detectLanguage('#!/bin/bash\necho hi'), 'bash');
});

test('counts bytes, chars and lines exactly', () => {
  const code = 'print("hi")\nprint("there")\n';
  const r = fastScan(code);
  assert.equal(r.size.bytes, Buffer.byteLength(code, 'utf8'));
  assert.equal(r.size.chars, code.length);
  assert.equal(r.size.lines, 3); // trailing newline => 3 logical lines
  assert.equal(r.source_sha256.length, 64);
});

test('is deterministic apart from timing fields', () => {
  const code = 'import os\nos.environ.get("TOKEN")\n';
  const a = fastScan(code);
  const b = fastScan(code);
  delete a.scanned_at_ms; delete a.scan_duration_ms;
  delete b.scanned_at_ms; delete b.scan_duration_ms;
  assert.deepStrictEqual(a, b);
});

test('never approves hard-danger code', () => {
  const cases = [
    'eval(user_input)\n',
    'import os\nos.system("rm -rf /")\n',
    'import subprocess\nsubprocess.run(cmd, shell=True)\n',
    'import shutil\nshutil.rmtree("/")\n',
    'open("/etc/passwd").read()\n',
    'import requests\nrequests.get("https://evil.example")\n',
    'import base64\nexec(base64.b64decode("x"))\n',
  ];
  for (const code of cases) {
    const r = fastScan(code);
    assert.notEqual(r.verdict, 'safe', `should not be safe: ${code}`);
    assert.equal(r.verdict_basis, 'deterministic-only');
  }
});

test('flags embedded secrets but never stores the value', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const r = fastScan(`KEY = "${secret}"\n`);
  assert.ok(r.secret_findings.length >= 1);
  assert.equal(r.secret_findings[0].id, 'aws_access_key');
  assert.equal(r.secret_findings[0].fingerprint.length, 16);
  assert.ok(!JSON.stringify(r).includes(secret), 'secret value must not appear in the result');
});

test('reports command counts and the most used command', () => {
  const r = fastScan('print(1)\nprint(2)\nprint(3)\n');
  const print = r.commands.find((c) => c.name === 'python.print');
  assert.ok(print);
  assert.equal(print.count, 3);
  assert.equal(r.most_used.name, 'python.print');
  assert.equal(r.most_used.count, 3);
});

test('reports file and network indicators', () => {
  const r = fastScan([
    'open("data.csv").read()',
    'open("out.txt", "w").write("x")',
    'import requests',
    'requests.get("https://example.com/a")',
  ].join('\n'));
  assert.ok(r.network.indicators >= 1);
  assert.ok(r.network.domains.includes('example.com'));
  assert.ok(r.files.write_count >= 1);
});

test('flags a fresh review when a deterministic hit exists', () => {
  const clean = fastScan('print("hello")\n');
  assert.equal(clean.verdict, 'safe');
  assert.equal(clean.needs_ai_review, false);

  const dirty = fastScan('import os\nos.system("ls")\n');
  assert.equal(dirty.needs_ai_review, true);
});

test('hard pattern matcher is reusable and stable', () => {
  const a = matchHardPatterns('os.system("x")\nos.system("y")\n');
  const b = matchHardPatterns('os.system("x")\nos.system("y")\n');
  assert.deepStrictEqual(a, b);
  assert.equal(a[0].count, 2);
});

test('secret finder returns fingerprints only', () => {
  const findings = findSecrets('token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"');
  assert.ok(findings.some((f) => f.id === 'github_token'));
  for (const f of findings) assert.ok(!('value' in f));
});
