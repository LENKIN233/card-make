import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RECEIPT_DIRECTORY = 'reviews/trusted_media_receipts';

export function verifyTrustedMediaEvidence({
  attestationBundlePath,
  authorizationPath,
  execFile = execFileSync,
  expectedSourceRecords = null,
  root,
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
  if (
    receipt.schema_version !== 'trusted-media-run-receipt.v1' ||
    receipt.source?.repository !== 'LENKIN233/card-make' ||
    receipt.source?.ref !== 'refs/heads/main' ||
    receipt.source?.workflow_path !== '.github/workflows/trusted-media-run.yml' ||
    !/^[a-f0-9]{40}$/.test(receipt.source?.commit_sha || '') ||
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
  if (expectedSourceRecords && (
    expectedSourceRecords.trusted_media_receipt_sha256 !== receiptSha256 ||
    expectedSourceRecords.trusted_media_attestation_bundle_sha256 !== bundleSha256 ||
    expectedSourceRecords.trusted_media_source_commit !== receipt.source.commit_sha ||
    expectedSourceRecords.trusted_media_model_id !== receipt.execution.model.id ||
    expectedSourceRecords.trusted_media_model_revision !== receipt.execution.model.revision
  )) {
    throw new Error('audio QC trusted media source records do not match exact evidence bytes');
  }
  const args = [
    'attestation',
    'verify',
    receiptFile.absolute,
    '--repo',
    'LENKIN233/card-make',
    '--bundle',
    bundleFile.absolute,
    '--signer-workflow',
    'LENKIN233/card-make/.github/workflows/trusted-media-run.yml',
    '--signer-digest',
    receipt.source.commit_sha,
    '--source-digest',
    receipt.source.commit_sha,
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
  return {
    bundlePath: bundleFile.relativePath,
    bundleSha256,
    modelId: receipt.execution.model.id,
    modelRevision: receipt.execution.model.revision,
    receipt,
    receiptPath: receiptFile.relativePath,
    receiptSha256,
    sourceCommit: receipt.source.commit_sha,
  };
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
