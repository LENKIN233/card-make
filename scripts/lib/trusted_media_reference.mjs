import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  computeCardCorpusFingerprint,
  validateCurrentApprovalRecordReference,
} from './card_integrity.mjs';

const RECEIPT_DIRECTORY = 'reviews/trusted_media_receipts';
const VERIFICATION_CACHE_BY_EXECUTOR = new WeakMap();

function verificationCache(execFile, typeSpecificVerifier) {
  let byVerifier = VERIFICATION_CACHE_BY_EXECUTOR.get(execFile);
  if (!byVerifier) {
    byVerifier = new WeakMap();
    VERIFICATION_CACHE_BY_EXECUTOR.set(execFile, byVerifier);
  }
  let cache = byVerifier.get(typeSpecificVerifier);
  if (!cache) {
    cache = new Map();
    byVerifier.set(typeSpecificVerifier, cache);
  }
  return cache;
}

export function verifyTrustedMediaEvidence({
  attestationBundlePath,
  authorizationPath,
  execFile = execFileSync,
  expectedSourceRecords = null,
  root,
  typeSpecificVerifier = runProductTrustedMediaVerifier,
  trustedReceiptPath,
  worklistPath,
  worklistSha256,
} = {}) {
  const receiptFile = requireTrackedEvidenceFile({
    file: trustedReceiptPath,
    label: 'trusted media receipt',
    root,
    suffix: '.json',
  });
  const bundleFile = requireTrackedEvidenceFile({
    file: attestationBundlePath,
    label: 'trusted media attestation bundle',
    root,
    suffix: '.jsonl',
  });
  const authorizationFile = requireTrackedWorkspaceFile({
    file: authorizationPath,
    label: 'trusted media content authorization',
    root,
  });
  const worklistFile = requireTrackedWorkspaceFile({
    file: worklistPath,
    label: 'trusted media reviewed worklist',
    root,
  });
  const receiptBytes = receiptFile.bytes;
  const bundleBytes = bundleFile.bytes;
  const receiptSha256 = sha256(receiptBytes);
  const bundleSha256 = sha256(bundleBytes);
  const authorizationSha256 = sha256(authorizationFile.bytes);
  const actualWorklistSha256 = sha256(worklistFile.bytes);
  if (worklistSha256 !== actualWorklistSha256) {
    throw new Error('trusted media reviewed worklist hash does not match the QC record');
  }
  let receipt;
  let authorization;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
    authorization = JSON.parse(authorizationFile.bytes.toString('utf8'));
  } catch {
    throw new Error('trusted media receipt or authorization is not JSON');
  }
  if (expectedSourceRecords && (
    expectedSourceRecords.trusted_media_receipt_sha256 !== receiptSha256 ||
    expectedSourceRecords.trusted_media_attestation_bundle_sha256 !== bundleSha256 ||
    expectedSourceRecords.trusted_media_source_commit !== receipt.finalization?.commit_sha ||
    expectedSourceRecords.trusted_media_model_id !== receipt.execution?.model?.id ||
    expectedSourceRecords.trusted_media_model_revision !== receipt.execution?.model?.revision
  )) {
    throw new Error('audio QC trusted media source records do not match exact evidence bytes');
  }
  const repositoryHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const cacheKey = JSON.stringify({
    root: path.resolve(root),
    repositoryHead,
    receiptPath: receiptFile.relativePath,
    receiptSha256,
    bundlePath: bundleFile.relativePath,
    bundleSha256,
    authorizationPath: authorizationFile.relativePath,
    authorizationSha256,
    worklistPath: worklistFile.relativePath,
    worklistSha256: actualWorklistSha256,
  });
  const cache = verificationCache(execFile, typeSpecificVerifier);
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const currentAuthorization = validateCurrentApprovalRecordReference({
    approvalPath: authorizationFile.relativePath,
    currentFingerprint: computeCardCorpusFingerprint(root),
    root,
  });
  if (!currentAuthorization.ok) {
    throw new Error('trusted media content authorization is not current');
  }
  if (
    receipt.schema_version !== 'trusted-media-run-receipt.v2' ||
    receipt.source?.repository !== 'LENKIN233/card-make' ||
    receipt.source?.ref !== 'refs/heads/main' ||
    receipt.source?.workflow_path !== '.github/workflows/trusted-media-run.yml' ||
    !/^[a-f0-9]{40}$/.test(receipt.source?.commit_sha || '') ||
    receipt.finalization?.repository !== 'LENKIN233/card-make' ||
    receipt.finalization?.ref !== 'refs/heads/main' ||
    receipt.finalization?.workflow_path !== '.github/workflows/trusted-media-run.yml' ||
    !/^[a-f0-9]{40}$/.test(receipt.finalization?.commit_sha || '') ||
    receipt.finalization?.retained_raw_artifact?.workflow_run_id !==
      receipt.execution?.workflow_run_id ||
    receipt.finalization?.retained_raw_artifact?.workflow_run_attempt !==
      receipt.execution?.workflow_run_attempt ||
    receipt.candidate?.track !== 'cet4' ||
    receipt.candidate?.card_count !== 1180 ||
    receipt.candidate?.box_count !== 108 ||
    receipt.candidate?.audio_asset_count !== 301 ||
    receipt.candidate?.content_version !== authorization.content_version ||
    receipt.candidate?.content_authorization_sha256 !== authorizationSha256 ||
    receipt.artifacts?.review_worklist?.sha256 !== actualWorklistSha256 ||
    receipt.artifacts?.review_worklist?.size_bytes !== worklistFile.bytes.length ||
    typeof receipt.execution?.model?.id !== 'string' ||
    receipt.execution.model.id.length < 3 ||
    !/^[a-f0-9]{40}$/.test(receipt.execution?.model?.revision || '') ||
    receipt.result?.reviewed_card_count !== 301 ||
    receipt.result?.passed_card_count !== 301 ||
    receipt.result?.failed_card_count !== 0 ||
    receipt.result?.every_card_has_two_independent_acceptances !== true ||
    receipt.result?.all_assets_complete_consumed !== true ||
    receipt.result?.all_required_checks_passed !== true
  ) {
    throw new Error(
      'trusted media receipt does not bind the current authorization and reviewed worklist',
    );
  }
  const args = [
    'attestation',
    'verify',
    receiptFile.absolute,
    '--repo',
    'LENKIN233/card-make',
    '--bundle',
    bundleFile.absolute,
    '--deny-self-hosted-runners',
    '--signer-workflow',
    'LENKIN233/card-make/.github/workflows/trusted-media-run.yml',
    '--signer-digest',
    receipt.finalization.commit_sha,
    '--source-digest',
    receipt.finalization.commit_sha,
    '--source-ref',
    'refs/heads/main',
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--format',
    'json',
  ];
  let verification;
  try {
    verification = JSON.parse(execFile('gh', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    throw new Error('trusted media GitHub Artifact Attestation verification failed');
  }
  if (!Array.isArray(verification) || !verification.some(item =>
    Array.isArray(item?.verificationResult?.verifiedTimestamps) &&
    item.verificationResult.verifiedTimestamps.length > 0 &&
    item.verificationResult?.statement?.subject?.some(
      subject => subject?.digest?.sha256 === receiptSha256,
    )
  )) {
    throw new Error('trusted media attestation does not bind the exact receipt bytes');
  }
  const artifactDirectory = requireTrackedArtifactDirectory({
    receiptRelativePath: receiptFile.relativePath,
    root,
  });
  let semanticResult;
  try {
    semanticResult = typeSpecificVerifier({
      artifactDirectory,
      audioRoot: path.resolve(root),
      candidateRoot: path.resolve(root),
      authorizationPath: authorizationFile.absolute,
      bundlePath: bundleFile.absolute,
      receiptPath: receiptFile.absolute,
      root: path.resolve(root),
    });
  } catch (error) {
    const detail = String(
      error?.stderr || error?.stdout || error?.message || 'unknown failure',
    )
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    throw new Error(
      `trusted media type-specific artifact replay failed: ${detail}`,
    );
  }
  if (
    semanticResult?.ok !== true ||
    semanticResult?.formal_ready !== true ||
    semanticResult?.receipt_sha256 !== receiptSha256 ||
    semanticResult?.source_commit_sha !== receipt.finalization.commit_sha ||
    semanticResult?.execution_source_commit_sha !== receipt.source.commit_sha
  ) {
    throw new Error('trusted media type-specific artifact replay is not formal-ready');
  }
  const result = {
    artifactDirectory: path.relative(root, artifactDirectory).split(path.sep).join('/'),
    bundlePath: bundleFile.relativePath,
    bundleSha256,
    modelId: receipt.execution.model.id,
    modelRevision: receipt.execution.model.revision,
    receipt,
    receiptPath: receiptFile.relativePath,
    receiptSha256,
    sourceCommit: receipt.finalization.commit_sha,
  };
  cache.set(cacheKey, result);
  return result;
}

function requireTrackedArtifactDirectory({receiptRelativePath, root}) {
  const receiptStem = path.basename(receiptRelativePath, '.json');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(receiptStem)) {
    throw new Error('trusted media receipt filename cannot identify its artifact directory');
  }
  const directory = path.resolve(root, 'reviews/trusted_media_runs', receiptStem);
  const expectedParent = path.resolve(root, 'reviews/trusted_media_runs');
  if (
    path.dirname(directory) !== expectedParent ||
    !fs.existsSync(directory) ||
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink()
  ) {
    throw new Error('trusted media artifact directory is missing or invalid');
  }
  const entries = fs.readdirSync(directory, {withFileTypes: true});
  if (entries.length === 0 || entries.some(entry => !entry.isFile())) {
    throw new Error('trusted media artifact directory must contain only direct files');
  }
  for (const entry of entries) {
    requireTrackedWorkspaceFile({
      file: path.join(directory, entry.name),
      label: `trusted media artifact ${entry.name}`,
      root,
    });
  }
  for (const required of [
    'run-package.json',
    'model-weights-manifest.json',
    'mlx-audio-package-manifest.json',
    'python-environment-manifest.json',
  ]) {
    if (!entries.some(entry => entry.name === required)) {
      throw new Error(`trusted media artifact directory omits ${required}`);
    }
  }
  return directory;
}

function runProductTrustedMediaVerifier({
  artifactDirectory,
  audioRoot,
  candidateRoot,
  authorizationPath,
  bundlePath,
  receiptPath,
  root,
}) {
  const verifier = path.resolve(
    root,
    '..',
    'softbook_cet',
    'scripts',
    'verify_trusted_media_run_receipt.mjs',
  );
  if (!fs.existsSync(verifier) || !fs.lstatSync(verifier).isFile()) {
    throw new Error('softbook trusted media verifier is unavailable');
  }
  const output = execFileSync(process.execPath, [
    verifier,
    '--receipt',
    receiptPath,
    '--bundle',
    bundlePath,
    '--artifact-dir',
    artifactDirectory,
    '--audio-root',
    audioRoot,
    '--candidate-root',
    candidateRoot,
    '--authorization',
    authorizationPath,
    '--verify-attestation',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function requireTrackedEvidenceFile({file, label, root, suffix}) {
  const loaded = requireTrackedWorkspaceFile({file, label, root});
  const expectedDirectory = path.resolve(root, RECEIPT_DIRECTORY);
  if (
    path.dirname(loaded.absolute) !== expectedDirectory ||
    !loaded.relativePath.endsWith(suffix)
  ) {
    throw new Error(
      `${label} must be a direct ${suffix} file below ${RECEIPT_DIRECTORY}/`,
    );
  }
  return loaded;
}

function requireTrackedWorkspaceFile({file, label, root}) {
  const normalizedRoot = path.resolve(root);
  const absolute = path.resolve(normalizedRoot, String(file || ''));
  if (!absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing`);
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) !== 0) {
    throw new Error(`${label} must be a non-executable regular file`);
  }
  const relativePath = path.relative(normalizedRoot, absolute).split(path.sep).join('/');
  const bytes = fs.readFileSync(absolute);
  let treeEntry;
  let headBytes;
  try {
    treeEntry = execFileSync(
      'git',
      ['--literal-pathspecs', 'ls-tree', 'HEAD', '--', relativePath],
      {cwd: normalizedRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
    ).trim();
    headBytes = execFileSync(
      'git',
      ['--literal-pathspecs', 'show', `HEAD:${relativePath}`],
      {cwd: normalizedRoot, encoding: null, stdio: ['ignore', 'pipe', 'pipe']},
    );
  } catch {
    throw new Error(`${label} must be tracked at exact HEAD`);
  }
  if (
    !treeEntry.startsWith('100644 blob ') ||
    !treeEntry.endsWith(`\t${relativePath}`) ||
    !bytes.equals(Buffer.from(headBytes))
  ) {
    throw new Error(`${label} bytes must equal a regular 100644 blob at exact HEAD`);
  }
  return {absolute, bytes, relativePath};
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
