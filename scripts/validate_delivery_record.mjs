#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF_DIRECTORY = 'reviews/git_handoffs/';
const HANDOFF_TEMPLATE_PATH = 'reviews/git_handoffs/TEMPLATE.json';
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REAL_PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const PARKED_STATE = 'PARKED_NO_PR_WIP_LIMIT';
const PATCH_FORMAT_V2 = 'git-diff-binary-v2';
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const V2_INHERITED_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'TMPDIR',
  'TMP',
  'TEMP',
];
const V2_GIT_CONFIG = [
  ['color.ui', 'false'],
  ['core.bigFileThreshold', '512m'],
  ['core.quotePath', 'true'],
  ['core.attributesFile', os.devNull],
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.relative', 'false'],
  ['diff.algorithm', 'myers'],
  ['diff.compactionHeuristic', 'false'],
  ['diff.indentHeuristic', 'false'],
  ['diff.context', '3'],
  ['diff.interHunkContext', '0'],
  ['diff.suppressBlankEmpty', 'false'],
  ['diff.orderFile', os.devNull],
];
const V2_DIFF_OPTIONS = [
  '--binary',
  '--full-index',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--line-prefix=',
  '--unified=3',
  '--diff-algorithm=myers',
  '--no-indent-heuristic',
  '--inter-hunk-context=0',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
  '--output-indicator-new=+',
  '--output-indicator-old=-',
  '--output-indicator-context= ',
];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function gitBuffer(root, args, {attributeSource, deterministicDiff = false} = {}) {
  let env = {...process.env};
  if (deterministicDiff) {
    env = {};
    for (const key of V2_INHERITED_ENV_KEYS) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.GIT_ATTR_NOSYSTEM = '1';
    env.GIT_ATTR_SOURCE = attributeSource;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = os.devNull;
    env.GIT_CONFIG_SYSTEM = os.devNull;
    env.GIT_NO_REPLACE_OBJECTS = '1';
    env.LC_ALL = 'C';
    env.LANG = 'C';
  }
  return execFileSync('git', args, {
    cwd: root,
    encoding: null,
    env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function decodeGitUtf8(bytes, context) {
  try {
    return FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${context} contains a non-UTF-8 byte sequence`);
  }
}

function gitText(root, args, options) {
  return decodeGitUtf8(gitBuffer(root, args, options), `git ${args.join(' ')}`).trim();
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort(comparePaths);
}

function changedPaths(root, from, to) {
  const bytes = gitBuffer(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--ignore-submodules=none',
    from,
    to,
    '--',
  ]);
  return sortedUnique(decodeGitUtf8(bytes, 'git diff --name-only').split('\0').filter(Boolean));
}

function changedPathsAcrossCommits(root, fromExclusive, toInclusive) {
  const revisionBytes = gitBuffer(root, [
    'rev-list',
    '--reverse',
    `${fromExclusive}..${toInclusive}`,
  ]);
  const revisions = decodeGitUtf8(revisionBytes, 'git rev-list')
    .split('\n')
    .map(revision => revision.trim())
    .filter(Boolean);
  const paths = [];
  for (const revision of revisions) {
    const bytes = gitBuffer(root, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--ignore-submodules=none',
      '-m',
      revision,
      '--',
    ]);
    paths.push(...decodeGitUtf8(bytes, 'git diff-tree --name-only').split('\0').filter(Boolean));
  }
  return sortedUnique(paths);
}

function assertNoRepositoryInfoAttributes(root, commitSha) {
  const options = {attributeSource: commitSha, deterministicDiff: true};
  const gitPath = gitText(root, ['rev-parse', '--git-path', 'info/attributes'], options);
  const attributesPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(root, gitPath);
  if (!fs.existsSync(attributesPath)) return;
  if (fs.readFileSync(attributesPath).length > 0) {
    throw new Error(`git-diff-binary-v2 refuses non-empty repository info attributes: ${attributesPath}`);
  }
}

function assertNoCustomDiffDriverConfig(root, commitSha) {
  let configuredDrivers;
  try {
    configuredDrivers = gitText(
      root,
      ['config', '--name-only', '--get-regexp', '^diff\\..+\\..+$'],
      {attributeSource: commitSha, deterministicDiff: true},
    );
  } catch (error) {
    if (error?.status === 1) return;
    throw error;
  }
  if (configuredDrivers) {
    throw new Error(`git-diff-binary-v2 refuses custom diff-driver config: ${configuredDrivers}`);
  }
}

function isSafeRepositoryRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (/[\\\x00-\x1f\x7f]/.test(value)) return false;
  if (value.endsWith('/') || path.posix.normalize(value) !== value) return false;
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  return segments[0] !== '.git';
}

function parseGitHubRepository(remoteUrl) {
  const value = String(remoteUrl || '').trim().replace(/\.git$/, '');
  let match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) match = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (!match) match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? {owner: match[1], repository: match[2]} : null;
}

function validateLocator(record, repository, errors) {
  const rawUrl = record.PR_url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    errors.push('handoff PR_url must be a non-empty GitHub URL');
    return;
  }

  let locator;
  try {
    locator = new URL(rawUrl);
  } catch {
    errors.push('handoff PR_url must be a valid URL');
    return;
  }
  if (
    locator.protocol !== 'https:'
    || locator.hostname.toLowerCase() !== 'github.com'
    || locator.port !== ''
    || locator.username !== ''
    || locator.password !== ''
  ) {
    errors.push('handoff PR_url must be an HTTPS github.com URL');
    return;
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(locator.pathname);
  } catch {
    errors.push('handoff PR_url path must use valid URL encoding');
    return;
  }
  const segments = decodedPathname.split('/').filter(Boolean);
  if (segments.length < 4) {
    errors.push('handoff PR_url does not identify a GitHub pull request or parked comparison');
    return;
  }
  const [owner, repositoryName, locatorKind, ...locatorParts] = segments;
  if (repository && (
    owner.toLowerCase() !== repository.owner.toLowerCase()
    || repositoryName.toLowerCase() !== repository.repository.toLowerCase()
  )) {
    errors.push(`handoff PR_url repository mismatch: ${owner}/${repositoryName} != ${repository.owner}/${repository.repository}`);
  }

  if (REAL_PR_STATES.has(record.PR_state)) {
    if (locatorKind !== 'pull' || locatorParts.length !== 1 || !/^[1-9][0-9]*$/.test(locatorParts[0])) {
      errors.push(`handoff PR_url for ${record.PR_state} must use /pull/<number>`);
    }
    return;
  }

  if (record.PR_state === PARKED_STATE) {
    const comparison = locatorParts.join('/');
    const expectedComparison = `${record.base_branch}...${record.branch}`;
    if (locatorKind !== 'compare' || comparison !== expectedComparison) {
      errors.push(`handoff PR_url for ${PARKED_STATE} must use /compare/${expectedComparison}`);
    }
    return;
  }

  errors.push(`handoff PR_state is unsupported: ${record.PR_state}`);
}

export function buildPatchBytes({
  root,
  baseCommitSha,
  commitSha,
  touchedPaths,
  patchFormat,
}) {
  const paths = sortedUnique(touchedPaths);
  const args = [];
  if (patchFormat === PATCH_FORMAT_V2) {
    assertNoRepositoryInfoAttributes(root, commitSha);
    assertNoCustomDiffDriverConfig(root, commitSha);
    for (const [key, value] of V2_GIT_CONFIG) {
      args.push('-c', `${key}=${value}`);
    }
  } else if (patchFormat !== undefined && patchFormat !== null) {
    throw new Error(`unsupported patch_format: ${patchFormat}`);
  }
  args.push('--literal-pathspecs', 'diff');
  if (patchFormat === PATCH_FORMAT_V2) args.push(...V2_DIFF_OPTIONS);
  else args.push('--binary');
  args.push(baseCommitSha, commitSha, '--', ...paths);
  return gitBuffer(root, args, {
    attributeSource: commitSha,
    deterministicDiff: patchFormat === PATCH_FORMAT_V2,
  });
}

export function computePatchSha256(options) {
  return crypto.createHash('sha256').update(buildPatchBytes(options)).digest('hex');
}

function validateTouchedPaths(record, handoffPath, errors) {
  const touchedPaths = record.scope?.touched_paths;
  if (!Array.isArray(touchedPaths) || touchedPaths.length === 0) {
    errors.push('handoff scope.touched_paths must be a non-empty array');
    return [];
  }

  for (const touchedPath of touchedPaths) {
    if (!isSafeRepositoryRelativePath(touchedPath)) {
      errors.push(`handoff touched path is not a safe repository-relative path: ${JSON.stringify(touchedPath)}`);
    }
    if (touchedPath === handoffPath) {
      errors.push('handoff scope.touched_paths must not include the current handoff record');
    }
  }

  const uniquePaths = new Set(touchedPaths);
  if (uniquePaths.size !== touchedPaths.length) {
    errors.push('handoff scope.touched_paths must not contain duplicates');
  }
  const canonicalPaths = sortedUnique(touchedPaths);
  if (JSON.stringify(canonicalPaths) !== JSON.stringify(touchedPaths)) {
    errors.push('handoff scope.touched_paths must be sorted lexicographically');
  }
  return canonicalPaths.filter(touchedPath => isSafeRepositoryRelativePath(touchedPath) && touchedPath !== handoffPath);
}

function validatePayloadBoundary({
  base,
  commitSha,
  handoffPath,
  head,
  record,
  root,
  touchedPaths,
  errors,
}) {
  let mergeBase;
  try {
    mergeBase = gitText(root, ['merge-base', base, commitSha]);
  } catch {
    errors.push(`unable to resolve merge-base between ${base} and handoff commit_sha`);
    return;
  }

  let payloadChangedPaths;
  try {
    payloadChangedPaths = changedPaths(root, mergeBase, commitSha).filter(changedPath => changedPath !== handoffPath);
  } catch {
    errors.push('unable to inspect payload paths from merge-base through handoff commit_sha');
    return;
  }

  const expectedPaths = new Set(touchedPaths);
  const actualPaths = new Set(payloadChangedPaths);
  for (const changedPath of payloadChangedPaths) {
    if (!expectedPaths.has(changedPath)) {
      errors.push(`payload path missing from scope.touched_paths: ${changedPath}`);
    }
  }
  for (const touchedPath of touchedPaths) {
    if (!actualPaths.has(touchedPath)) {
      errors.push(`scope.touched_paths names a path not changed by the payload: ${touchedPath}`);
    }
  }

  try {
    const postPayloadPaths = changedPathsAcrossCommits(root, commitSha, head);
    for (const changedPath of postPayloadPaths) {
      if (changedPath !== handoffPath) {
        errors.push(`non-handoff path changed after handoff commit_sha: ${changedPath}`);
      }
    }
  } catch {
    errors.push('unable to inspect changes after handoff commit_sha');
  }

  const patchFormat = record.scope?.patch_format;
  const patchSha256 = record.scope?.patch_sha256;
  const declaredBaseCommit = record.scope?.base_commit_sha;
  if (patchFormat !== undefined && patchFormat !== PATCH_FORMAT_V2) {
    errors.push(`handoff scope.patch_format is unsupported: ${patchFormat}`);
  }
  if (patchFormat === PATCH_FORMAT_V2) {
    if (!SHA1_RE.test(String(declaredBaseCommit || ''))) {
      errors.push('handoff scope.base_commit_sha must be a full SHA for git-diff-binary-v2');
    } else if (declaredBaseCommit !== mergeBase) {
      errors.push(`handoff scope.base_commit_sha must equal merge-base: ${declaredBaseCommit} != ${mergeBase}`);
    }
    if (!SHA256_RE.test(String(patchSha256 || ''))) {
      errors.push('handoff scope.patch_sha256 must be a SHA-256 digest for git-diff-binary-v2');
    }
  } else if (declaredBaseCommit !== undefined) {
    errors.push('handoff scope.base_commit_sha requires patch_format git-diff-binary-v2');
  }

  if (patchSha256 !== undefined && !SHA256_RE.test(String(patchSha256))) {
    errors.push('handoff scope.patch_sha256 must be a SHA-256 digest');
  }
  if (!SHA256_RE.test(String(patchSha256 || ''))) return;
  if (patchFormat !== undefined && patchFormat !== PATCH_FORMAT_V2) return;
  if (patchFormat === PATCH_FORMAT_V2 && (!SHA1_RE.test(String(declaredBaseCommit || '')) || declaredBaseCommit !== mergeBase)) return;

  try {
    const computedPatchSha256 = computePatchSha256({
      root,
      baseCommitSha: patchFormat === PATCH_FORMAT_V2 ? declaredBaseCommit : mergeBase,
      commitSha,
      touchedPaths,
      patchFormat,
    });
    if (computedPatchSha256 !== patchSha256) {
      errors.push(`handoff scope.patch_sha256 mismatch: ${patchSha256} != ${computedPatchSha256}`);
    }
  } catch {
    errors.push('unable to recompute handoff scope.patch_sha256');
  }
}

export function validateDeliveryRecord({
  root = ROOT,
  base = 'origin/main',
  head = 'HEAD',
  branch,
  baseBranch = 'main',
} = {}) {
  const errors = [];
  let resolvedBranch = branch;
  if (!resolvedBranch) {
    try {
      resolvedBranch = gitText(root, ['branch', '--show-current']);
    } catch {
      resolvedBranch = '';
    }
  }

  let files = [];
  try {
    const mergeBase = gitText(root, ['merge-base', base, head]);
    files = changedPaths(root, mergeBase, head);
  } catch {
    errors.push(`unable to inspect PR diff between ${base} and ${head}`);
  }
  const handoffs = files.filter(file => (
    file.startsWith(HANDOFF_DIRECTORY) &&
    file.endsWith('.json') &&
    file !== HANDOFF_TEMPLATE_PATH
  ));
  const cardFiles = files.filter(file => file.startsWith('card_boxes_json/'));
  const selfReviews = files.filter(file => file.startsWith('reviews/agent_self_review/') && file.endsWith('.json'));
  const scopedAudits = files.filter(file => file.startsWith('reviews/audit_scopes/') && file.endsWith('.json'));

  if (handoffs.length !== 1) errors.push(`exactly one git handoff record is required, got ${handoffs.length}`);
  if (cardFiles.length > 0) {
    if (!resolvedBranch.startsWith('content/')) errors.push('candidate card PR branch must use content/ prefix');
    if (selfReviews.length !== 1) errors.push(`candidate card PR requires one self-review record, got ${selfReviews.length}`);
    if (scopedAudits.length !== 1) errors.push(`candidate card PR requires one scoped audit record, got ${scopedAudits.length}`);
  }

  if (handoffs.length === 1) {
    const handoffPath = handoffs[0];
    let record;
    try {
      record = JSON.parse(gitText(root, ['show', `${head}:${handoffPath}`]));
    } catch {
      errors.push(`handoff record must be readable JSON at ${head}: ${handoffPath}`);
    }

    if (record !== undefined && (record === null || typeof record !== 'object' || Array.isArray(record))) {
      errors.push(`handoff record must be a JSON object: ${handoffPath}`);
      record = undefined;
    }

    if (record) {
      for (const field of ['branch', 'base_branch', 'commit_sha', 'push_ref', 'PR_url', 'PR_state', 'is_draft', 'validation', 'local_status', 'remaining_risks', 'merge_authority']) {
        if (!(field in record)) errors.push(`handoff record missing ${field}`);
      }
      if (record.branch !== resolvedBranch) errors.push(`handoff branch mismatch: ${record.branch} != ${resolvedBranch}`);
      if (record.base_branch !== baseBranch) errors.push(`handoff base mismatch: ${record.base_branch} != ${baseBranch}`);
      if (record.push_ref !== `origin/${record.branch}`) {
        errors.push(`handoff push_ref mismatch: ${record.push_ref} != origin/${record.branch}`);
      }

      const commitSha = String(record.commit_sha || '');
      let commitIsAncestor = false;
      if (!SHA1_RE.test(commitSha)) {
        errors.push('handoff commit_sha must be a full SHA');
      } else {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', commitSha, head], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          commitIsAncestor = true;
        } catch {
          errors.push('handoff commit_sha must be an ancestor of the PR head');
        }
      }

      let repository = null;
      try {
        repository = parseGitHubRepository(gitText(root, ['config', '--get', 'remote.origin.url']));
      } catch {
        errors.push('unable to resolve the GitHub repository from remote.origin.url');
      }
      if (!repository) errors.push('remote.origin.url must identify a GitHub repository');
      validateLocator(record, repository, errors);

      if (!Array.isArray(record.validation) || record.validation.length === 0) errors.push('handoff validation must be non-empty');
      if (!Array.isArray(record.remaining_risks)) errors.push('handoff remaining_risks must be an array');

      const touchedPaths = validateTouchedPaths(record, handoffPath, errors);
      if (commitIsAncestor && touchedPaths.length > 0) {
        validatePayloadBoundary({
          base,
          commitSha,
          handoffPath,
          head,
          record,
          root,
          touchedPaths,
          errors,
        });
      }
    }
  }

  return {
    schema_version: 'delivery-record-validation.v2',
    ok: errors.length === 0,
    branch: resolvedBranch,
    base_branch: baseBranch,
    handoffs,
    errors,
  };
}

function runCli() {
  const result = validateDeliveryRecord({
    base: option('--base', 'origin/main'),
    head: option('--head', 'HEAD'),
    branch: process.env.HEAD_BRANCH,
    baseBranch: process.env.BASE_BRANCH || 'main',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
