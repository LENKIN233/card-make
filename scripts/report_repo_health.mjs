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

function integerOption(name) {
  const value = option(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function run(command, args, {allowFailure = false, cwd = ROOT} = {}) {
  try {
    return execFileSync(command, args, {cwd, encoding: 'utf8'}).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function runWithInput(command, args, input) {
  return execFileSync(command, args, {cwd: ROOT, encoding: 'utf8', input}).trim();
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

function rangeBase(base, fullTree) {
  if (fullTree) return null;
  if (resolves(base)) return git('merge-base', base, 'HEAD');
  return resolves('HEAD^') ? git('rev-parse', 'HEAD^') : null;
}

function introducedPaths(commit) {
  if (!commit) return [];
  return lines(git('-c', 'core.quotepath=false', 'log', '--format=', '--name-only', '--diff-filter=ACMR', `${commit}..HEAD`));
}

function introducedBlobs(commit) {
  if (!commit) return [];
  const objects = lines(git('-c', 'core.quotepath=false', 'rev-list', '--objects', 'HEAD', '--not', commit)).map(line => {
    const separator = line.indexOf(' ');
    return {
      oid: separator === -1 ? line : line.slice(0, separator),
      file: separator === -1 ? null : line.slice(separator + 1),
    };
  });
  if (objects.length === 0) return [];
  const metadata = new Map(lines(runWithInput(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    `${objects.map(object => object.oid).join('\n')}\n`,
  )).map(line => {
    const [oid, type, size] = line.split(' ');
    return [oid, {bytes: Number(size), type}];
  }));
  return objects.flatMap(object => {
    const entry = metadata.get(object.oid);
    return entry?.type === 'blob' ? [{...object, bytes: entry.bytes}] : [];
  });
}

function currentBlobs(files) {
  return files.flatMap(file => {
    const size = run('git', ['cat-file', '-s', `HEAD:${file}`], {allowFailure: true});
    const oid = run('git', ['rev-parse', `HEAD:${file}`], {allowFailure: true});
    return size && oid ? [{file, oid, bytes: Number(size)}] : [];
  });
}

function uniqueBlobEntries(entries) {
  return [...new Map(entries.map(entry => [`${entry.oid}:${entry.file ?? ''}`, entry])).values()];
}

function isForbidden(file) {
  return file === 'reports/card_quality_audit_report.json' ||
    file === 'reports/card_validation_report.json' ||
    file.startsWith('exports/');
}

function worktreePaths() {
  return lines(git('worktree', 'list', '--porcelain'))
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
}

function localBranches() {
  return lines(git(
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)',
  )).map(line => {
    const [name, upstream = '', tracking = ''] = line.split('\t');
    return {name, upstream, tracking};
  });
}

const strict = process.argv.includes('--strict');
const allowDirty = process.argv.includes('--allow-dirty');
const fullTree = process.argv.includes('--full-tree');
const includeRemote = process.argv.includes('--remote');
const requireUpstreams = process.argv.includes('--require-upstreams');
const base = option('--base');
const output = option('--output');
const maxWorktrees = integerOption('--expected-max-worktrees');
const maxStashes = integerOption('--expected-max-stashes');
const errors = [];
const warnings = [];
const auditRangeBase = rangeBase(base, fullTree);
const files = fullTree
  ? lines(git('-c', 'core.quotepath=false', 'ls-files'))
  : resolves(base)
    ? lines(git('-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`))
    : resolves('HEAD^')
      ? lines(git('-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=ACMR', 'HEAD^', 'HEAD'))
      : lines(git('-c', 'core.quotepath=false', 'ls-files'));
const historicalPaths = introducedPaths(auditRangeBase);
const introducedBlobEntries = introducedBlobs(auditRangeBase);
const auditedBlobEntries = uniqueBlobEntries([...currentBlobs(files), ...introducedBlobEntries]);
const forbidden = [...new Set([...files, ...historicalPaths].filter(isForbidden))];
const oversized = auditedBlobEntries.filter(entry => entry.bytes > BLOB_LIMIT);
const audioFiles = fullTree ? files.filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3')) : [];
const lfsAudio = new Set(lines(run('git', ['lfs', 'ls-files', '--name-only'], {allowFailure: true})).filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3')));
const worktrees = worktreePaths();
const dirtyWorktrees = worktrees.flatMap(worktree => {
  if (!fs.existsSync(worktree)) return [{worktree, entries: ['worktree path is unavailable']}];
  const entries = lines(run('git', ['status', '--porcelain'], {cwd: worktree}));
  return entries.length > 0 ? [{worktree, entries}] : [];
});
const stashCount = lines(git('stash', 'list')).length;
const branches = localBranches();
const goneBranches = branches.filter(branch => branch.tracking.includes('[gone]')).map(branch => branch.name);
const branchesWithoutUpstream = branches.filter(branch => !branch.upstream).map(branch => branch.name);

if (!allowDirty && dirtyWorktrees.length > 0) errors.push({code: 'dirty_worktree', worktrees: dirtyWorktrees});
if (forbidden.length > 0) errors.push({code: 'generated_reports_tracked', files: forbidden});
if (oversized.length > 0) errors.push({code: 'ordinary_git_blob_too_large', blobs: oversized});
if (fullTree && audioFiles.some(file => !lfsAudio.has(file))) {
  errors.push({code: 'audio_not_managed_by_lfs', count: audioFiles.filter(file => !lfsAudio.has(file)).length});
}
if (maxWorktrees !== null && worktrees.length > maxWorktrees) {
  errors.push({code: 'worktree_limit_exceeded', expected_max: maxWorktrees, actual: worktrees.length});
}
if (maxStashes !== null && stashCount > maxStashes) {
  errors.push({code: 'stash_limit_exceeded', expected_max: maxStashes, actual: stashCount});
}
if (goneBranches.length > 0) {
  const issue = {code: 'gone_local_branches', branches: goneBranches};
  if (requireUpstreams) errors.push(issue);
  else warnings.push(issue);
}
if (branchesWithoutUpstream.length > 0) {
  const issue = {code: 'branch_upstream_missing', branches: branchesWithoutUpstream};
  if (requireUpstreams) errors.push(issue);
  else warnings.push(issue);
}

let remote = null;
if (includeRemote) {
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {allowFailure: true});
  if (!repo) errors.push({code: 'remote_repository_unavailable'});
  const protectionRaw = repo ? run('gh', ['api', `repos/${repo}/branches/main/protection`], {allowFailure: true}) : '';
  let openPrs = null;
  try {
    openPrs = JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'headRefName']));
  } catch {
    errors.push({code: 'open_pr_snapshot_unavailable'});
  }
  const candidatePrs = openPrs ? openPrs.filter(pr => pr.headRefName.startsWith('content/')).length : null;
  const toolingPrs = openPrs ? openPrs.filter(pr => pr.headRefName.startsWith('tooling/') || pr.headRefName.startsWith('harness/')).length : null;
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
  if (candidatePrs !== null && candidatePrs > 5) errors.push({code: 'candidate_pr_limit_exceeded', actual: candidatePrs});
  if (toolingPrs !== null && toolingPrs > 1) errors.push({code: 'tooling_pr_limit_exceeded', actual: toolingPrs});
  remote = {repo, candidate_prs: candidatePrs, tooling_prs: toolingPrs};
}

const report = {
  schema_version: 'repository-health.v1',
  generated_at: new Date().toISOString(),
  ok: errors.length === 0,
  head: git('rev-parse', 'HEAD'),
  base: base && resolves(base) ? git('rev-parse', base) : null,
  scope: fullTree ? 'full_tree' : 'changed_files',
  metrics: {
    checked_files: files.length,
    checked_blobs: auditedBlobEntries.length,
    introduced_blobs: introducedBlobEntries.length,
    audio_files: audioFiles.length,
    lfs_audio_files: lfsAudio.size,
    oversized_blobs: oversized.length,
    worktrees: worktrees.length,
    dirty_worktrees: dirtyWorktrees.length,
    stashes: stashCount,
    gone_branches: goneBranches.length,
    branches_without_upstream: branchesWithoutUpstream.length,
  },
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
