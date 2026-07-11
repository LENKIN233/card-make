#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-repo-health-'));

try {
  fs.mkdirSync(path.join(tempRoot, 'scripts'));
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'report_repo_health.mjs'),
    path.join(tempRoot, 'scripts', 'report_repo_health.mjs'),
  );
  git('init', '-b', 'main');
  git('config', 'user.email', 'repo-health@example.invalid');
  git('config', 'user.name', 'Repository Health Test');
  fs.writeFileSync(path.join(tempRoot, 'README.md'), 'baseline\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(tempRoot, 'transient.bin'), Buffer.alloc(2 * 1024 * 1024));
  git('add', 'transient.bin');
  git('commit', '-m', 'introduce oversized blob');
  fs.rmSync(path.join(tempRoot, 'transient.bin'));
  git('add', '-u');
  git('commit', '-m', 'remove oversized blob');

  const result = spawnSync(
    process.execPath,
    ['scripts/report_repo_health.mjs', '--base', base, '--strict'],
    {cwd: tempRoot, encoding: 'utf8'},
  );
  const report = JSON.parse(result.stdout);
  assert.notEqual(result.status, 0, 'transient oversized blob must fail');
  assert.ok(report.errors.some(error => error.code === 'ordinary_git_blob_too_large'));
  assert.ok(report.metrics.introduced_blobs > 0);
  console.log('PASS: repository health rejects introduced-and-deleted blobs.');
} finally {
  fs.rmSync(tempRoot, {force: true, recursive: true});
}

function git(...args) {
  return execFileSync('git', args, {cwd: tempRoot, encoding: 'utf8'}).trim();
}
