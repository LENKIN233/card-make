#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_PRS = new Set([94, 95, 96, 97]);

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function showJson(gitDir, commit, file) {
  return JSON.parse(execFileSync('git', [`--git-dir=${gitDir}`, 'show', `${commit}:${file}`], {encoding: 'utf8'}));
}

function scopeFor(gitDir, commit, files) {
  const scopes = files
    .filter(file => file.startsWith('reviews/agent_self_review/') && file.endsWith('.json'))
    .map(file => showJson(gitDir, commit, file).scope)
    .filter(Boolean);
  return {
    box_prefixes: [...new Set(scopes.flatMap(scope => scope.box_prefixes || []))].sort(),
    card_ids: [...new Set(scopes.flatMap(scope => scope.card_ids || []))].sort(),
  };
}

const archiveRoot = option('--archive-root');
const remoteGitDir = option('--remote-git-dir');
const localGitDir = option('--local-git-dir');
const output = path.resolve(ROOT, option('--output', 'reviews/candidate-review-queue.json'));
if (!archiveRoot || !remoteGitDir || !localGitDir) {
  throw new Error('--archive-root, --remote-git-dir, and --local-git-dir are required');
}

const metadataDir = path.join(archiveRoot, 'card-pr-patches', 'open-pr-metadata');
const metadata = fs.readdirSync(metadataDir)
  .filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(fs.readFileSync(path.join(metadataDir, file), 'utf8')));
const byNumber = new Map(metadata.map(entry => [entry.pr.number, entry]));
const orderedNumbers = [94, 95, 96, 97, 1111, 50, ...[...byNumber.keys()].filter(number => ![94, 95, 96, 97, 50].includes(number)).sort((a, b) => a - b)];
const entries = [];

for (let index = 0; index < orderedNumbers.length; index += 1) {
  const number = orderedNumbers[index];
  if (number === 1111) {
    const commit = 'a133310b3b2d60a1767e80caed8b72597258d028';
    const reviewFile = 'reviews/agent_self_review/20260710-cet6-reading-1111-revised-sample.json';
    const patchPath = path.join(archiveRoot, 'card-pr-patches', 'branch-content-cet6-reading-1111-sample-review.patch');
    const patchSha = execFileSync('shasum', ['-a', '256', patchPath], {encoding: 'utf8'}).split(/\s+/)[0];
    entries.push({
      queue_id: 'local-branch-1111',
      status: 'active',
      priority: index + 1,
      original: {pr_number: null, branch: 'content/cet6-reading-1111-sample-review', head_sha: commit},
      scope: scopeFor(localGitDir, commit, [reviewFile]),
      patch_sha256: patchSha,
      new_pr_number: null,
      formal_approval: false,
      approval_record: null,
    });
    continue;
  }
  const archived = byNumber.get(number);
  const status = ACTIVE_PRS.has(number) ? 'active' : number === 50 ? 'patch_pool' : 'parked';
  entries.push({
    queue_id: `original-pr-${number}`,
    status,
    priority: index + 1,
    original: {pr_number: number, branch: archived.pr.headRefName, head_sha: archived.pr.headRefOid},
    scope: scopeFor(remoteGitDir, archived.pr.headRefOid, archived.files),
    patch_sha256: archived.patchSha256,
    new_pr_number: null,
    formal_approval: false,
    approval_record: null,
  });
}

const payload = {
  schema_version: 'candidate-review-queue.v1',
  cutover_id: 'history-cutover-2026-07-10',
  limits: {active_candidate_prs: 5, tooling_prs: 1},
  entries,
};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({output: path.relative(ROOT, output), entries: entries.length, active: entries.filter(entry => entry.status === 'active').length}, null, 2));
