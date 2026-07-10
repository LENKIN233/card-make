#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_PATH = path.join(ROOT, 'reviews', 'candidate-review-queue.json');
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const required = process.argv.includes('--required');
const requireFive = process.argv.includes('--require-five');
const errors = [];

if (!fs.existsSync(QUEUE_PATH)) {
  const result = {schema_version: 'candidate-review-queue-validation.v1', ok: !required, initialized: false, errors: required ? ['candidate review queue is missing'] : []};
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  process.exit(0);
}

const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
if (queue.schema_version !== 'candidate-review-queue.v1') errors.push('schema_version must be candidate-review-queue.v1');
if (typeof queue.cutover_id !== 'string' || queue.cutover_id.length === 0) errors.push('cutover_id is required');
if (queue.limits?.active_candidate_prs !== 5) errors.push('active_candidate_prs limit must be 5');
if (queue.limits?.tooling_prs !== 1) errors.push('tooling_prs limit must be 1');
if (!Array.isArray(queue.entries)) errors.push('entries must be an array');

const entries = Array.isArray(queue.entries) ? queue.entries : [];
const ids = new Set();
const priorities = new Set();
for (const entry of entries) {
  if (!entry || typeof entry !== 'object') {
    errors.push('every entry must be an object');
    continue;
  }
  if (typeof entry.queue_id !== 'string' || entry.queue_id.length === 0) errors.push('entry queue_id is required');
  else if (ids.has(entry.queue_id)) errors.push(`duplicate queue_id ${entry.queue_id}`);
  else ids.add(entry.queue_id);
  if (!Number.isInteger(entry.priority) || entry.priority < 1) errors.push(`${entry.queue_id}: priority must be positive`);
  else if (priorities.has(entry.priority)) errors.push(`${entry.queue_id}: duplicate priority ${entry.priority}`);
  else priorities.add(entry.priority);
  if (!['active', 'parked', 'patch_pool', 'superseded'].includes(entry.status)) errors.push(`${entry.queue_id}: invalid status`);
  if (!SHA40_RE.test(String(entry.original?.head_sha || ''))) errors.push(`${entry.queue_id}: invalid original head_sha`);
  if (!SHA256_RE.test(String(entry.patch_sha256 || ''))) errors.push(`${entry.queue_id}: invalid patch_sha256`);
  if (!Array.isArray(entry.scope?.box_prefixes) || !Array.isArray(entry.scope?.card_ids)) errors.push(`${entry.queue_id}: invalid scope`);
  if (entry.status === 'active') {
    if (entry.scope?.box_prefixes?.length !== 1) errors.push(`${entry.queue_id}: active entry must contain one box prefix`);
    if (entry.scope?.card_ids?.length !== 3) errors.push(`${entry.queue_id}: active entry must contain three card ids`);
  }
  if (entry.formal_approval === true) {
    if (typeof entry.approval_record !== 'string' || !entry.approval_record.startsWith('reviews/approved_batches/')) {
      errors.push(`${entry.queue_id}: formal approval requires an approved_batches record`);
    } else if (!fs.existsSync(path.join(ROOT, entry.approval_record))) {
      errors.push(`${entry.queue_id}: approval record does not exist`);
    }
  } else if (entry.formal_approval !== false) {
    errors.push(`${entry.queue_id}: formal_approval must be boolean`);
  }
}

const active = entries.filter(entry => entry.status === 'active');
if (active.length > 5) errors.push(`active candidate limit exceeded: ${active.length}`);
if (requireFive && active.length !== 5) errors.push(`expected exactly five active candidates, got ${active.length}`);

const result = {
  schema_version: 'candidate-review-queue-validation.v1',
  ok: errors.length === 0,
  initialized: true,
  counts: {entries: entries.length, active: active.length, formally_approved: entries.filter(entry => entry.formal_approval === true).length},
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
