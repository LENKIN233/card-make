#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
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
const labels = (() => {
  try {
    const parsed = JSON.parse(process.env.PR_LABELS || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
const files = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
const errors = [];
const cardFiles = files.filter(file => file.startsWith('card_boxes_json/'));
const toolingFiles = files.filter(file => file.startsWith('scripts/') || file.startsWith('spec/') || file.startsWith('.github/'));
const approvalFiles = files.filter(file => (
  file.startsWith('reviews/approved_batches/') ||
  file.startsWith('reviews/controlled_pilot_approvals/')
) && file.endsWith('.json') && !file.endsWith('/TEMPLATE.json'));
const reportFiles = files.filter(file => file === 'reports/card_quality_audit_report.json' || file === 'reports/card_validation_report.json');
const audioFiles = files.filter(file => file.startsWith('ai_tts/'));

if (cardFiles.length > 0 && toolingFiles.length > 0) errors.push('content and tooling/harness changes must not share one PR');
if (cardFiles.length > 0 && audioFiles.length > 0) errors.push('candidate card and audio asset changes must use separate PRs');
if (reportFiles.length > 0) errors.push('generated global reports must not be committed');
if (approvalFiles.length > 0 && !labels.includes('approval:authorized')) {
  errors.push('formal approval changes require the approval:authorized label and explicit user approval evidence');
}

const result = {
  schema_version: 'delivery-boundary-validation.v1',
  ok: errors.length === 0,
  counts: {files: files.length, card_files: cardFiles.length, tooling_files: toolingFiles.length, approval_files: approvalFiles.length, audio_files: audioFiles.length},
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
