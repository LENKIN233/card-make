#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PERCEPTUAL_CHECKS,
  audioPerceptualDecisionInputSha256,
  canonicalStringify,
  reviewAudioPerceptualEntry,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const CONTENT_VERSION_RE = /^sha256:[0-9a-f]{64}$/;
const GENERAL_RESULT_TO_CHECK = Object.freeze({
  audio_matches_text: 'matches_text',
  target_signal_audible: 'target_signal_audible',
  accurate_pronunciation: 'accurate_pronunciation',
  suitable_speed: 'suitable_speed',
  natural_rhythm: 'natural_rhythm',
  stress_and_pauses_do_not_mislead: 'stress_pauses_do_not_mislead',
  no_unwanted_noise_or_clipping: 'no_unwanted_noise_or_clipping',
});
const SPECIALIST_CHECK = Object.freeze({
  pronunciation: 'accurate_pronunciation',
  blind_transcript: 'audio_matches_text',
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalStringify(actual) !== canonicalStringify(wanted)) {
    throw new Error(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function requireSha(value, label) {
  const normalized = String(value || '').replace(/^sha256:/, '');
  if (!SHA256_RE.test(normalized) || /^([0-9a-f])\1{63}$/.test(normalized)) {
    throw new Error(`${label} must be a non-placeholder SHA-256`);
  }
  return normalized;
}

function safeRegularFile(root, relativePath, label, {maximumBytes = 8 * 1024 * 1024} = {}) {
  if (
    typeof relativePath !== 'string' ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`${label} path is unsafe`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes its root`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist`);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error(`${label} must be a non-empty regular file no larger than ${maximumBytes} bytes`);
  }
  return {bytes: fs.readFileSync(resolved), path: resolved, size_bytes: stats.size};
}

function readJsonFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > 8 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return {bytes: fs.readFileSync(filePath), value: JSON.parse(fs.readFileSync(filePath, 'utf8'))};
}

function readJsonl(bytes, label) {
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
    }
  });
}

function validateAuthorization(authorization, authorizationBytes, root) {
  if (
    authorization?.schema_version !== 'model-owned-content-authorization.v2' ||
    authorization?.authorization_mode !== 'full_track' ||
    authorization?.scope?.track !== 'cet4' ||
    authorization?.scope?.purpose !== 'formal_content' ||
    !CONTENT_VERSION_RE.test(authorization?.content_version || '') ||
    authorization?.scope?.card_ids?.length !== 1180 ||
    new Set(authorization.scope.card_ids).size !== 1180 ||
    authorization?.scope?.box_prefixes?.length !== 108 ||
    new Set(authorization.scope.box_prefixes).size !== 108
  ) {
    throw new Error('content authorization does not bind exact CET4 1180/108 scope');
  }
  const bindings = [
    ['model review', authorization.validation?.model_review, authorization.validation?.model_review_sha256],
    ['quality audit', authorization.card_quality_audit?.report, authorization.card_quality_audit?.report_sha256],
  ];
  const loaded = {};
  for (const [name, relativePath, expectedSha] of bindings) {
    const file = safeRegularFile(root, relativePath, name);
    const observedSha = sha256(file.bytes);
    if (observedSha !== requireSha(expectedSha, `${name} expected SHA-256`)) {
      throw new Error(`${name} SHA-256 does not match authorization`);
    }
    loaded[name] = {relativePath, sha256: observedSha};
  }
  if (
    authorization.card_quality_audit?.scope_has_no_hard_blockers !== true ||
    authorization.card_quality_audit?.scope_summary?.card_count !== 1180 ||
    authorization.card_quality_audit?.scope_summary?.by_severity?.hard_blocker !== 0 ||
    authorization.card_quality_audit?.scope_summary?.by_severity?.content_risk !== 0 ||
    authorization.card_quality_audit?.scope_summary?.by_severity?.review_gap !== 0
  ) {
    throw new Error('content authorization quality audit is not exact and clean');
  }
  return {
    authorization_sha256: sha256(authorizationBytes),
    model_review_sha256: loaded['model review'].sha256,
    quality_audit_sha256: loaded['quality audit'].sha256,
  };
}

function validateRunPackage(runPackage, runRoot, worklist) {
  exactKeys(
    runPackage,
    ['schema_version', 'model', 'execution', 'runs', 'decisions', 'result'],
    'run package',
  );
  if (runPackage.schema_version !== 'trusted-media-model-run-package.v1') {
    throw new Error('run package schema is invalid');
  }
  exactKeys(runPackage.model, ['id', 'revision', 'weights_manifest_sha256'], 'run package model');
  if (!/^[0-9a-f]{40}$/.test(runPackage.model.revision || '')) {
    throw new Error('run package model revision is invalid');
  }
  requireSha(runPackage.model.weights_manifest_sha256, 'model weights manifest');
  exactKeys(
    runPackage.execution,
    ['workflow_run_id', 'workflow_run_attempt', 'runner_class', 'started_at', 'completed_at'],
    'run package execution',
  );
  if (
    !/^[1-9][0-9]{5,19}$/.test(runPackage.execution.workflow_run_id || '') ||
    !Number.isInteger(runPackage.execution.workflow_run_attempt) ||
    runPackage.execution.workflow_run_attempt < 1 ||
    runPackage.execution.runner_class !== 'self_hosted_macos_arm64' ||
    !Number.isFinite(Date.parse(runPackage.execution.started_at)) ||
    !Number.isFinite(Date.parse(runPackage.execution.completed_at)) ||
    Date.parse(runPackage.execution.completed_at) <= Date.parse(runPackage.execution.started_at)
  ) {
    throw new Error('run package execution identity is invalid');
  }
  if (!Array.isArray(runPackage.runs) || runPackage.runs.length < 2) {
    throw new Error('run package must contain at least two runs');
  }
  const runMap = new Map();
  for (const run of runPackage.runs) {
    exactKeys(
      run,
      ['name', 'run_id', 'purpose', 'temperature', 'path', 'sha256', 'size_bytes', 'card_count', 'complete_asset_count'],
      `run ${String(run?.name)}`,
    );
    if (runMap.has(run.name)) throw new Error(`duplicate run name ${run.name}`);
    const file = safeRegularFile(runRoot, run.path, `run ${run.name}`);
    if (
      sha256(file.bytes) !== requireSha(run.sha256, `run ${run.name} SHA-256`) ||
      file.size_bytes !== run.size_bytes
    ) {
      throw new Error(`run ${run.name} file identity does not match package`);
    }
    const records = readJsonl(file.bytes, `run ${run.name}`);
    if (
      records.length !== run.card_count ||
      run.complete_asset_count !== run.card_count ||
      records.some(record => record.complete_asset_consumed !== true || record.status !== 'ok')
    ) {
      throw new Error(`run ${run.name} does not prove complete exact-asset consumption`);
    }
    runMap.set(run.name, {...run, records: new Map(records.map(record => [record.card_id, record]))});
  }
  const fullRuns = [...runMap.values()].filter(run => run.purpose === 'full_perceptual');
  if (
    fullRuns.length < 2 ||
    fullRuns.some(run => run.card_count !== 301) ||
    new Set(fullRuns.map(run => run.sha256)).size !== fullRuns.length
  ) {
    throw new Error('run package lacks two distinct complete 301-asset perceptual runs');
  }
  if (!Array.isArray(runPackage.decisions) || runPackage.decisions.length !== 301) {
    throw new Error('run package must contain exactly 301 decisions');
  }
  const decisions = new Map();
  for (const decision of runPackage.decisions) {
    exactKeys(decision, ['card_id', 'checks', 'acceptance_sources'], `decision ${decision?.card_id}`);
    if (decisions.has(decision.card_id)) throw new Error(`duplicate decision ${decision.card_id}`);
    exactKeys(decision.checks, PERCEPTUAL_CHECKS, `decision ${decision.card_id} checks`);
    if (PERCEPTUAL_CHECKS.some(check => typeof decision.checks[check] !== 'boolean')) {
      throw new Error(`decision ${decision.card_id} checks must be booleans`);
    }
    if (
      !Array.isArray(decision.acceptance_sources) ||
      decision.acceptance_sources.length !== 2 ||
      decision.acceptance_sources.some(group => !Array.isArray(group) || group.length < 1 || group.length > 3)
    ) {
      throw new Error(`decision ${decision.card_id} must have two bounded acceptance groups`);
    }
    decisions.set(decision.card_id, decision);
  }
  if (
    worklist.entries.some(entry => !decisions.has(entry.card_id)) ||
    runPackage.result?.reviewed_card_count !== 301 ||
    runPackage.result?.passed_card_count !== 301 ||
    runPackage.result?.failed_card_count !== 0
  ) {
    throw new Error('run package result is not an exact 301-card pass');
  }
  return {decisions, runMap};
}

function validateAcceptanceGroup({decision, entry, group, runMap, groupIndex}) {
  if (new Set(group).size !== group.length) {
    throw new Error(`decision ${entry.card_id} acceptance group reuses a run`);
  }
  const runs = group.map(name => {
    const run = runMap.get(name);
    if (!run) throw new Error(`decision ${entry.card_id} references unknown run ${name}`);
    const record = run.records.get(entry.card_id);
    if (!record) throw new Error(`run ${name} omits decision card ${entry.card_id}`);
    if (
      record.entry_identity_sha256 !== entry.entry_identity_sha256 ||
      record.asset_sha256 !== entry.audio.file_sha256 ||
      record.complete_asset_consumed !== true
    ) {
      throw new Error(`run ${name} does not bind exact entry and asset for ${entry.card_id}`);
    }
    return {name, record, run};
  });
  const general = runs.filter(({run}) => ['full_perceptual', 'adjudication'].includes(run.purpose));
  if (general.length !== 1) {
    throw new Error(`decision ${entry.card_id} acceptance group must contain one general run`);
  }
  const specialistChecks = new Set();
  for (const {record, run} of runs) {
    if (run.purpose === 'pronunciation') {
      if (record.result?.accurate_pronunciation !== true) {
        throw new Error(`decision ${entry.card_id} pronunciation specialist did not pass`);
      }
      specialistChecks.add(SPECIALIST_CHECK[run.purpose]);
    } else if (run.purpose === 'blind_transcript') {
      if (!(record.transcript_similarity >= 0.85)) {
        throw new Error(`decision ${entry.card_id} transcript specialist did not pass`);
      }
      specialistChecks.add(SPECIALIST_CHECK[run.purpose]);
    }
  }
  const generalResult = general[0].record.result;
  for (const check of PERCEPTUAL_CHECKS) {
    if (specialistChecks.has(check)) {
      if (decision.checks[check] !== true) {
        throw new Error(`decision ${entry.card_id} specialist override is not pass`);
      }
    } else if (Boolean(generalResult?.[GENERAL_RESULT_TO_CHECK[check]]) !== decision.checks[check]) {
      throw new Error(`decision ${entry.card_id} check ${check} does not match general run`);
    }
  }
  return {
    sourceNames: group,
    reviewedAt: runMap.executionCompletedAt,
    generalName: general[0].name,
    groupIndex,
  };
}

function artifactIdentity(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {sha256: sha256(bytes), size_bytes: bytes.length};
}

function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  fs.writeFileSync(filePath, bytes, {flag: 'wx'});
  return {sha256: sha256(bytes), size_bytes: bytes.length};
}

export function buildTrustedMediaArtifacts({
  authorizationPath,
  outputDir,
  repoRoot = ROOT,
  runPackagePath,
  sourceCommit,
  worklistPath,
  createdAt = new Date(),
} = {}) {
  if (!COMMIT_RE.test(sourceCommit || '')) throw new Error('source commit is invalid');
  const worklistFile = readJsonFile(worklistPath, 'pending worklist');
  const authorizationFile = readJsonFile(authorizationPath, 'content authorization');
  const runPackageFile = readJsonFile(runPackagePath, 'run package');
  const worklist = worklistFile.value;
  if (
    worklist?.schema_version !== 'audio-perceptual-worklist.v3' ||
    worklist?.track !== 'cet4' ||
    worklist?.entries?.length !== 301 ||
    worklist.entries.some(entry => entry?.review?.status !== 'pending')
  ) {
    throw new Error('trusted builder requires an exact fully pending 301-card CET4 worklist');
  }
  const technicalAuditFile = safeRegularFile(
    repoRoot,
    worklist.source_technical_audit?.path,
    'source technical audit',
  );
  if (sha256(technicalAuditFile.bytes) !== worklist.source_technical_audit?.file_sha256) {
    throw new Error('source technical audit SHA-256 does not match worklist');
  }
  const worklistIssues = validateAudioPerceptualWorklist(worklist, {
    root: repoRoot,
    technicalAudit: JSON.parse(technicalAuditFile.bytes.toString('utf8')),
  });
  if (worklistIssues.length > 0) {
    throw new Error(`pending worklist is invalid: ${worklistIssues.join('; ')}`);
  }
  const authorizationIdentity = validateAuthorization(
    authorizationFile.value,
    authorizationFile.bytes,
    repoRoot,
  );
  const authorizedCards = new Set(authorizationFile.value.scope.card_ids);
  if (worklist.entries.some(entry => !authorizedCards.has(entry.card_id))) {
    throw new Error('audio worklist contains a card outside authorization');
  }
  const runRoot = path.dirname(runPackagePath);
  if (path.resolve(outputDir) !== path.resolve(runRoot)) {
    throw new Error('output directory must equal the trusted run-package directory');
  }
  const outputStats = fs.lstatSync(outputDir);
  if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
    throw new Error('output directory must be a regular directory');
  }
  const validated = validateRunPackage(runPackageFile.value, runRoot, worklist);
  validated.runMap.executionCompletedAt = runPackageFile.value.execution.completed_at;
  let reviewed = structuredClone(worklist);
  for (const entry of worklist.entries) {
    const decision = validated.decisions.get(entry.card_id);
    const groups = decision.acceptance_sources.map((group, groupIndex) =>
      validateAcceptanceGroup({
        decision,
        entry,
        group,
        groupIndex,
        runMap: validated.runMap,
      }),
    );
    if (groups[0].generalName === groups[1].generalName) {
      throw new Error(`decision ${entry.card_id} reuses one general run`);
    }
    const checks = Object.fromEntries(
      PERCEPTUAL_CHECKS.map(check => [check, decision.checks[check] ? 'pass' : 'fail']),
    );
    const inputSha256 = audioPerceptualDecisionInputSha256(entry, checks);
    const modelAcceptances = groups.map(group => ({
      schema_version: 'model-acceptance.v2',
      actor: {
        kind: 'model_harness',
        agent: `trusted-media-${group.sourceNames.join('')}`,
        model: runPackageFile.value.model.id,
        run_id: `${runPackageFile.value.execution.workflow_run_id}:${entry.card_id}:${group.sourceNames.join('')}`,
      },
      evidence: {
        reviewed_at: group.reviewedAt,
        input_sha256: inputSha256,
        capabilities: ['audio_perceptual_review'],
        summary: `Trusted exact-asset source runs ${group.sourceNames.join('+')} accept the seven bound perceptual checks for ${entry.card_id}.`,
        findings: [],
      },
      decision: 'accepted',
    }));
    reviewed = reviewAudioPerceptualEntry({
      cardId: entry.card_id,
      checkUpdates: PERCEPTUAL_CHECKS.map(name => ({name, value: checks[name]})),
      clock: () => new Date(runPackageFile.value.execution.completed_at),
      completeAssetConsumed: true,
      modelAcceptances,
      notes: 'Two independent GitHub-attested exact-asset evidence groups accept all seven checks.',
      worklist: reviewed,
    });
  }
  const reviewedIssues = validateAudioPerceptualWorklist(reviewed, {
    requireComplete: true,
    root: repoRoot,
    technicalAudit: JSON.parse(technicalAuditFile.bytes.toString('utf8')),
  });
  if (reviewedIssues.length > 0 || reviewed.progress?.passed !== 301) {
    throw new Error(`reviewed worklist is invalid: ${reviewedIssues.join('; ')}`);
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, {recursive: true});
  const reviewedPath = path.join(outputDir, 'reviewed-worklist.json');
  const reviewedIdentity = writeJson(reviewedPath, reviewed);
  const audioManifest = {
    schema_version: 'trusted-media-audio-manifest.v1',
    track: 'cet4',
    asset_count: 301,
    assets: reviewed.entries.map(entry => ({
      card_id: entry.card_id,
      asset_path: entry.audio.asset_path,
      file_sha256: entry.audio.file_sha256,
      size_bytes: entry.audio.size_bytes,
      transcript_sha256: entry.audio.transcript_sha256,
    })),
  };
  const audioManifestPath = path.join(outputDir, 'audio-manifest.json');
  const audioManifestIdentity = writeJson(audioManifestPath, audioManifest);
  const rawRunManifest = {
    schema_version: 'trusted-media-raw-run-manifest.v1',
    model: runPackageFile.value.model,
    runs: runPackageFile.value.runs.map(run => ({
      name: run.name,
      run_id: run.run_id,
      purpose: run.purpose,
      path: run.path,
      sha256: run.sha256,
      size_bytes: run.size_bytes,
      card_count: run.card_count,
      complete_asset_count: run.complete_asset_count,
    })),
  };
  const rawRunManifestPath = path.join(outputDir, 'raw-run-manifest.json');
  const rawRunManifestIdentity = writeJson(rawRunManifestPath, rawRunManifest);
  const driverPaths = [
    'scripts/run_trusted_media_review.py',
    'scripts/build_trusted_media_run_receipt.mjs',
    'scripts/manage_audio_perceptual_worklist.mjs',
    'spec/trusted-media-runner-lock.json',
  ];
  const driverBundle = driverPaths.map(relativePath => {
    const file = safeRegularFile(repoRoot, relativePath, `driver ${relativePath}`);
    return {path: relativePath, sha256: sha256(file.bytes), size_bytes: file.size_bytes};
  });
  const driverBundleSha256 = sha256(Buffer.from(canonicalStringify(driverBundle)));
  const lockFile = safeRegularFile(repoRoot, 'spec/trusted-media-runner-lock.json', 'runner lock');
  const workflowFile = safeRegularFile(repoRoot, '.github/workflows/trusted-media-run.yml', 'trusted media workflow');
  const receipt = {
    schema_version: 'trusted-media-run-receipt.v1',
    receipt_id: `cet4-audio-${runPackageFile.value.execution.workflow_run_id}-${runPackageFile.value.execution.workflow_run_attempt}`,
    created_at: createdAt.toISOString(),
    source: {
      repository: 'LENKIN233/card-make',
      ref: 'refs/heads/main',
      commit_sha: sourceCommit,
      workflow_path: '.github/workflows/trusted-media-run.yml',
      workflow_sha256: sha256(workflowFile.bytes),
    },
    execution: {
      ...runPackageFile.value.execution,
      model: runPackageFile.value.model,
      harness: {
        driver_bundle_sha256: driverBundleSha256,
        dependency_lock_sha256: sha256(lockFile.bytes),
      },
    },
    candidate: {
      track: 'cet4',
      card_count: 1180,
      box_count: 108,
      audio_asset_count: 301,
      content_version: authorizationFile.value.content_version,
      content_authorization_sha256: authorizationIdentity.authorization_sha256,
      full_track_review_sha256: authorizationIdentity.model_review_sha256,
      quality_audit_sha256: authorizationIdentity.quality_audit_sha256,
    },
    artifacts: {
      audio_manifest: audioManifestIdentity,
      review_worklist: reviewedIdentity,
      raw_run_manifest: rawRunManifestIdentity,
    },
    review_runs: runPackageFile.value.runs.map(run => ({
      run_id: run.run_id,
      purpose: run.purpose,
      model_id: runPackageFile.value.model.id,
      model_revision: runPackageFile.value.model.revision,
      card_count: run.card_count,
      complete_asset_count: run.complete_asset_count,
      raw_output_sha256: run.sha256,
    })),
    result: {
      reviewed_card_count: 301,
      passed_card_count: 301,
      failed_card_count: 0,
      every_card_has_two_independent_acceptances: true,
      all_assets_complete_consumed: true,
      all_required_checks_passed: true,
    },
  };
  if (createdAt.getTime() < Date.parse(runPackageFile.value.execution.completed_at)) {
    throw new Error('receipt creation time predates model execution completion');
  }
  const receiptPath = path.join(outputDir, 'trusted-media-run-receipt.json');
  const receiptIdentity = writeJson(receiptPath, receipt);
  if (receiptIdentity.size_bytes > 1024 * 1024) {
    throw new Error('trusted media receipt exceeds 1 MiB');
  }
  return {
    audio_manifest: {path: audioManifestPath, ...audioManifestIdentity},
    raw_run_manifest: {path: rawRunManifestPath, ...rawRunManifestIdentity},
    receipt: {path: receiptPath, ...receiptIdentity},
    reviewed_worklist: {path: reviewedPath, ...reviewedIdentity},
  };
}

function parseArgs(argv) {
  const result = {};
  const flags = new Map([
    ['--authorization', 'authorizationPath'],
    ['--output-dir', 'outputDir'],
    ['--run-package', 'runPackagePath'],
    ['--source-commit', 'sourceCommit'],
    ['--worklist', 'worklistPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (!key || !argv[index + 1]) throw new Error(`invalid argument ${argv[index]}`);
    result[key] = path.resolve(argv[index + 1]);
    if (key === 'sourceCommit') result[key] = argv[index + 1];
    index += 1;
  }
  for (const key of flags.values()) {
    if (!result[key]) throw new Error(`missing ${key}`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = buildTrustedMediaArtifacts(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
