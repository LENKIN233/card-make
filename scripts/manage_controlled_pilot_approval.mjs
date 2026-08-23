#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildModelAcceptanceInputSha256,
  isLegacyV1HumanAuthorityRecord,
  validateIndependentModelAcceptances,
  validateModelAcceptance,
} from './lib/model_acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_REVIEW_SCHEMA = 'controlled-pilot-review.v2';
const MODEL_AUTHORIZATION_SCHEMA = 'controlled-pilot-authorization.v2';
const REVIEW_DIR = 'reviews/controlled_pilot_reviews';
const APPROVAL_DIR = 'reviews/controlled_pilot_approvals';
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PILOT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXACT_BOX_COUNT = 14;
const EXACT_CARD_COUNT = 120;

export function authorizeControlledPilotReviewV2({
  authorizedAt,
  modelAcceptances,
  review,
  reviewPath,
  root = ROOT,
} = {}) {
  const reviewErrors = validateControlledPilotReviewV2(review, {root});
  if (reviewErrors.length > 0) {
    throw new Error(`Controlled-pilot model review is invalid: ${reviewErrors.join('; ')}`);
  }
  requireIso(authorizedAt, 'authorized at');
  const reviewFile = requireWorkspaceFile(reviewPath, root);
  const reviewSha256 = digest(fs.readFileSync(reviewFile));
  const acceptanceErrors = validateIndependentModelAcceptances(
    modelAcceptances,
    {requiredCapabilities: ['content_authorization']},
  );
  if (acceptanceErrors.length > 0) {
    throw new Error(
      `Controlled-pilot model acceptance is invalid: ${acceptanceErrors.map(issue => issue.code).join('; ')}`,
    );
  }
  const expectedInput = buildModelAcceptanceInputSha256({
    decisionType: 'controlled_pilot_authorization',
    scope: review.scope,
    corpusFingerprint: review.quality.corpus_fingerprint,
    auditSha256: review.source_records.scoped_audit_sha256,
    linkedReviewIdentity: {
      path: relativeToRoot(reviewFile, root),
      sha256: reviewSha256,
    },
    additionalBindings: {
      pilot_id: review.pilot_id,
      content_version: review.content_version,
      runtime_payload_sha256: review.source_records.runtime_payload_sha256,
    },
  });
  if (modelAcceptances.some(
    acceptance => acceptance.evidence.input_sha256 !== expectedInput,
  )) {
    throw new Error('Controlled-pilot model acceptance must bind the exact review, scope, audit, runtime payload and content version.');
  }
  const artifact = {
    schema_version: MODEL_AUTHORIZATION_SCHEMA,
    pilot_id: review.pilot_id,
    content_version: review.content_version,
    scope: 'controlled_pilot_120',
    status: 'authorized',
    authorized_at: authorizedAt,
    model_acceptances: structuredClone(modelAcceptances),
    review: relativeToRoot(reviewFile, root),
    review_sha256: reviewSha256,
    runtime_payload_sha256: review.source_records.runtime_payload_sha256,
    scoped_audit_sha256: review.source_records.scoped_audit_sha256,
    card_ids: [...review.scope.card_ids],
  };
  const artifactErrors = validateControlledPilotAuthorizationV2(
    artifact,
    review,
    {reviewPath: reviewFile, root},
  );
  if (artifactErrors.length > 0) {
    throw new Error(`Controlled-pilot model authorization is invalid: ${artifactErrors.join('; ')}`);
  }
  return artifact;
}

export function validateControlledPilotReviewV2(review, {root = ROOT} = {}) {
  const errors = [];
  if (isLegacyV1HumanAuthorityRecord(review)) {
    errors.push('model-owned controlled-pilot review contains legacy person-authority fields');
  }
  exactKeys(review, [
    'schema_version', 'review_id', 'created_at', 'pilot_id', 'content_version',
    'scope', 'source_records', 'coverage', 'quality', 'authorization',
    'authorization_boundary', 'status',
  ], 'model review', errors);
  exactKeys(review?.scope, [
    'track', 'purpose', 'card_count', 'box_prefixes', 'card_ids',
  ], 'model review.scope', errors);
  exactKeys(review?.source_records, [
    'runtime_payload', 'runtime_payload_sha256', 'model_reviews',
    'scoped_audit', 'scoped_audit_sha256',
  ], 'model review.source_records', errors);
  exactKeys(review?.coverage, ['reviewed_cards', 'boxes'], 'model review.coverage', errors);
  exactKeys(review?.quality, [
    'corpus_fingerprint', 'hard_blockers', 'content_risks', 'review_gaps',
    'source_risks', 'synthetic_source_cards', 'source_disclosure',
  ], 'model review.quality', errors);
  exactKeys(review?.authorization, [
    'model_acceptance', 'authorized_at', 'artifact_path',
  ], 'model review.authorization', errors);
  exactKeys(review?.authorization_boundary, [
    'audio_qc_required_separately', 'pilot_publication_required_separately',
    'external_facts_must_not_be_inferred', 'gate_eligible',
  ], 'model review.authorization_boundary', errors);
  if (review?.schema_version !== MODEL_REVIEW_SCHEMA) errors.push('model review schema_version is invalid');
  try { requireIso(review?.created_at, 'created_at'); } catch (error) { errors.push(error.message); }
  try { requirePilotId(review?.pilot_id); } catch (error) { errors.push(error.message); }
  try { requireDigest(review?.content_version, 'content version'); } catch (error) { errors.push(error.message); }
  if (
    !hasText(review?.review_id) ||
    review?.scope?.track !== 'cet4' ||
    review?.scope?.purpose !== 'controlled_pilot' ||
    review?.scope?.card_count !== EXACT_CARD_COUNT ||
    !uniqueStrings(review?.scope?.card_ids, EXACT_CARD_COUNT) ||
    !uniqueStrings(review?.scope?.box_prefixes, EXACT_BOX_COUNT)
  ) errors.push('model review scope is invalid');
  if (
    review?.coverage?.reviewed_cards !== EXACT_CARD_COUNT ||
    !Array.isArray(review?.coverage?.boxes) ||
    review.coverage.boxes.length !== EXACT_BOX_COUNT
  ) errors.push('model review coverage is invalid');
  const coveredIds = [];
  const coveredPrefixes = [];
  for (const box of review?.coverage?.boxes || []) {
    exactKeys(box, ['box_prefix', 'card_ids', 'status'], 'model review coverage box', errors);
    if (
      !/^\d{4}$/.test(String(box?.box_prefix || '')) ||
      !uniqueStrings(box?.card_ids, box?.card_ids?.length) ||
      box.card_ids.length === 0 ||
      box.status !== 'passed' ||
      box.card_ids.some(cardId => !String(cardId).startsWith(box.box_prefix))
    ) errors.push(`model review box coverage is invalid for ${String(box?.box_prefix || 'unknown')}`);
    coveredPrefixes.push(box?.box_prefix);
    coveredIds.push(...(box?.card_ids || []));
  }
  if (
    !sameSet(coveredPrefixes, review?.scope?.box_prefixes) ||
    !sameSet(coveredIds, review?.scope?.card_ids)
  ) errors.push('model review box coverage does not match scope');
  if (
    !SHA256_RE.test(String(review?.quality?.corpus_fingerprint || '')) ||
    review?.quality?.hard_blockers !== 0 ||
    review?.quality?.content_risks !== 0 ||
    review?.quality?.review_gaps !== 0 ||
    review?.quality?.source_risks !== EXACT_CARD_COUNT ||
    review?.quality?.synthetic_source_cards !== EXACT_CARD_COUNT ||
    review?.quality?.source_disclosure !== 'synthetic_training_content_not_true_exam'
  ) errors.push('model review quality boundary is invalid');
  if (
    review?.status !== 'ready_for_model_authorization' ||
    review?.authorization?.model_acceptance !== null ||
    review?.authorization?.authorized_at !== null ||
    review?.authorization?.artifact_path !== null ||
    review?.authorization_boundary?.audio_qc_required_separately !== true ||
    review?.authorization_boundary?.pilot_publication_required_separately !== true ||
    review?.authorization_boundary?.external_facts_must_not_be_inferred !== true ||
    review?.authorization_boundary?.gate_eligible !== false
  ) errors.push('model review authorization boundary is invalid');

  const checkBoundJson = (relativePath, expectedSha, label) => {
    try {
      const file = requireWorkspaceFile(relativePath, root);
      const bytes = fs.readFileSync(file);
      if (expectedSha !== null && digest(bytes) !== expectedSha) {
        errors.push(`${label} hash does not match`);
      }
      return JSON.parse(bytes);
    } catch (error) {
      errors.push(`${label} is unavailable: ${error.message}`);
      return null;
    }
  };
  const runtimePayload = checkBoundJson(
    review?.source_records?.runtime_payload,
    review?.source_records?.runtime_payload_sha256,
    'runtime payload',
  );
  if (runtimePayload) {
    try { validateRuntimePayload(runtimePayload, review.content_version); } catch (error) { errors.push(error.message); }
    if (!sameSet(runtimePayload.card_records?.map(card => String(card.card_id)), review.scope.card_ids)) {
      errors.push('runtime payload card IDs do not match model review scope');
    }
  }
  const audit = checkBoundJson(
    review?.source_records?.scoped_audit,
    review?.source_records?.scoped_audit_sha256,
    'scoped audit',
  );
  if (audit) {
    try { validateAudit(audit, review.scope.card_ids); } catch (error) { errors.push(error.message); }
    if (`sha256:${audit.corpus_fingerprint?.digest || ''}` !== review.quality.corpus_fingerprint) {
      errors.push('scoped audit corpus fingerprint does not match model review');
    }
  }
  const modelReviewPaths = review?.source_records?.model_reviews;
  if (!Array.isArray(modelReviewPaths) || modelReviewPaths.length === 0 || new Set(modelReviewPaths).size !== modelReviewPaths.length) {
    errors.push('model review sources are invalid');
  } else {
    const reviewedIds = [];
    for (const reviewPath of modelReviewPaths) {
      const source = checkBoundJson(reviewPath, null, `model review ${String(reviewPath)}`);
      if (!source) continue;
      if (!['model-owned-card-review.v2', 'model-owned-full-track-review.v2'].includes(source.schema_version)) {
        errors.push(`model review source ${reviewPath} is not model-owned v2`);
        continue;
      }
      const acceptanceIssues = source.schema_version === 'model-owned-full-track-review.v2'
        ? validateIndependentModelAcceptances(source.model_acceptances, {
            requiredCapabilities: ['card_semantic_review', 'source_provenance_review'],
          })
        : validateModelAcceptance(source.model_acceptance, {
            requireAccepted: true,
            requiredCapabilities: ['card_semantic_review', 'source_provenance_review'],
          });
      if (acceptanceIssues.length > 0) errors.push(`model review source ${reviewPath} acceptance is invalid`);
      const sourceAudit = checkBoundJson(
        source.quality_audit?.report,
        source.quality_audit?.report_sha256,
        `model review ${reviewPath} scoped audit`,
      );
      if (!sourceAudit) continue;
      let expectedReviewInput = null;
      try {
        expectedReviewInput = buildModelAcceptanceInputSha256({
          decisionType: source.schema_version === 'model-owned-full-track-review.v2'
            ? 'full_track_review'
            : 'card_review',
          scope: source.scope,
          corpusFingerprint: source.quality_audit?.corpus_fingerprint,
          auditSha256: source.quality_audit?.report_sha256,
        });
      } catch (error) {
        errors.push(`model review source ${reviewPath} input is invalid: ${error.message}`);
      }
      const sourceAcceptances = source.schema_version === 'model-owned-full-track-review.v2'
        ? source.model_acceptances || []
        : [source.model_acceptance];
      if (
        expectedReviewInput &&
        sourceAcceptances.some(
          acceptance => acceptance?.evidence?.input_sha256 !== expectedReviewInput,
        )
      ) errors.push(`model review source ${reviewPath} input binding does not match`);
      reviewedIds.push(...(source.scope?.card_ids || []));
    }
    if (!sameSet(reviewedIds, review?.scope?.card_ids)) {
      errors.push('model review sources do not exactly cover controlled-pilot scope');
    }
  }
  return errors;
}

export function validateControlledPilotAuthorizationV2(
  artifact,
  review,
  {reviewPath, root = ROOT} = {},
) {
  const errors = [];
  if (isLegacyV1HumanAuthorityRecord(artifact)) {
    errors.push('model-owned controlled-pilot authorization contains legacy person-authority fields');
  }
  exactKeys(artifact, [
    'schema_version', 'pilot_id', 'content_version', 'scope', 'status',
    'authorized_at', 'model_acceptances', 'review', 'review_sha256',
    'runtime_payload_sha256', 'scoped_audit_sha256', 'card_ids',
  ], 'model authorization', errors);
  if (
    artifact?.schema_version !== MODEL_AUTHORIZATION_SCHEMA ||
    artifact?.scope !== 'controlled_pilot_120' ||
    artifact?.status !== 'authorized' ||
    !uniqueStrings(artifact?.card_ids, EXACT_CARD_COUNT)
  ) errors.push('model authorization shape is invalid');
  try { requirePilotId(artifact?.pilot_id); } catch (error) { errors.push(error.message); }
  try { requireDigest(artifact?.content_version, 'content version'); } catch (error) { errors.push(error.message); }
  try { requireIso(artifact?.authorized_at, 'authorized_at'); } catch (error) { errors.push(error.message); }
  const acceptanceIssues = validateIndependentModelAcceptances(
    artifact?.model_acceptances,
    {requiredCapabilities: ['content_authorization']},
  );
  if (acceptanceIssues.length > 0) {
    errors.push(...acceptanceIssues.map(issue => issue.code));
  }
  const reviewErrors = validateControlledPilotReviewV2(review, {root});
  if (reviewErrors.length > 0) errors.push(...reviewErrors.map(error => `linked review: ${error}`));
  let reviewSha256 = null;
  try {
    const reviewFile = requireWorkspaceFile(reviewPath, root);
    reviewSha256 = digest(fs.readFileSync(reviewFile));
    if (
      artifact?.review !== relativeToRoot(reviewFile, root) ||
      artifact?.review_sha256 !== reviewSha256
    ) errors.push('model authorization review identity does not match');
  } catch (error) {
    errors.push(`model authorization review is unavailable: ${error.message}`);
  }
  if (
    artifact?.pilot_id !== review?.pilot_id ||
    artifact?.content_version !== review?.content_version ||
    artifact?.runtime_payload_sha256 !== review?.source_records?.runtime_payload_sha256 ||
    artifact?.scoped_audit_sha256 !== review?.source_records?.scoped_audit_sha256 ||
    !sameSet(artifact?.card_ids, review?.scope?.card_ids)
  ) errors.push('model authorization does not match linked review');
  if (reviewSha256) {
    let expectedInput = null;
    try {
      expectedInput = buildModelAcceptanceInputSha256({
        decisionType: 'controlled_pilot_authorization',
        scope: review.scope,
        corpusFingerprint: review.quality.corpus_fingerprint,
        auditSha256: review.source_records.scoped_audit_sha256,
        linkedReviewIdentity: {
          path: artifact.review,
          sha256: reviewSha256,
        },
        additionalBindings: {
          pilot_id: review.pilot_id,
          content_version: review.content_version,
          runtime_payload_sha256: review.source_records.runtime_payload_sha256,
        },
      });
    } catch (error) {
      errors.push(error.message);
    }
    if (
      expectedInput &&
      artifact.model_acceptances?.some(
        acceptance => acceptance?.evidence?.input_sha256 !== expectedInput,
      )
    ) errors.push('model authorization input binding does not match');
  }
  return errors;
}

function validateRuntimePayload(payload, contentVersion) {
  if (
    payload?.track !== 'cet4' ||
    payload?.content_version !== contentVersion ||
    !Array.isArray(payload?.card_records) ||
    payload.card_records.length !== EXACT_CARD_COUNT ||
    new Set(payload.card_records.map(card => String(card.card_id))).size !== EXACT_CARD_COUNT ||
    !Array.isArray(payload?.assets) ||
    payload.assets.length !== 24
  ) throw new Error('Runtime payload is not the exact controlled-pilot candidate.');
}

function validateAudit(audit, cardIds) {
  const summary = audit?.scope_summary;
  if (
    audit?.audit_version !== 'card-make-quality-audit-v1' ||
    audit?.report_type !== 'scoped_card_quality_audit' ||
    audit?.ok !== true ||
    !sameSet(audit?.scope?.card_ids, cardIds) ||
    (audit?.scope?.missing_card_ids || []).length !== 0 ||
    summary?.card_count !== EXACT_CARD_COUNT ||
    summary?.issue_count !== EXACT_CARD_COUNT ||
    summary?.by_severity?.hard_blocker !== 0 ||
    summary?.by_severity?.content_risk !== 0 ||
    summary?.by_severity?.review_gap !== 0 ||
    summary?.by_severity?.source_risk !== EXACT_CARD_COUNT ||
    summary?.by_rule?.synthetic_source !== EXACT_CARD_COUNT ||
    summary?.by_rule?.unverified_source !== 0 ||
    (audit?.scoped_hard_blocker_issues || []).length !== 0
  ) throw new Error('Controlled-pilot scoped audit does not meet the exact 120 synthetic-card boundary.');
  for (const [rule, count] of Object.entries(summary.by_rule || {})) {
    if (!['synthetic_source'].includes(rule) && count !== 0) {
      throw new Error(`Controlled-pilot scoped audit contains non-source finding ${rule}.`);
    }
  }
}

export function validateTrackedRecords(root = ROOT) {
  const reviewDir = path.join(root, REVIEW_DIR);
  const approvalDir = path.join(root, APPROVAL_DIR);
  const reviews = new Map();
  const errors = [];
  let currentReviews = 0;
  let currentAuthorizations = 0;
  let legacyRecords = 0;
  for (const filename of listRecords(reviewDir)) {
    const relative = `${REVIEW_DIR}/${filename}`;
    const file = path.join(reviewDir, filename);
    if (filename.includes(path.sep) || !fs.lstatSync(file).isFile()) {
      errors.push(`${relative}: record must be a direct regular file`);
      continue;
    }
    const review = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (review.schema_version === MODEL_REVIEW_SCHEMA) {
      currentReviews += 1;
      for (const error of validateControlledPilotReviewV2(review, {root})) {
        errors.push(`${relative}: ${error}`);
      }
    } else {
      legacyRecords += 1;
    }
    reviews.set(relative, review);
  }
  for (const filename of listRecords(approvalDir)) {
    const relative = `${APPROVAL_DIR}/${filename}`;
    const file = path.join(approvalDir, filename);
    if (filename.includes(path.sep) || !fs.lstatSync(file).isFile()) {
      errors.push(`${relative}: artifact must be a direct regular file`);
      continue;
    }
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (artifact.schema_version === MODEL_AUTHORIZATION_SCHEMA) {
      currentAuthorizations += 1;
      const review = reviews.get(artifact.review);
      if (!review) {
        errors.push(`${relative}: no matching model-owned aggregate review`);
      } else {
        for (const error of validateControlledPilotAuthorizationV2(
          artifact,
          review,
          {reviewPath: artifact.review, root},
        )) errors.push(`${relative}: ${error}`);
      }
    } else {
      legacyRecords += 1;
    }
  }
  return {
    errors,
    current_authorizations: currentAuthorizations,
    current_reviews: currentReviews,
    legacy_records: legacyRecords,
  };
}

function listRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  const records = [];
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const name = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), name);
      else if (entry.name.endsWith('.json') && name !== 'TEMPLATE.json') records.push(name);
    }
  };
  walk(directory);
  return records.sort();
}

function requireTrackedHeadFile(file, root) {
  const relative = relativeToRoot(file, root);
  const bytes = fs.readFileSync(file);
  let entry;
  let headBytes;
  try {
    entry = execFileSync('git', ['--literal-pathspecs', 'ls-tree', 'HEAD', '--', relative], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    headBytes = execFileSync('git', ['--literal-pathspecs', 'show', `HEAD:${relative}`], {
      cwd: root, encoding: null, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Approval requires the aggregate review to be a direct tracked HEAD file.');
  }
  const match = entry.match(/^100644 blob [0-9a-f]{40}\t(.+)$/);
  if (!match || match[1] !== relative || !bytes.equals(headBytes)) {
    throw new Error('Approval requires aggregate review mode and bytes to exactly match HEAD.');
  }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['authorize', 'validate'].includes(command)) {
    throw new Error('command must be authorize or validate; v1 build/approve commands are archive-only');
  }
  const options = {apply: false, command};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--apply') options.apply = true;
    else if (['--review', '--acceptances', '--authorized-at', '--output'].includes(argument)) {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replaceAll('-', '_')] = value;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (command === 'authorize' && !['review', 'acceptances', 'authorized_at', 'output'].every(key => hasText(options[key]))) {
    throw new Error('authorize requires --review, --acceptances, --authorized-at, and --output');
  }
  if (command === 'validate' && options.apply) throw new Error('validate is read-only');
  return options;
}

function writeJson(file, value, {replace = false} = {}) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {flag: replace ? 'w' : 'wx', mode: 0o644});
}

function requireZonePath(file, root, directory) {
  const absolute = path.resolve(root, file);
  const allowed = path.join(root, directory);
  if (!absolute.startsWith(`${allowed}${path.sep}`) || !absolute.endsWith('.json')) {
    throw new Error(`path must be a JSON file below ${directory}/`);
  }
  return absolute;
}

function requireWorkspaceFile(file, root) {
  const absolute = path.resolve(root, file || '');
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('path escapes workspace');
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) throw new Error(`required file is missing: ${file}`);
  return absolute;
}

function exactKeys(value, expected, label, errors) {
  const actual = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) errors.push(`${label} keys are not exact`);
}

function uniqueStrings(value, count) {
  return Array.isArray(value) && value.length === count && value.every(hasText) && new Set(value).size === count;
}

function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && new Set(left).size === left.length && left.every(value => new Set(right).has(value));
}

function requirePilotId(value) {
  if (!PILOT_ID_RE.test(String(value || ''))) throw new Error('pilot id is invalid');
}

function requireDigest(value, label) {
  if (!SHA256_RE.test(String(value || ''))) throw new Error(`${label} is invalid`);
}

function requireIso(value, label) {
  if (!ISO_RE.test(String(value || '')) || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid`);
}

function toIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock is invalid');
  return date.toISOString();
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function relativeToRoot(file, root) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function runCli() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === 'validate') {
      const result = validateTrackedRecords(ROOT);
      console.log(JSON.stringify({ok: result.errors.length === 0, ...result}, null, 2));
      if (result.errors.length > 0) process.exitCode = 1;
      return;
    }
    const reviewFile = requireZonePath(options.review, ROOT, REVIEW_DIR);
    requireTrackedHeadFile(requireWorkspaceFile(reviewFile, ROOT), ROOT);
    const acceptanceFile = requireWorkspaceFile(options.acceptances, ROOT);
    const modelAcceptances = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
    const artifact = authorizeControlledPilotReviewV2({
      authorizedAt: options.authorized_at,
      modelAcceptances,
      review: JSON.parse(fs.readFileSync(reviewFile, 'utf8')),
      reviewPath: relativeToRoot(reviewFile, ROOT),
      root: ROOT,
    });
    const artifactFile = requireZonePath(options.output, ROOT, APPROVAL_DIR);
    if (options.apply) {
      if (fs.existsSync(artifactFile)) throw new Error('refusing to replace an existing controlled-pilot authorization artifact');
      writeJson(artifactFile, artifact);
    }
    console.log(JSON.stringify({
      ok: true,
      applied: options.apply,
      review: relativeToRoot(reviewFile, ROOT),
      artifact: relativeToRoot(artifactFile, ROOT),
      authorization_artifact: artifact,
    }, null, 2));
  } catch (error) {
    console.error(`[controlled-pilot-approval] ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
