#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOB_LIMIT = 1024 * 1024;
const REQUIRED_CHECKS = ['contract-harness', 'content-scope', 'approval-boundary', 'delivery-record', 'repo-health'];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function run(command, args, {allowFailure = false} = {}) {
  try {
    return execFileSync(command, args, {cwd: ROOT, encoding: 'utf8'}).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function git(...args) {
  return run('git', args);
}

function succeeds(command, args) {
  try {
    execFileSync(command, args, {cwd: ROOT, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function lines(value) {
  return value ? value.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

function resolves(ref) {
  return Boolean(ref && succeeds('git', ['cat-file', '-e', `${ref}^{commit}`]));
}

const strict = process.argv.includes('--strict');
const allowDirty = process.argv.includes('--allow-dirty');
const fullTree = process.argv.includes('--full-tree');
const includeRemote = process.argv.includes('--remote');
const base = option('--base');
const output = option('--output');
const errors = [];
const warnings = [];
const files = fullTree
  ? lines(git('-c', 'core.quotepath=false', 'ls-files'))
  : resolves(base)
    ? lines(git('-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`))
    : resolves('HEAD^')
      ? lines(git('-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=ACMR', 'HEAD^', 'HEAD'))
      : lines(git('-c', 'core.quotepath=false', 'ls-files'));
const status = lines(git('status', '--porcelain'));
const forbidden = files.filter(file => file === 'reports/card_quality_audit_report.json' || file === 'reports/card_validation_report.json' || file.startsWith('exports/'));
const oversized = files.map(file => {
  const size = run('git', ['cat-file', '-s', `HEAD:${file}`], {allowFailure: true});
  return {file, bytes: size ? Number(size) : null};
}).filter(entry => entry.bytes !== null && entry.bytes > BLOB_LIMIT);
const audioFiles = fullTree ? files.filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3')) : [];
const lfsAudio = new Set(lines(run('git', ['lfs', 'ls-files', '--name-only'], {allowFailure: true})).filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3')));

if (!allowDirty && status.length > 0) errors.push({code: 'dirty_worktree', entries: status});
if (forbidden.length > 0) errors.push({code: 'generated_reports_tracked', files: forbidden});
if (oversized.length > 0) errors.push({code: 'ordinary_git_blob_too_large', blobs: oversized});
if (fullTree && audioFiles.some(file => !lfsAudio.has(file))) {
  errors.push({code: 'audio_not_managed_by_lfs', count: audioFiles.filter(file => !lfsAudio.has(file)).length});
}

let remote = null;
if (includeRemote) {
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {allowFailure: true});
  const protectionRaw = repo ? run('gh', ['api', `repos/${repo}/branches/main/protection`], {allowFailure: true}) : '';
  const openPrsRaw = run('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'headRefName'], {allowFailure: true});
  const openPrs = openPrsRaw ? JSON.parse(openPrsRaw) : [];
  const candidatePrs = openPrs.filter(pr => pr.headRefName.startsWith('content/')).length;
  const toolingPrs = openPrs.filter(pr => pr.headRefName.startsWith('tooling/') || pr.headRefName.startsWith('harness/')).length;
  if (!protectionRaw) errors.push({code: 'main_branch_unprotected'});
  else {
    const protection = JSON.parse(protectionRaw);
    const checks = protection.required_status_checks?.contexts || [];
    if (protection.required_status_checks?.strict !== true) errors.push({code: 'required_checks_not_strict'});
    if (protection.enforce_admins?.enabled !== true) errors.push({code: 'admins_not_enforced'});
    if (protection.required_conversation_resolution?.enabled !== true) errors.push({code: 'conversation_resolution_not_required'});
    if (protection.required_linear_history?.enabled !== true) errors.push({code: 'linear_history_not_required'});
    if (!protection.required_pull_request_reviews) errors.push({code: 'pull_request_not_required'});
    if (protection.allow_force_pushes?.enabled === true || protection.allow_deletions?.enabled === true) errors.push({code: 'destructive_main_update_allowed'});
    for (const check of REQUIRED_CHECKS) {
      if (!checks.includes(check)) errors.push({code: 'required_status_check_missing', check});
    }
  }
  const signatures = repo ? run('gh', ['api', `repos/${repo}/branches/main/protection/required_signatures`], {allowFailure: true}) : '';
  if (!signatures || JSON.parse(signatures).enabled !== true) errors.push({code: 'signed_commits_not_required'});
  const repositoryRaw = repo ? run('gh', ['api', `repos/${repo}`], {allowFailure: true}) : '';
  if (repositoryRaw) {
    const repository = JSON.parse(repositoryRaw);
    if (repository.allow_squash_merge !== true || repository.allow_merge_commit !== false || repository.allow_rebase_merge !== false) {
      errors.push({code: 'merge_methods_not_squash_only'});
    }
  }
  if (candidatePrs > 5) errors.push({code: 'candidate_pr_limit_exceeded', actual: candidatePrs});
  if (toolingPrs > 1) errors.push({code: 'tooling_pr_limit_exceeded', actual: toolingPrs});
  remote = {repo, candidate_prs: candidatePrs, tooling_prs: toolingPrs};
}

const report = {
  schema_version: 'repository-health.v1',
  generated_at: new Date().toISOString(),
  ok: errors.length === 0,
  head: git('rev-parse', 'HEAD'),
  base: base && resolves(base) ? git('rev-parse', base) : null,
  scope: fullTree ? 'full_tree' : 'changed_files',
  metrics: {checked_files: files.length, audio_files: audioFiles.length, lfs_audio_files: lfsAudio.size, oversized_blobs: oversized.length},
  remote,
  errors,
  warnings,
};
if (output) {
  const resolved = path.resolve(ROOT, output);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (strict && !report.ok) process.exit(1);
