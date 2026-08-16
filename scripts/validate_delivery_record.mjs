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
const REGULAR_HANDOFF_MODE = '100644';
const AUTO_MERGE_AUTHORITY = 'standing_user_delegation_auto_merge_for_validated_harness_or_tooling_PRs';
const CONTENT_NO_AUTO_MERGE_AUTHORITY = 'no_auto_merge_content_candidate_user_confirmation_required';
const CONTENT_CHANGE_TYPES = new Set([
  'content_sample',
  'content_candidate_front_answer_leak_queue',
  'content_candidate_residual_blocker_closure',
]);
const CHANGE_TYPE_AUTHORITIES = new Map([
  ['harness', AUTO_MERGE_AUTHORITY],
  ['tooling', AUTO_MERGE_AUTHORITY],
  ...[...CONTENT_CHANGE_TYPES].map(changeType => [changeType, CONTENT_NO_AUTO_MERGE_AUTHORITY]),
]);
const HANDOFF_ID_RE = /^[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC3339_WITH_ZONE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
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

function canonicalGitEnvironment(attributeSource) {
  const env = {};
  for (const key of V2_INHERITED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_ATTR_NOSYSTEM = '1';
  if (attributeSource) env.GIT_ATTR_SOURCE = attributeSource;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_GRAFT_FILE = os.devNull;
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

function gitBuffer(root, args, {attributeSource} = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: null,
    env: canonicalGitEnvironment(attributeSource),
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

function resolveCommitOid(root, ref, context) {
  const oid = gitText(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!SHA1_RE.test(oid)) {
    throw new Error(`${context} did not resolve to a SHA-1 commit`);
  }
  return oid;
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort(comparePaths);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidRfc3339Timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(RFC3339_WITH_ZONE_RE);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth && !Number.isNaN(Date.parse(value));
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

function assertNoRepositoryGrafts(root) {
  const commonGitDirectory = gitText(root, ['rev-parse', '--git-common-dir']);
  const resolvedCommonGitDirectory = path.isAbsolute(commonGitDirectory)
    ? commonGitDirectory
    : path.resolve(root, commonGitDirectory);
  const graftsPath = path.join(resolvedCommonGitDirectory, 'info', 'grafts');
  if (fs.existsSync(graftsPath) && fs.statSync(graftsPath).size > 0) {
    throw new Error(`delivery validation refuses non-empty repository grafts: ${graftsPath}`);
  }
}

function assertNoRepositoryInfoAttributes(root, commitSha) {
  const options = {attributeSource: commitSha};
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
      {attributeSource: commitSha},
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
  if (/[\\\x00-\x1f\x7f\u2028\u2029]/.test(value)) return false;
  if (value.endsWith('/') || path.posix.normalize(value) !== value) return false;
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  return segments[0] !== '.git';
}

function treeEntryAtCommit(root, commitOid, repositoryPath, context) {
  const bytes = gitBuffer(root, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    commitOid,
    '--',
    repositoryPath,
  ]);
  const entries = decodeGitUtf8(bytes, context)
    .split('\0')
    .filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length !== 1) {
    throw new Error(`${context} must resolve to at most one tree entry`);
  }
  const match = entries[0].match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]{40})\t([\s\S]*)$/);
  if (!match || match[4] !== repositoryPath) {
    throw new Error(`${context} does not exactly match ${repositoryPath}`);
  }
  return {
    mode: match[1],
    objectType: match[2],
    objectOid: match[3],
    repositoryPath: match[4],
  };
}

function readHandoffBlobAtHead(root, headOid, handoffPath, errors) {
  if (!isSafeRepositoryRelativePath(handoffPath)) {
    errors.push(`handoff record path is not a safe repository-relative path: ${JSON.stringify(handoffPath)}`);
    return null;
  }
  const childName = handoffPath.slice(HANDOFF_DIRECTORY.length);
  if (
    !handoffPath.startsWith(HANDOFF_DIRECTORY)
    || childName.length === 0
    || childName.includes('/')
    || !childName.endsWith('.json')
    || handoffPath === HANDOFF_TEMPLATE_PATH
  ) {
    errors.push(`handoff record must be a direct canonical JSON child of ${HANDOFF_DIRECTORY}`);
    return null;
  }

  let treeEntry;
  try {
    treeEntry = treeEntryAtCommit(root, headOid, handoffPath, 'git ls-tree handoff record');
  } catch {
    errors.push(`unable to inspect handoff record tree entry at ${headOid}: ${handoffPath}`);
    return null;
  }
  if (!treeEntry) {
    errors.push(`handoff record must resolve to exactly one tree entry at fixed HEAD: ${handoffPath}`);
    return null;
  }
  const {mode, objectType, objectOid} = treeEntry;
  if (mode !== REGULAR_HANDOFF_MODE || objectType !== 'blob') {
    errors.push(
      `handoff record must be a direct regular ${REGULAR_HANDOFF_MODE} blob at fixed HEAD: `
      + `${handoffPath} has ${mode} ${objectType}`,
    );
    return null;
  }

  try {
    return decodeGitUtf8(
      gitBuffer(root, ['cat-file', 'blob', objectOid]),
      `handoff record blob ${objectOid}`,
    ).trim();
  } catch {
    errors.push(`handoff record blob must be readable UTF-8 at fixed HEAD: ${handoffPath}`);
    return null;
  }
}

function readRegularJsonBlobAtHead(root, headOid, repositoryPath, errors, label) {
  if (!isSafeRepositoryRelativePath(repositoryPath)) {
    errors.push(`${label} path is not a safe repository-relative path: ${JSON.stringify(repositoryPath)}`);
    return null;
  }

  let treeEntry;
  try {
    treeEntry = treeEntryAtCommit(root, headOid, repositoryPath, `git ls-tree ${label}`);
  } catch {
    errors.push(`unable to inspect ${label} tree entry at ${headOid}: ${repositoryPath}`);
    return null;
  }
  if (!treeEntry || treeEntry.mode !== REGULAR_HANDOFF_MODE || treeEntry.objectType !== 'blob') {
    errors.push(`${label} must be a direct regular ${REGULAR_HANDOFF_MODE} blob at fixed HEAD: ${repositoryPath}`);
    return null;
  }

  try {
    const text = decodeGitUtf8(
      gitBuffer(root, ['cat-file', 'blob', treeEntry.objectOid]),
      `${label} blob ${treeEntry.objectOid}`,
    );
    const record = JSON.parse(text);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('not an object');
    }
    return record;
  } catch {
    errors.push(`${label} must be readable object JSON at fixed HEAD: ${repositoryPath}`);
    return null;
  }
}

function hasUniqueNonEmptyStrings(values) {
  return Array.isArray(values)
    && values.length > 0
    && values.every(value => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length;
}

function validateMultiPrefixResidualClosureBundle(
  root,
  headOid,
  handoff,
  selfReviews,
  scopedAudits,
  errors,
) {
  const declaredPrefixes = handoff.scope?.box_prefixes;
  if (
    handoff.scope?.change_type !== 'content_candidate_residual_blocker_closure'
    || handoff.scope?.multi_prefix_review_unit !== true
    || !hasUniqueNonEmptyStrings(declaredPrefixes)
    || typeof handoff.scope?.scope_reason !== 'string'
    || handoff.scope.scope_reason.trim().length === 0
  ) return false;

  if (selfReviews.length !== declaredPrefixes.length || scopedAudits.length !== declaredPrefixes.length) {
    errors.push(
      'multi-prefix residual-closure evidence requires exactly one self-review and one scoped audit per declared box prefix; '
      + `got ${declaredPrefixes.length} prefix(es), ${selfReviews.length} self-review(s), and ${scopedAudits.length} scoped audit(s)`,
    );
    return true;
  }

  const declaredPrefixSet = new Set(declaredPrefixes);
  const reviewPrefixes = new Set();
  const linkedAuditPaths = new Set();
  for (const reviewPath of selfReviews) {
    const review = readRegularJsonBlobAtHead(root, headOid, reviewPath, errors, 'candidate self-review');
    if (!review) continue;
    const prefixes = review.scope?.box_prefixes;
    if (!hasUniqueNonEmptyStrings(prefixes) || prefixes.length !== 1) {
      errors.push(`multi-prefix residual-closure self-review must cover exactly one box prefix: ${reviewPath}`);
      continue;
    }
    const prefix = prefixes[0];
    if (!declaredPrefixSet.has(prefix)) {
      errors.push(`multi-prefix residual-closure self-review covers an undeclared box prefix: ${reviewPath}`);
    }
    if (reviewPrefixes.has(prefix)) {
      errors.push(`multi-prefix residual-closure box prefix has multiple self-reviews: ${prefix}`);
    }
    reviewPrefixes.add(prefix);
    if (
      review.sample_policy?.review_scope_type !== 'residual_blocker_closure'
      || review.sample_policy?.residual_blocker_closure !== true
      || review.sample_policy?.not_sample_approval !== true
    ) {
      errors.push(`multi-prefix self-review must be explicit residual-blocker closure evidence: ${reviewPath}`);
    }
    const auditPath = review.quality_audit?.report;
    if (typeof auditPath !== 'string' || !scopedAudits.includes(auditPath)) {
      errors.push(`multi-prefix self-review must link one changed scoped audit: ${reviewPath}`);
    } else if (linkedAuditPaths.has(auditPath)) {
      errors.push(`multi-prefix scoped audit is linked by multiple self-reviews: ${auditPath}`);
    } else {
      linkedAuditPaths.add(auditPath);
    }
  }

  for (const prefix of declaredPrefixSet) {
    if (!reviewPrefixes.has(prefix)) {
      errors.push(`multi-prefix residual-closure box prefix is missing self-review evidence: ${prefix}`);
    }
  }
  for (const auditPath of scopedAudits) {
    if (!linkedAuditPaths.has(auditPath)) {
      errors.push(`multi-prefix residual-closure scoped audit is not linked by a self-review: ${auditPath}`);
    }
  }
  return true;
}

function validateCandidateEvidenceBundle(root, headOid, handoff, selfReviews, scopedAudits, errors) {
  if (selfReviews.length === 1 && scopedAudits.length === 1) return;

  if (headOid && validateMultiPrefixResidualClosureBundle(
    root,
    headOid,
    handoff,
    selfReviews,
    scopedAudits,
    errors,
  )) return;

  if (selfReviews.length !== 2 || scopedAudits.length !== 2 || !headOid) {
    errors.push(
      'candidate card PR requires either one self-review plus one scoped audit, '
      + 'or one sample/confirmed-expansion review pair with two linked scoped audits; '
      + `got ${selfReviews.length} self-review record(s) and ${scopedAudits.length} scoped audit record(s)`,
    );
    return;
  }

  const records = selfReviews.map(reviewPath => ({
    path: reviewPath,
    record: readRegularJsonBlobAtHead(root, headOid, reviewPath, errors, 'candidate self-review'),
  }));
  if (records.some(entry => !entry.record)) return;

  const sampleEntries = records.filter(
    entry => entry.record.sample_policy?.review_scope_type === 'three_card_sample_per_box',
  );
  const expansionEntries = records.filter(
    entry => entry.record.sample_policy?.review_scope_type === 'confirmed_box_expansion',
  );
  if (sampleEntries.length !== 1 || expansionEntries.length !== 1) {
    errors.push('two-record candidate evidence must contain exactly one three-card sample and one confirmed box expansion');
    return;
  }

  const sample = sampleEntries[0].record;
  const expansion = expansionEntries[0].record;
  const samplePrefixes = sample.scope?.box_prefixes;
  const expansionPrefixes = expansion.scope?.box_prefixes;
  const sampleCardIds = sample.scope?.card_ids;
  const expansionCardIds = expansion.scope?.card_ids;
  const sameSingleBox =
    hasUniqueNonEmptyStrings(samplePrefixes)
    && hasUniqueNonEmptyStrings(expansionPrefixes)
    && samplePrefixes.length === 1
    && expansionPrefixes.length === 1
    && samplePrefixes[0] === expansionPrefixes[0];
  if (!sameSingleBox) {
    errors.push('sample and confirmed-expansion self-reviews must cover the same single box prefix');
  }
  if (!hasUniqueNonEmptyStrings(sampleCardIds) || !hasUniqueNonEmptyStrings(expansionCardIds)) {
    errors.push('sample and confirmed-expansion self-reviews must declare unique non-empty scope.card_ids');
  } else if (sampleCardIds.some(cardId => new Set(expansionCardIds).has(cardId))) {
    errors.push('sample and confirmed-expansion self-review card scopes must be disjoint');
  }
  if (
    expansion.sample_policy?.confirmed_box_expansion !== true
    || expansion.sample_policy?.sample_confirmation_satisfied !== true
    || typeof expansion.sample_policy?.sample_confirmation_id !== 'string'
    || expansion.sample_policy.sample_confirmation_id.length === 0
  ) {
    errors.push('confirmed-expansion self-review must bind a satisfied named sample confirmation');
  }

  const linkedAuditPaths = records.map(entry => entry.record.quality_audit?.report);
  if (
    !hasUniqueNonEmptyStrings(linkedAuditPaths)
    || linkedAuditPaths.length !== scopedAudits.length
    || linkedAuditPaths.some(auditPath => !scopedAudits.includes(auditPath))
  ) {
    errors.push('sample and confirmed-expansion self-reviews must link exactly the two changed scoped audit records');
  }
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
    return null;
  }

  let locator;
  try {
    locator = new URL(rawUrl);
  } catch {
    errors.push('handoff PR_url must be a valid URL');
    return null;
  }
  if (
    locator.protocol !== 'https:'
    || locator.hostname.toLowerCase() !== 'github.com'
    || locator.port !== ''
    || locator.username !== ''
    || locator.password !== ''
    || locator.search !== ''
    || locator.hash !== ''
  ) {
    errors.push('handoff PR_url must be a canonical HTTPS github.com URL without credentials, query, or fragment');
    return null;
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(locator.pathname);
  } catch {
    errors.push('handoff PR_url path must use valid URL encoding');
    return null;
  }
  const segments = decodedPathname.split('/').filter(Boolean);
  if (segments.length < 4) {
    errors.push('handoff PR_url does not identify a GitHub pull request or parked comparison');
    return null;
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
      return null;
    }
    return {
      kind: 'pull_request',
      number: Number(locatorParts[0]),
      owner,
      repository: repositoryName,
      url: rawUrl,
    };
  }

  if (record.PR_state === PARKED_STATE) {
    const comparison = locatorParts.join('/');
    const expectedComparison = `${record.base_branch}...${record.branch}`;
    if (locatorKind !== 'compare' || comparison !== expectedComparison) {
      errors.push(`handoff PR_url for ${PARKED_STATE} must use /compare/${expectedComparison}`);
      return null;
    }
    return {
      kind: 'parked_compare',
      owner,
      repository: repositoryName,
      url: rawUrl,
    };
  }

  errors.push(`handoff PR_state is unsupported: ${record.PR_state}`);
  return null;
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
    assertNoRepositoryGrafts(root);
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
    attributeSource: patchFormat === PATCH_FORMAT_V2 ? commitSha : undefined,
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

function isSafeBranchName(value) {
  if (!hasText(value) || value === '@' || value.startsWith('-')) return false;
  if (/[/\.]$/.test(value) || value.startsWith('/') || value.includes('//')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  if (value.includes('..') || value.includes('@{')) return false;
  return value.split('/').every(segment => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.startsWith('.')
    && !segment.endsWith('.lock')
  ));
}

function validateStringArray(values, field, {allowEmpty}, errors) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    errors.push(`handoff ${field} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
    return;
  }
  const seen = new Set();
  for (const value of values) {
    if (!hasText(value)) {
      errors.push(`handoff ${field} entries must be non-empty strings`);
      continue;
    }
    if (seen.has(value)) errors.push(`handoff ${field} entries must be unique`);
    seen.add(value);
  }
}

function validateHandoffSchema(record, handoffPath, errors) {
  const requiredFields = [
    'handoff_id',
    'created_at',
    'agent',
    'branch',
    'base_branch',
    'commit_sha',
    'push_ref',
    'PR_url',
    'PR_state',
    'is_draft',
    'scope',
    'validation',
    'local_status',
    'remaining_risks',
    'merge_authority',
  ];
  for (const field of requiredFields) {
    if (!(field in record)) errors.push(`handoff record missing ${field}`);
  }

  const expectedHandoffId = path.posix.basename(handoffPath, '.json');
  if (!HANDOFF_ID_RE.test(String(record.handoff_id || ''))) {
    errors.push('handoff handoff_id must use YYYYMMDD-lowercase-slug form');
  } else if (record.handoff_id !== expectedHandoffId) {
    errors.push(`handoff handoff_id must equal its filename: ${record.handoff_id} != ${expectedHandoffId}`);
  }
  if (!isValidRfc3339Timestamp(record.created_at)) {
    errors.push('handoff created_at must be a valid RFC3339 timestamp with an explicit timezone');
  }
  if (!hasText(record.agent)) errors.push('handoff agent must be a non-empty string');
  if (!isSafeBranchName(record.branch)) errors.push('handoff branch must be a safe non-empty Git branch name');
  if (!isSafeBranchName(record.base_branch)) errors.push('handoff base_branch must be a safe non-empty Git branch name');
  if (typeof record.commit_sha !== 'string' || !SHA1_RE.test(record.commit_sha)) {
    errors.push('handoff commit_sha must be a full SHA string');
  }
  if (!hasText(record.push_ref)) errors.push('handoff push_ref must be a non-empty string');
  if (!hasText(record.PR_url)) errors.push('handoff PR_url must be a non-empty string');
  if (!REAL_PR_STATES.has(record.PR_state) && record.PR_state !== PARKED_STATE) {
    errors.push(`handoff PR_state must be one of OPEN, CLOSED, MERGED, or ${PARKED_STATE}`);
  }
  if (typeof record.is_draft !== 'boolean') errors.push('handoff is_draft must be a boolean');

  if (!isPlainObject(record.scope)) {
    errors.push('handoff scope must be an object');
  } else {
    const expectedAuthority = CHANGE_TYPE_AUTHORITIES.get(record.scope.change_type);
    if (!expectedAuthority) {
      errors.push(`handoff scope.change_type is unsupported: ${JSON.stringify(record.scope.change_type)}`);
    } else if (record.merge_authority !== expectedAuthority) {
      errors.push(
        `handoff merge_authority is inconsistent with scope.change_type ${record.scope.change_type}: `
        + `${record.merge_authority} != ${expectedAuthority}`,
      );
    }
  }

  if (!Array.isArray(record.validation) || record.validation.length === 0) {
    errors.push('handoff validation must be a non-empty array');
  } else {
    const commands = new Set();
    for (const entry of record.validation) {
      if (!isPlainObject(entry) || !hasText(entry.command) || !hasText(entry.result)) {
        errors.push('handoff validation entries must be objects with non-empty command and result strings');
        continue;
      }
      if (commands.has(entry.command)) errors.push('handoff validation commands must be unique');
      commands.add(entry.command);
    }
  }
  if (!hasText(record.local_status)) errors.push('handoff local_status must be a non-empty string');
  validateStringArray(record.remaining_risks, 'remaining_risks', {allowEmpty: true}, errors);
  if (!hasText(record.merge_authority)) errors.push('handoff merge_authority must be a non-empty string');
}

function validatePullRequestBinding({
  locator,
  pullRequest,
  record,
  repository,
  resolvedHeadOid,
  errors,
}) {
  if (!pullRequest || !isPlainObject(pullRequest)) {
    errors.push('current pull-request handoff requires exact pull-request event context');
    return;
  }

  const number = Number(pullRequest.number);
  if (!Number.isSafeInteger(number) || number <= 0) {
    errors.push('pull-request event number must be a positive integer');
  } else if (locator?.number !== number) {
    errors.push(`handoff PR number mismatch: ${locator?.number ?? 'unresolved'} != ${number}`);
  }
  if (!hasText(pullRequest.url) || record.PR_url !== pullRequest.url) {
    errors.push(`handoff PR_url must exactly equal the event URL: ${record.PR_url} != ${pullRequest.url}`);
  }
  if (!SHA1_RE.test(String(pullRequest.headSha || '')) || pullRequest.headSha !== resolvedHeadOid) {
    errors.push(`pull-request event head SHA must equal the explicit validated head: ${pullRequest.headSha} != ${resolvedHeadOid}`);
  }
  if (pullRequest.headBranch !== record.branch) {
    errors.push(`handoff branch must equal the event head branch: ${record.branch} != ${pullRequest.headBranch}`);
  }
  if (pullRequest.baseBranch !== record.base_branch) {
    errors.push(`handoff base_branch must equal the event base branch: ${record.base_branch} != ${pullRequest.baseBranch}`);
  }

  const expectedRepository = repository ? `${repository.owner}/${repository.repository}`.toLowerCase() : null;
  const eventHeadRepository = String(pullRequest.headRepository || '').toLowerCase();
  const eventBaseRepository = String(pullRequest.baseRepository || '').toLowerCase();
  if (!expectedRepository || eventBaseRepository !== expectedRepository) {
    errors.push(`pull-request event base repository must equal origin: ${pullRequest.baseRepository} != ${expectedRepository}`);
  }
  if (!expectedRepository || eventHeadRepository !== expectedRepository) {
    errors.push(`fork pull requests are not supported by origin/<branch> handoffs: ${pullRequest.headRepository} != ${expectedRepository}`);
  }

  const eventState = String(pullRequest.state || '').toLowerCase();
  const merged = pullRequest.merged;
  const isDraft = pullRequest.isDraft;
  if (typeof merged !== 'boolean') errors.push('pull-request event merged must be a boolean');
  if (typeof isDraft !== 'boolean') errors.push('pull-request event isDraft must be a boolean');
  let expectedState = null;
  if (eventState === 'open' && merged === false) expectedState = 'OPEN';
  else if (eventState === 'closed' && merged === true) expectedState = 'MERGED';
  else if (eventState === 'closed' && merged === false) expectedState = 'CLOSED';
  else errors.push('pull-request event state/merged combination is invalid');
  if (expectedState && record.PR_state !== expectedState) {
    errors.push(`handoff PR_state must equal the event state: ${record.PR_state} != ${expectedState}`);
  }
  if (typeof isDraft === 'boolean' && record.is_draft !== isDraft) {
    errors.push(`handoff is_draft must equal the event draft state: ${record.is_draft} != ${isDraft}`);
  }
}

function validateParkedPushRef(root, record, resolvedHeadOid, errors) {
  let pushedOid;
  try {
    pushedOid = resolveCommitOid(
      root,
      `refs/remotes/origin/${record.branch}`,
      'parked handoff push_ref',
    );
  } catch {
    errors.push(`parked handoff push_ref must resolve to refs/remotes/${record.push_ref}`);
    return;
  }
  if (pushedOid !== resolvedHeadOid) {
    errors.push(`parked handoff push_ref must equal the explicit validated head: ${pushedOid} != ${resolvedHeadOid}`);
  }
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

  try {
    const baseHandoffEntry = treeEntryAtCommit(
      root,
      mergeBase,
      handoffPath,
      'git ls-tree base handoff record',
    );
    if (baseHandoffEntry) {
      errors.push(`current handoff record must be append-only and absent at merge-base: ${handoffPath}`);
    }
    const payloadHandoffEntry = treeEntryAtCommit(
      root,
      commitSha,
      handoffPath,
      'git ls-tree payload handoff record',
    );
    if (payloadHandoffEntry) {
      errors.push(`current handoff record must be added after handoff commit_sha: ${handoffPath}`);
    }
  } catch {
    errors.push('unable to verify append-only handoff history');
  }

  try {
    const payloadHistoryPaths = changedPathsAcrossCommits(root, mergeBase, commitSha);
    const finalPayloadPaths = new Set(payloadChangedPaths);
    for (const changedPath of payloadHistoryPaths) {
      if (changedPath === handoffPath) {
        errors.push(`current handoff record changed before handoff commit_sha: ${handoffPath}`);
      } else if (!finalPayloadPaths.has(changedPath)) {
        errors.push(`payload history contains a transient or restored path: ${changedPath}`);
      }
    }
  } catch {
    errors.push('unable to inspect complete payload history through handoff commit_sha');
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
  if (patchFormat !== PATCH_FORMAT_V2) {
    errors.push(`current handoff scope.patch_format must equal ${PATCH_FORMAT_V2}`);
    return;
  }
  if (!SHA1_RE.test(String(declaredBaseCommit || ''))) {
    errors.push('handoff scope.base_commit_sha must be a full SHA for git-diff-binary-v2');
  } else if (declaredBaseCommit !== mergeBase) {
    errors.push(`handoff scope.base_commit_sha must equal merge-base: ${declaredBaseCommit} != ${mergeBase}`);
  }
  if (!SHA256_RE.test(String(patchSha256 || ''))) {
    errors.push('handoff scope.patch_sha256 must be a SHA-256 digest for git-diff-binary-v2');
  }
  if (!SHA256_RE.test(String(patchSha256 || ''))) return;
  if (!SHA1_RE.test(String(declaredBaseCommit || '')) || declaredBaseCommit !== mergeBase) return;

  try {
    const computedPatchSha256 = computePatchSha256({
      root,
      baseCommitSha: declaredBaseCommit,
      commitSha,
      touchedPaths,
      patchFormat: PATCH_FORMAT_V2,
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
  pullRequest,
} = {}) {
  const errors = [];
  try {
    assertNoRepositoryGrafts(root);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'unable to verify repository graft policy');
    return {
      schema_version: 'delivery-record-validation.v2',
      ok: false,
      branch: branch || '',
      base_branch: baseBranch,
      handoffs: [],
      errors,
    };
  }

  let resolvedBranch = branch;
  if (!resolvedBranch) {
    try {
      resolvedBranch = gitText(root, ['branch', '--show-current']);
    } catch {
      resolvedBranch = '';
    }
  }

  let resolvedBaseOid = null;
  let resolvedHeadOid = null;
  try {
    resolvedBaseOid = resolveCommitOid(root, base, 'base');
  } catch {
    errors.push(`unable to resolve base commit: ${base}`);
  }
  try {
    resolvedHeadOid = resolveCommitOid(root, head, 'head');
  } catch {
    errors.push(`unable to resolve head commit: ${head}`);
  }

  let files = [];
  try {
    if (!resolvedBaseOid || !resolvedHeadOid) throw new Error('unresolved commit');
    const mergeBase = gitText(root, ['merge-base', resolvedBaseOid, resolvedHeadOid]);
    files = changedPaths(root, mergeBase, resolvedHeadOid);
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
  }

  if (handoffs.length === 1) {
    const handoffPath = handoffs[0];
    let record;
    const recordText = resolvedHeadOid
      ? readHandoffBlobAtHead(root, resolvedHeadOid, handoffPath, errors)
      : null;
    if (recordText !== null) {
      try {
        record = JSON.parse(recordText);
      } catch {
        errors.push(`handoff record must be readable JSON at fixed HEAD: ${handoffPath}`);
      }
    }

    if (record !== undefined && (record === null || typeof record !== 'object' || Array.isArray(record))) {
      errors.push(`handoff record must be a JSON object: ${handoffPath}`);
      record = undefined;
    }

    if (record) {
      validateHandoffSchema(record, handoffPath, errors);
      if (cardFiles.length > 0) {
        validateCandidateEvidenceBundle(root, resolvedHeadOid, record, selfReviews, scopedAudits, errors);
      }
      if (cardFiles.length > 0 && !CONTENT_CHANGE_TYPES.has(record.scope?.change_type)) {
        errors.push('candidate card payload must use a content change_type and no-auto-merge authority');
      }
      if (record.branch !== resolvedBranch) errors.push(`handoff branch mismatch: ${record.branch} != ${resolvedBranch}`);
      if (record.base_branch !== baseBranch) errors.push(`handoff base mismatch: ${record.base_branch} != ${baseBranch}`);
      if (record.push_ref !== `origin/${record.branch}`) {
        errors.push(`handoff push_ref mismatch: ${record.push_ref} != origin/${record.branch}`);
      }

      const commitSha = typeof record.commit_sha === 'string' ? record.commit_sha : '';
      let commitIsAncestor = false;
      let resolvedCommitSha = null;
      if (!SHA1_RE.test(commitSha)) {
        errors.push('handoff commit_sha must be a full SHA');
      } else {
        try {
          resolvedCommitSha = resolveCommitOid(root, commitSha, 'handoff commit_sha');
          if (resolvedCommitSha !== commitSha) {
            throw new Error('handoff commit_sha is not a direct commit object');
          }
          if (!resolvedHeadOid) throw new Error('unresolved head');
          gitBuffer(root, ['merge-base', '--is-ancestor', resolvedCommitSha, resolvedHeadOid]);
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
      const locator = validateLocator(record, repository, errors);
      if (REAL_PR_STATES.has(record.PR_state)) {
        validatePullRequestBinding({
          locator,
          pullRequest,
          record,
          repository,
          resolvedHeadOid,
          errors,
        });
      } else if (record.PR_state === PARKED_STATE) {
        if (pullRequest !== undefined && pullRequest !== null) {
          errors.push('parked handoff must not carry pull-request event context');
        }
        if (resolvedHeadOid) validateParkedPushRef(root, record, resolvedHeadOid, errors);
      }

      const touchedPaths = validateTouchedPaths(record, handoffPath, errors);
      if (
        commitIsAncestor
        && resolvedBaseOid
        && resolvedHeadOid
        && resolvedCommitSha
        && touchedPaths.length > 0
      ) {
        validatePayloadBoundary({
          base: resolvedBaseOid,
          commitSha: resolvedCommitSha,
          handoffPath,
          head: resolvedHeadOid,
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
  const parseEventBoolean = value => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  };
  const pullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? {
      number: process.env.DELIVERY_PR_NUMBER,
      url: process.env.DELIVERY_PR_URL,
      state: process.env.DELIVERY_PR_STATE,
      merged: parseEventBoolean(process.env.DELIVERY_PR_MERGED),
      isDraft: parseEventBoolean(process.env.DELIVERY_PR_DRAFT),
      headSha: process.env.DELIVERY_HEAD_SHA,
      headBranch: process.env.DELIVERY_HEAD_BRANCH,
      headRepository: process.env.DELIVERY_HEAD_REPOSITORY,
      baseBranch: process.env.DELIVERY_BASE_BRANCH,
      baseRepository: process.env.DELIVERY_BASE_REPOSITORY,
    }
    : undefined;
  const result = validateDeliveryRecord({
    base: option('--base', 'origin/main'),
    head: option('--head', 'HEAD'),
    branch: process.env.HEAD_BRANCH,
    baseBranch: process.env.BASE_BRANCH || 'main',
    pullRequest,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
