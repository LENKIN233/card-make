#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-repo-health-'));
const linkedRoot = `${tempRoot}-linked`;
const remoteRoot = `${tempRoot}-remote.git`;

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
  git('add', 'README.md', 'scripts/report_repo_health.mjs');
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

  execFileSync('git', ['init', '--bare', remoteRoot], {stdio: 'ignore'});
  git('remote', 'add', 'origin', remoteRoot);
  git('push', '--set-upstream', 'origin', 'main');
  git('branch', 'gone');
  git('push', '--set-upstream', 'origin', 'gone');
  git('push', 'origin', '--delete', 'gone');
  git('worktree', 'add', '-b', 'topic', linkedRoot);
  fs.writeFileSync(path.join(linkedRoot, 'dirty.txt'), 'dirty linked worktree\n');
  fs.writeFileSync(path.join(tempRoot, 'stash.txt'), 'stashed state\n');
  git('stash', 'push', '--include-untracked', '-m', 'health test stash');

  const workspaceResult = spawnSync(
    process.execPath,
    [
      'scripts/report_repo_health.mjs',
      '--full-tree',
      '--strict',
      '--expected-max-worktrees',
      '1',
      '--expected-max-stashes',
      '0',
      '--require-upstreams',
    ],
    {cwd: tempRoot, encoding: 'utf8'},
  );
  const workspaceReport = JSON.parse(workspaceResult.stdout);
  const errorCodes = new Set(workspaceReport.errors.map(error => error.code));

  assert.notEqual(workspaceResult.status, 0, 'workspace hygiene violations must fail');
  assert.ok(errorCodes.has('dirty_worktree'));
  assert.ok(errorCodes.has('worktree_limit_exceeded'));
  assert.ok(errorCodes.has('stash_limit_exceeded'));
  assert.ok(errorCodes.has('branch_upstream_missing'));
  assert.ok(errorCodes.has('gone_local_branches'));
  assert.equal(workspaceReport.metrics.worktrees, 2);
  assert.equal(workspaceReport.metrics.dirty_worktrees, 1);
  assert.equal(workspaceReport.metrics.stashes, 1);
  assert.equal(workspaceReport.metrics.gone_branches, 1);
  assert.equal(workspaceReport.metrics.branches_without_upstream, 1);
  console.log('PASS: repository health checks every worktree, stash, and branch upstream.');
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', linkedRoot], {cwd: tempRoot, stdio: 'ignore'});
  fs.rmSync(linkedRoot, {force: true, recursive: true});
  fs.rmSync(remoteRoot, {force: true, recursive: true});
  fs.rmSync(tempRoot, {force: true, recursive: true});
}

function git(...args) {
  return execFileSync('git', args, {cwd: tempRoot, encoding: 'utf8'}).trim();
}
