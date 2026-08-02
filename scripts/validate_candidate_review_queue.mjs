#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  validateCurrentApprovalRecordReference,
} from './lib/card_integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_QUEUE_PATH = path.join(ROOT, 'reviews', 'candidate-review-queue.json');
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

const required = process.argv.includes('--required');
const requireFive = process.argv.includes('--require-five');
const requireNonempty = process.argv.includes('--require-nonempty');
const verifyRemote = process.argv.includes('--verify-remote');
const queuePath = path.resolve(ROOT, option('--queue-path', DEFAULT_QUEUE_PATH));

if (!fs.existsSync(queuePath)) {
  const result = {
    schema_version: 'candidate-review-queue-validation.v1',
    ok: !required,
    initialized: false,
    errors: required ? ['candidate review queue is missing'] : [],
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  process.exit(0);
}

let remotePrs = null;
let remoteError = null;
if (verifyRemote) {
  try {
    remotePrs = JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'open',
          '--limit',
          '100',
          '--json',
          'number,isDraft,headRefName,headRefOid,baseRefName',
        ],
        {cwd: ROOT, encoding: 'utf8'},
      ),
    );
  } catch (error) {
    remoteError = `GitHub open PR snapshot unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

let queue;
try {
  queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
} catch (error) {
  const result = {
    schema_version: 'candidate-review-queue-validation.v1',
    ok: false,
    initialized: true,
    errors: [
      `candidate review queue is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const result = validateQueue(queue, {
  remoteError,
  remotePrs,
  requireFive,
  requireNonempty,
  verifyRemote,
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

function validateQueue(
  queue,
  {
    remoteError = null,
    remotePrs = null,
    requireFive = false,
    requireNonempty = false,
    root = ROOT,
    verifyRemote = false,
  } = {},
) {
  const errors = [];
  if (queue?.schema_version !== 'candidate-review-queue.v1') errors.push('schema_version must be candidate-review-queue.v1');
  if (typeof queue?.cutover_id !== 'string' || queue.cutover_id.length === 0) errors.push('cutover_id is required');
  if (queue?.limits?.active_candidate_prs !== 5) errors.push('active_candidate_prs limit must be 5');
  if (queue?.limits?.tooling_prs !== 1) errors.push('tooling_prs limit must be 1');
  if (!Array.isArray(queue?.entries)) errors.push('entries must be an array');

  const entries = Array.isArray(queue?.entries) ? queue.entries : [];
  const ids = new Set();
  const priorities = new Set();
  const activePrNumbers = new Map();
  const activeBoxPrefixes = new Map();
  const activeCardIds = new Map();
  let currentApprovalFingerprint = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      errors.push('every entry must be an object');
      continue;
    }

    const queueId = typeof entry.queue_id === 'string' && entry.queue_id.length > 0
      ? entry.queue_id
      : '<unknown-entry>';
    if (queueId === '<unknown-entry>') errors.push('entry queue_id is required');
    else if (ids.has(queueId)) errors.push(`duplicate queue_id ${queueId}`);
    else ids.add(queueId);
    if (!Number.isInteger(entry.priority) || entry.priority < 1) errors.push(`${queueId}: priority must be positive`);
    else if (priorities.has(entry.priority)) errors.push(`${queueId}: duplicate priority ${entry.priority}`);
    else priorities.add(entry.priority);
    if (!['active', 'merged_candidate', 'parked', 'patch_pool', 'superseded'].includes(entry.status)) {
      errors.push(`${queueId}: invalid status`);
    }
    if (!SHA40_RE.test(String(entry.original?.head_sha || ''))) errors.push(`${queueId}: invalid original head_sha`);
    if (typeof entry.original?.branch !== 'string' || entry.original.branch.length === 0) errors.push(`${queueId}: original branch is required`);
    if (!SHA256_RE.test(String(entry.patch_sha256 || ''))) errors.push(`${queueId}: invalid patch_sha256`);
    if (!Array.isArray(entry.scope?.box_prefixes) || !Array.isArray(entry.scope?.card_ids)) {
      errors.push(`${queueId}: invalid scope`);
    } else {
      validateUniqueValues(entry.scope.box_prefixes, `${queueId}: duplicate box prefix`, errors);
      validateUniqueValues(entry.scope.card_ids, `${queueId}: duplicate card id`, errors);
    }

    if (entry.status === 'active') {
      if (entry.scope?.box_prefixes?.length !== 1) errors.push(`${queueId}: active entry must contain one box prefix`);
      if (entry.scope?.card_ids?.length !== 3) errors.push(`${queueId}: active entry must contain three card ids`);
      if (!Number.isInteger(entry.new_pr_number) || entry.new_pr_number < 1) {
        errors.push(`${queueId}: active entry requires a positive new_pr_number`);
      } else if (activePrNumbers.has(entry.new_pr_number)) {
        errors.push(`${queueId}: duplicate active new_pr_number ${entry.new_pr_number} also used by ${activePrNumbers.get(entry.new_pr_number)}`);
      } else {
        activePrNumbers.set(entry.new_pr_number, queueId);
      }
      for (const boxPrefix of entry.scope?.box_prefixes ?? []) {
        recordExclusiveScope(activeBoxPrefixes, boxPrefix, queueId, 'box prefix', errors);
      }
      for (const cardId of entry.scope?.card_ids ?? []) {
        recordExclusiveScope(activeCardIds, cardId, queueId, 'card id', errors);
      }
    }

    if (entry.status === 'merged_candidate') {
      if (!Number.isInteger(entry.new_pr_number) || entry.new_pr_number < 1) {
        errors.push(`${queueId}: merged_candidate requires a positive new_pr_number`);
      }
      if (entry.formal_approval !== false) {
        errors.push(`${queueId}: merged_candidate cannot claim formal approval`);
      }
    }

    if (entry.formal_approval === true) {
      const approvalValidation = validateCurrentApprovalRecordReference({
        root,
        approvalPath: entry.approval_record,
        expectedCardIds: entry.scope?.card_ids,
        expectedBoxPrefixes: entry.scope?.box_prefixes,
        currentFingerprint: currentApprovalFingerprint,
      });
      currentApprovalFingerprint =
        currentApprovalFingerprint || approvalValidation.current_fingerprint;
      for (const issue of approvalValidation.issues) {
        errors.push(`${queueId}: current approval invalid (${issue.code})`);
      }
    } else if (entry.formal_approval !== false) {
      errors.push(`${queueId}: formal_approval must be boolean`);
    }
  }

  const active = entries.filter(entry => entry?.status === 'active');
  if (active.length > 5) errors.push(`active candidate limit exceeded: ${active.length}`);
  if (requireFive && active.length !== 5) errors.push(`expected exactly five active candidates, got ${active.length}`);
  if (requireNonempty && active.length === 0) errors.push('expected at least one active candidate');

  let remote = null;
  if (verifyRemote) {
    if (remoteError) {
      errors.push(remoteError);
    } else if (!Array.isArray(remotePrs)) {
      errors.push('GitHub open PR snapshot must be an array');
    } else {
      const candidatePrs = remotePrs.filter(pr => typeof pr?.headRefName === 'string' && pr.headRefName.startsWith('content/'));
      const candidateByNumber = new Map(candidatePrs.map(pr => [pr.number, pr]));
      const expectedNumbers = new Set(active.map(entry => entry.new_pr_number));

      for (const entry of active) {
        const pr = candidateByNumber.get(entry.new_pr_number);
        if (!pr) {
          errors.push(`${entry.queue_id}: open candidate PR #${entry.new_pr_number} is missing`);
          continue;
        }
        if (pr.isDraft !== true) errors.push(`${entry.queue_id}: PR #${pr.number} must remain draft`);
        if (pr.baseRefName !== 'main') errors.push(`${entry.queue_id}: PR #${pr.number} must target main`);
        if (pr.headRefName !== entry.original.branch) {
          errors.push(`${entry.queue_id}: PR #${pr.number} branch ${pr.headRefName} does not match ${entry.original.branch}`);
        }
      }

      for (const pr of candidatePrs) {
        if (!expectedNumbers.has(pr.number)) errors.push(`open candidate PR #${pr.number} is not mapped by an active queue entry`);
      }
      remote = {open_candidate_prs: candidatePrs.length, mapped_candidate_prs: active.length};
    }
  }

  return {
    schema_version: 'candidate-review-queue-validation.v1',
    ok: errors.length === 0,
    initialized: true,
    counts: {
      entries: entries.length,
      active: active.length,
      merged_candidate: entries.filter(entry => entry?.status === 'merged_candidate').length,
      formally_approved: entries.filter(entry => entry?.formal_approval === true).length,
    },
    remote,
    errors,
  };
}

function validateUniqueValues(values, prefix, errors) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${prefix} ${value}`);
    seen.add(value);
  }
}

function recordExclusiveScope(index, value, queueId, label, errors) {
  if (index.has(value)) {
    errors.push(`${queueId}: active ${label} ${value} overlaps ${index.get(value)}`);
    return;
  }
  index.set(value, queueId);
}

function runSelfTest() {
  const queue = JSON.parse(fs.readFileSync(DEFAULT_QUEUE_PATH, 'utf8'));
  const active = queue.entries.filter(entry => entry.status === 'active');
  const activeIndexes = queue.entries.flatMap((entry, index) =>
    entry.status === 'active' ? [index] : []
  );
  assert.ok(activeIndexes.length >= 2, 'self-test requires at least two active queue entries');
  const [firstActiveIndex, secondActiveIndex] = activeIndexes;
  const remotePrs = active.map(entry => ({
    baseRefName: 'main',
    headRefName: entry.original.branch,
    headRefOid: '0'.repeat(40),
    isDraft: true,
    number: entry.new_pr_number,
  }));
  assert.equal(validateQueue(queue, {remotePrs, requireNonempty: true, verifyRemote: true}).ok, true);
  assert.equal(validateQueue(queue, {requireFive: true}).ok, false);

  const emptyActive = structuredClone(queue);
  for (const entry of emptyActive.entries) {
    if (entry.status === 'active') entry.status = 'parked';
  }
  assert.equal(validateQueue(emptyActive).ok, true);
  assert.equal(validateQueue(emptyActive, {requireNonempty: true}).ok, false);

  const invalidMergedCandidate = structuredClone(queue);
  const mergedCandidate = invalidMergedCandidate.entries.find(
    entry => entry.status === 'merged_candidate',
  );
  assert.ok(mergedCandidate, 'self-test requires one merged candidate entry');
  mergedCandidate.new_pr_number = null;
  const invalidMergedResult = validateQueue(invalidMergedCandidate);
  assert.equal(invalidMergedResult.ok, false);
  assert.ok(invalidMergedResult.errors.some(
    error => error.includes('merged_candidate requires a positive new_pr_number'),
  ));

  const duplicatePr = structuredClone(queue);
  duplicatePr.entries[secondActiveIndex].new_pr_number =
    duplicatePr.entries[firstActiveIndex].new_pr_number;
  assert.equal(validateQueue(duplicatePr, {requireNonempty: true}).ok, false);

  const duplicateScope = structuredClone(queue);
  duplicateScope.entries[secondActiveIndex].scope =
    structuredClone(duplicateScope.entries[firstActiveIndex].scope);
  const duplicateScopeResult = validateQueue(duplicateScope, {requireNonempty: true});
  assert.equal(duplicateScopeResult.ok, false);
  assert.ok(duplicateScopeResult.errors.some(error => error.includes('overlaps')));

  const missingRemote = validateQueue(queue, {
    remotePrs: remotePrs.slice(1),
    requireNonempty: true,
    verifyRemote: true,
  });
  assert.equal(missingRemote.ok, false);
  assert.ok(missingRemote.errors.some(error => error.includes('is missing')));
  assert.equal(
    validateQueue(queue, {
      remoteError: 'GitHub open PR snapshot unavailable',
      requireNonempty: true,
      verifyRemote: true,
    }).ok,
    false,
  );

  const templateApproval = structuredClone(queue);
  templateApproval.entries[0].formal_approval = true;
  templateApproval.entries[0].approval_record =
    'reviews/approved_batches/TEMPLATE.json';
  const templateApprovalResult = validateQueue(templateApproval, {
    requireNonempty: true,
  });
  assert.equal(templateApprovalResult.ok, false);
  assert.ok(templateApprovalResult.errors.some(
    error => error.includes('approval_record_path_invalid'),
  ));

  const traversalApproval = structuredClone(queue);
  traversalApproval.entries[0].formal_approval = true;
  traversalApproval.entries[0].approval_record =
    'reviews/approved_batches/../forged.json';
  const traversalApprovalResult = validateQueue(traversalApproval, {
    requireNonempty: true,
  });
  assert.equal(traversalApprovalResult.ok, false);
  assert.ok(traversalApprovalResult.errors.some(
    error => error.includes('approval_record_path_invalid'),
  ));
  console.log('PASS: candidate queue uniqueness, remote mapping, and current approval boundary self-test.');
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
