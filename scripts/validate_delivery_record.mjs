#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function git(...args) {
  return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
}

const base = option('--base', 'origin/main');
const head = option('--head', 'HEAD');
const branch = process.env.HEAD_BRANCH || git('branch', '--show-current');
const baseBranch = process.env.BASE_BRANCH || 'main';
const files = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
const handoffs = files.filter(file => file.startsWith('reviews/git_handoffs/') && file.endsWith('.json') && !file.endsWith('TEMPLATE.json'));
const cardFiles = files.filter(file => file.startsWith('card_boxes_json/'));
const selfReviews = files.filter(file => file.startsWith('reviews/agent_self_review/') && file.endsWith('.json'));
const scopedAudits = files.filter(file => file.startsWith('reviews/audit_scopes/') && file.endsWith('.json'));
const errors = [];

if (handoffs.length !== 1) errors.push(`exactly one git handoff record is required, got ${handoffs.length}`);
if (cardFiles.length > 0) {
  if (!branch.startsWith('content/')) errors.push('candidate card PR branch must use content/ prefix');
  if (selfReviews.length !== 1) errors.push(`candidate card PR requires one self-review record, got ${selfReviews.length}`);
  if (scopedAudits.length !== 1) errors.push(`candidate card PR requires one scoped audit record, got ${scopedAudits.length}`);
}

if (handoffs.length === 1) {
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, handoffs[0]), 'utf8'));
  for (const field of ['branch', 'base_branch', 'commit_sha', 'push_ref', 'PR_url', 'PR_state', 'is_draft', 'validation', 'local_status', 'remaining_risks', 'merge_authority']) {
    if (!(field in record)) errors.push(`handoff record missing ${field}`);
  }
  if (record.branch !== branch) errors.push(`handoff branch mismatch: ${record.branch} != ${branch}`);
  if (record.base_branch !== baseBranch) errors.push(`handoff base mismatch: ${record.base_branch} != ${baseBranch}`);
  if (!/^[0-9a-f]{40}$/.test(String(record.commit_sha || ''))) errors.push('handoff commit_sha must be a full SHA');
  else {
    try {
      git('merge-base', '--is-ancestor', record.commit_sha, head);
    } catch {
      errors.push('handoff commit_sha must be an ancestor of the PR head');
    }
  }
  if (!String(record.PR_url || '').startsWith('https://github.com/')) errors.push('handoff PR_url must be a GitHub URL');
  if (!Array.isArray(record.validation) || record.validation.length === 0) errors.push('handoff validation must be non-empty');
  if (!Array.isArray(record.remaining_risks)) errors.push('handoff remaining_risks must be an array');
}

const result = {schema_version: 'delivery-record-validation.v1', ok: errors.length === 0, branch, base_branch: baseBranch, handoffs, errors};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
