#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildModelAcceptanceInputSha256,
  validateIndependentModelAcceptances,
  validateModelAcceptance,
} from './lib/model_acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_SCHEMA = 'controlled-pilot-review.v1';
const APPROVAL_SCHEMA = 'controlled-pilot-approval.v1';
const MODEL_REVIEW_SCHEMA = 'controlled-pilot-review.v2';
const MODEL_AUTHORIZATION_SCHEMA = 'controlled-pilot-authorization.v2';
const REVIEW_DIR = 'reviews/controlled_pilot_reviews';
const APPROVAL_DIR = 'reviews/controlled_pilot_approvals';
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PILOT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXACT_BOX_COUNT = 14;
const EXACT_CARD_COUNT = 120;
const EXACT_SAMPLE_COUNT = 42;
const EXACT_EXPANSION_COUNT = 78;

function buildLegacyControlledPilotReview({
  audit,
  auditPath,
  clock = () => new Date(),
  confirmation,
  confirmationPath,
  contentVersion,
  pilotId,
  root = ROOT,
  runtimePayload,
  runtimePayloadPath,
} = {}) {
  requirePilotId(pilotId);
  requireDigest(contentVersion, 'content version');
  validateConfirmation(confirmation);
  validateRuntimePayload(runtimePayload, contentVersion);
  const runtimePayloadFile = requireWorkspaceFile(runtimePayloadPath, root);
  const runtimePayloadBytes = fs.readFileSync(runtimePayloadFile);
  if (JSON.stringify(JSON.parse(runtimePayloadBytes), null, 2) !== JSON.stringify(runtimePayload, null, 2)) {
    throw new Error('Provided runtime payload object does not match the runtime payload file.');
  }
  const cardsById = collectCards(root);
  const reviews = loadAgentSelfReviews(root);
  const boxes = [];
  const cardIds = [];
  const reviewPaths = new Set();
  for (const target of confirmation.scope.box_targets) {
    const prefix = String(target.box_prefix);
    const sampleIds = target.sample_card_ids.map(String).sort();
    const sampleReview = requireUniqueReview(
      reviews,
      record =>
        record.payload.sample_policy?.review_scope_type === 'three_card_sample_per_box' &&
        sameSet(record.payload.scope?.card_ids, sampleIds) &&
        sameSet(record.payload.scope?.box_prefixes, [prefix]) &&
        record.payload.batch_review?.status === 'recommend_user_confirmation',
      `sample review for ${prefix}`,
    );
    const expansionReview = requireUniqueReview(
      reviews,
      record =>
        record.payload.sample_policy?.review_scope_type === 'confirmed_box_expansion' &&
        record.payload.sample_policy?.sample_confirmation_id === confirmation.confirmation_id &&
        sameSet(record.payload.scope?.box_prefixes, [prefix]) &&
        record.payload.batch_review?.status === 'reviewed_confirmed_box_expansion',
      `expansion review for ${prefix}`,
    );
    requirePassingCardSnapshots(sampleReview.payload.cards, sampleIds, prefix);
    const expansionIds = (expansionReview.payload.cards || []).map(card => String(card.card_id)).sort();
    requirePassingCardSnapshots(expansionReview.payload.cards, expansionIds, prefix);
    const boxIds = [...new Set([...sampleIds, ...expansionIds])].sort();
    if (boxIds.length !== target.target_card_count) {
      throw new Error(`Box ${prefix} resolves to ${boxIds.length} cards, expected ${target.target_card_count}.`);
    }
    for (const cardId of boxIds) {
      const card = cardsById.get(cardId);
      if (!card || String(card.knowledge_ref?.box_prefix || card.card_box_code) !== prefix) {
        throw new Error(`Card ${cardId} does not resolve to controlled-pilot box ${prefix}.`);
      }
      if (!card.quality_flags?.includes('synthetic_source')) {
        throw new Error(`Card ${cardId} must disclose synthetic_source.`);
      }
    }
    reviewPaths.add(sampleReview.path);
    reviewPaths.add(expansionReview.path);
    boxes.push({
      box_prefix: prefix,
      target_card_count: target.target_card_count,
      sample_card_ids: sampleIds,
      expansion_card_ids: expansionIds,
      reviewed_card_ids: boxIds,
      sample_review: sampleReview.path,
      expansion_review: expansionReview.path,
      status: 'passed',
    });
    cardIds.push(...boxIds);
  }
  if (
    boxes.length !== EXACT_BOX_COUNT ||
    cardIds.length !== EXACT_CARD_COUNT ||
    new Set(cardIds).size !== EXACT_CARD_COUNT
  ) {
    throw new Error('Controlled-pilot review must resolve to 14 boxes and 120 unique cards.');
  }
  if (!sameSet(runtimePayload.card_records.map(card => String(card.card_id)), cardIds)) {
    throw new Error('Runtime payload card IDs do not match the reviewed 120-card scope.');
  }
  validateAudit(audit, cardIds);
  const auditFile = requireWorkspaceFile(auditPath, root);
  const auditBytes = fs.readFileSync(auditFile);
  if (JSON.stringify(JSON.parse(auditBytes), null, 2) !== JSON.stringify(audit, null, 2)) {
    throw new Error('Provided audit object does not match the audit file.');
  }
  const now = toIso(clock);
  const artifact = {
    schema_version: REVIEW_SCHEMA,
    review_id: `${now.slice(0, 10).replaceAll('-', '')}-cet4-controlled-pilot-120`,
    created_at: now,
    pilot_id: pilotId,
    content_version: contentVersion,
    scope: {
      track: 'cet4',
      purpose: 'controlled_pilot',
      card_count: EXACT_CARD_COUNT,
      box_prefixes: boxes.map(box => box.box_prefix),
      card_ids: cardIds,
    },
    source_records: {
      runtime_payload: relativeToRoot(runtimePayloadFile, root),
      runtime_payload_sha256: digest(runtimePayloadBytes),
      sample_confirmation: relativeToRoot(requireWorkspaceFile(confirmationPath, root), root),
      agent_self_reviews: [...reviewPaths].sort(),
      scoped_audit: relativeToRoot(auditFile, root),
      scoped_audit_sha256: digest(auditBytes),
    },
    coverage: {
      sample_cards: boxes.reduce((sum, box) => sum + box.sample_card_ids.length, 0),
      expansion_cards: boxes.reduce((sum, box) => sum + box.expansion_card_ids.length, 0),
      reviewed_cards: cardIds.length,
      boxes,
    },
    quality: {
      hard_blockers: audit.scope_summary.by_severity.hard_blocker,
      content_risks: audit.scope_summary.by_severity.content_risk,
      review_gaps: audit.scope_summary.by_severity.review_gap,
      source_risks: audit.scope_summary.by_severity.source_risk,
      synthetic_source_cards: audit.scope_summary.by_rule.synthetic_source,
      source_disclosure: 'synthetic_training_content_not_true_exam',
    },
    approval: {
      approved_by_user: false,
      approved_at: null,
      source: null,
      artifact_path: null,
    },
    approval_boundary: {
      sample_confirmation_is_not_formal_approval: true,
      audio_qc_required_separately: true,
      pilot_release_required_separately: true,
      gate_eligible: false,
    },
    status: 'ready_for_user_approval',
  };
}

function approveLegacyControlledPilotReview({
  approvalSource,
  approvedAt,
  review,
  reviewPath,
} = {}) {
  const errors = validateControlledPilotReview(review, {approved: false});
  if (errors.length > 0) throw new Error(`Controlled-pilot review is invalid: ${errors.join('; ')}`);
  if (!hasText(approvalSource)) throw new Error('approval source is required');
  requireIso(approvedAt, 'approved at');
  const artifactPath = `${APPROVAL_DIR}/${review.pilot_id}-${review.content_version.slice(-12)}.json`;
  const approvedReview = structuredClone(review);
  approvedReview.approval = {
    approved_by_user: true,
    approved_at: approvedAt,
    source: approvalSource.trim(),
    artifact_path: artifactPath,
  };
  approvedReview.status = 'user_approved';
  const artifact = {
    schema_version: APPROVAL_SCHEMA,
    pilot_id: review.pilot_id,
    content_version: review.content_version,
    scope: 'controlled_pilot_120',
    status: 'approved',
    approved_by_user: true,
    approved_at: approvedAt,
    card_ids: [...review.scope.card_ids],
  };
  const approvedErrors = validateControlledPilotReview(approvedReview, {approved: true});
  if (approvedErrors.length > 0) throw new Error(`Approved review is invalid: ${approvedErrors.join('; ')}`);
  const artifactErrors = validateControlledPilotApproval(artifact, approvedReview);
  if (artifactErrors.length > 0) throw new Error(`Approval artifact is invalid: ${artifactErrors.join('; ')}`);
  return {artifact, artifactPath, approvedReview, reviewPath};
}

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

export function validateControlledPilotReview(review, {approved = null} = {}) {
  const errors = [];
  exactKeys(review, [
    'schema_version', 'review_id', 'created_at', 'pilot_id', 'content_version',
    'scope', 'source_records', 'coverage', 'quality', 'approval',
    'approval_boundary', 'status',
  ], 'review', errors);
  exactKeys(review?.scope, ['track', 'purpose', 'card_count', 'box_prefixes', 'card_ids'], 'review.scope', errors);
  exactKeys(review?.source_records, [
    'runtime_payload', 'runtime_payload_sha256', 'sample_confirmation',
    'agent_self_reviews', 'scoped_audit', 'scoped_audit_sha256',
  ], 'review.source_records', errors);
  exactKeys(review?.coverage, ['sample_cards', 'expansion_cards', 'reviewed_cards', 'boxes'], 'review.coverage', errors);
  exactKeys(review?.quality, [
    'hard_blockers', 'content_risks', 'review_gaps', 'source_risks',
    'synthetic_source_cards', 'source_disclosure',
  ], 'review.quality', errors);
  exactKeys(review?.approval, ['approved_by_user', 'approved_at', 'source', 'artifact_path'], 'review.approval', errors);
  exactKeys(review?.approval_boundary, [
    'sample_confirmation_is_not_formal_approval', 'audio_qc_required_separately',
    'pilot_release_required_separately', 'gate_eligible',
  ], 'review.approval_boundary', errors);
  if (review?.schema_version !== REVIEW_SCHEMA) errors.push('review schema_version is invalid');
  if (!hasText(review?.review_id)) errors.push('review_id is missing');
  try { requireIso(review?.created_at, 'created_at'); } catch (error) { errors.push(error.message); }
  try { requirePilotId(review?.pilot_id); } catch (error) { errors.push(error.message); }
  try { requireDigest(review?.content_version, 'content version'); } catch (error) { errors.push(error.message); }
  if (
    review?.scope?.track !== 'cet4' ||
    review?.scope?.purpose !== 'controlled_pilot' ||
    review?.scope?.card_count !== EXACT_CARD_COUNT ||
    !uniqueStrings(review?.scope?.card_ids, EXACT_CARD_COUNT) ||
    !uniqueStrings(review?.scope?.box_prefixes, EXACT_BOX_COUNT)
  ) errors.push('review scope is invalid');
  if (
    !hasText(review?.source_records?.runtime_payload) ||
    !SHA256_RE.test(String(review?.source_records?.runtime_payload_sha256 || '')) ||
    !hasText(review?.source_records?.sample_confirmation) ||
    !uniqueStrings(review?.source_records?.agent_self_reviews, 28) ||
    !hasText(review?.source_records?.scoped_audit) ||
    !SHA256_RE.test(String(review?.source_records?.scoped_audit_sha256 || ''))
  ) errors.push('review source records are invalid');
  if (
    review?.coverage?.sample_cards !== EXACT_SAMPLE_COUNT ||
    review?.coverage?.expansion_cards !== EXACT_EXPANSION_COUNT ||
    review?.coverage?.reviewed_cards !== EXACT_CARD_COUNT ||
    !Array.isArray(review?.coverage?.boxes) ||
    review.coverage.boxes.length !== EXACT_BOX_COUNT
  ) errors.push('review coverage totals are invalid');
  const covered = (review?.coverage?.boxes || []).flatMap(box => box.reviewed_card_ids || []);
  if (!sameSet(covered, review?.scope?.card_ids)) errors.push('review box coverage does not match scope');
  for (const box of review?.coverage?.boxes || []) {
    exactKeys(box, [
      'box_prefix', 'target_card_count', 'sample_card_ids', 'expansion_card_ids',
      'reviewed_card_ids', 'sample_review', 'expansion_review', 'status',
    ], `review.coverage.boxes.${String(box?.box_prefix || 'unknown')}`, errors);
    if (
      !/^\d{4}$/.test(String(box?.box_prefix || '')) ||
      !Number.isSafeInteger(box?.target_card_count) ||
      !uniqueStrings(box?.sample_card_ids, 3) ||
      !uniqueStrings(box?.expansion_card_ids, box.target_card_count - 3) ||
      !uniqueStrings(box?.reviewed_card_ids, box.target_card_count) ||
      !sameSet([...box.sample_card_ids, ...box.expansion_card_ids], box.reviewed_card_ids) ||
      !hasText(box?.sample_review) ||
      !hasText(box?.expansion_review) ||
      box?.status !== 'passed'
    ) errors.push(`review box coverage is invalid for ${String(box?.box_prefix || 'unknown')}`);
  }
  if (
    review?.quality?.hard_blockers !== 0 ||
    review?.quality?.content_risks !== 0 ||
    review?.quality?.review_gaps !== 0 ||
    review?.quality?.source_risks !== EXACT_CARD_COUNT ||
    review?.quality?.synthetic_source_cards !== EXACT_CARD_COUNT ||
    review?.quality?.source_disclosure !== 'synthetic_training_content_not_true_exam'
  ) errors.push('review quality boundary is invalid');
  if (
    review?.approval_boundary?.sample_confirmation_is_not_formal_approval !== true ||
    review?.approval_boundary?.audio_qc_required_separately !== true ||
    review?.approval_boundary?.pilot_release_required_separately !== true ||
    review?.approval_boundary?.gate_eligible !== false
  ) errors.push('review approval boundary is invalid');
  const isApproved = review?.status === 'user_approved';
  if (approved !== null && isApproved !== approved) errors.push('review approval state is invalid');
  if (isApproved) {
    if (
      review.approval?.approved_by_user !== true ||
      !hasText(review.approval?.source) ||
      !hasText(review.approval?.artifact_path)
    ) errors.push('approved review metadata is incomplete');
    try { requireIso(review.approval?.approved_at, 'approved_at'); } catch (error) { errors.push(error.message); }
    const expectedArtifactPath = `${APPROVAL_DIR}/${review.pilot_id}-${review.content_version.slice(-12)}.json`;
    if (review.approval?.artifact_path !== expectedArtifactPath) {
      errors.push('approved review artifact path is not canonical');
    }
  } else if (
    review?.status !== 'ready_for_user_approval' ||
    review?.approval?.approved_by_user !== false ||
    review?.approval?.approved_at !== null ||
    review?.approval?.source !== null ||
    review?.approval?.artifact_path !== null
  ) errors.push('pending review must not contain approval');
  return errors;
}

export function validateControlledPilotApproval(artifact, review) {
  const errors = [];
  exactKeys(artifact, [
    'schema_version', 'pilot_id', 'content_version', 'scope', 'status',
    'approved_by_user', 'approved_at', 'card_ids',
  ], 'approval', errors);
  if (
    artifact?.schema_version !== APPROVAL_SCHEMA ||
    artifact?.scope !== 'controlled_pilot_120' ||
    artifact?.status !== 'approved' ||
    artifact?.approved_by_user !== true ||
    !uniqueStrings(artifact?.card_ids, EXACT_CARD_COUNT)
  ) errors.push('approval artifact shape is invalid');
  try { requirePilotId(artifact?.pilot_id); } catch (error) { errors.push(error.message); }
  try { requireDigest(artifact?.content_version, 'content version'); } catch (error) { errors.push(error.message); }
  try { requireIso(artifact?.approved_at, 'approved_at'); } catch (error) { errors.push(error.message); }
  if (review) {
    if (
      review.status !== 'user_approved' ||
      artifact.pilot_id !== review.pilot_id ||
      artifact.content_version !== review.content_version ||
      artifact.approved_at !== review.approval?.approved_at ||
      !sameSet(artifact.card_ids, review.scope?.card_ids)
    ) errors.push('approval artifact does not match its aggregate review');
  }
  return errors;
}

function validateConfirmation(confirmation) {
  if (
    confirmation?.schema_version !== 'sample-confirmation.v1' ||
    confirmation?.confirmed_by_user !== true ||
    confirmation?.scope?.track !== 'cet4' ||
    confirmation?.scope?.purpose !== 'controlled_pilot' ||
    confirmation?.scope?.target_card_count !== EXACT_CARD_COUNT ||
    !Array.isArray(confirmation?.scope?.box_targets) ||
    confirmation.scope.box_targets.length !== EXACT_BOX_COUNT ||
    confirmation?.authorizes?.confirmed_box_expansion !== true ||
    confirmation?.final_user_approval_required !== true ||
    confirmation?.gate_eligible !== false ||
    !(confirmation?.does_not_authorize || []).includes('formal_content_approval')
  ) throw new Error('Sample confirmation is invalid or claims formal approval.');
  const prefixes = confirmation.scope.box_targets.map(target => String(target.box_prefix));
  if (new Set(prefixes).size !== EXACT_BOX_COUNT) throw new Error('Confirmation box prefixes are not unique.');
  if (
    confirmation.scope.box_targets.reduce((sum, target) => sum + target.target_card_count, 0) !== EXACT_CARD_COUNT ||
    confirmation.scope.box_targets.reduce((sum, target) => sum + target.sample_card_ids.length, 0) !== EXACT_SAMPLE_COUNT
  ) throw new Error('Confirmation target totals are invalid.');
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

function collectCards(root) {
  const byId = new Map();
  const directory = path.join(root, 'card_boxes_json');
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const document = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    for (const card of document.cards || []) {
      const cardId = String(card.card_id || '');
      if (byId.has(cardId)) throw new Error(`Duplicate corpus card ${cardId}.`);
      byId.set(cardId, card);
    }
  }
  return byId;
}

function loadAgentSelfReviews(root) {
  const directory = path.join(root, 'reviews/agent_self_review');
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.json') && !name.includes('TEMPLATE'))
    .sort()
    .map(name => ({
      path: `reviews/agent_self_review/${name}`,
      payload: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
    }));
}

function requireUniqueReview(reviews, predicate, label) {
  const matches = reviews.filter(predicate);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}, got ${matches.length}.`);
  return matches[0];
}

function requirePassingCardSnapshots(cards, expectedIds, prefix) {
  const ids = (cards || []).map(card => String(card.card_id)).sort();
  if (!sameSet(ids, expectedIds) || ids.some(cardId => !cardId.startsWith(prefix))) {
    throw new Error(`Review snapshots for ${prefix} do not match expected cards.`);
  }
  for (const card of cards || []) {
    if (
      card.status !== 'pass' ||
      Object.values(card.blocker_scan || {}).some(Boolean) ||
      !['answer_matches_card', 'choice_or_bank_references_match_source', 'distractor_labels_match_explanations']
        .every(field => card.analysis_reference_check?.[field] === true)
    ) throw new Error(`Review snapshot ${card.card_id} is not a complete pass.`);
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
