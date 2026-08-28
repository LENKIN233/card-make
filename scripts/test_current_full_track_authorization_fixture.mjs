import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildContentAuthorizationAdditionalBindings,
  buildModelAcceptanceInputSha256,
  deriveRuntimePayloadContentIdentity,
} from './lib/model_acceptance.mjs';
import {computeCardCorpusFingerprint} from './lib/card_integrity.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(target, bytes);
  return {relativePath, sha256: `sha256:${sha256(bytes)}`};
}

function acceptance(inputSha256, capabilities, runId) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'agent:test-fixture',
      model: 'gpt-5.6-sol',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-08-26T12:00:00.000Z',
      input_sha256: inputSha256,
      capabilities,
      summary: 'The exact test-only scope passed the bound model review.',
      findings: [],
    },
    decision: 'accepted',
  };
}

export function createCurrentFullTrackAuthorizationFixture({
  root,
  repositoryRoot,
  cards,
}) {
  const cardIds = cards.map(card => String(card.card_id));
  const boxPrefixes = [...new Set(cards.map(card => String(card.knowledge_ref.box_prefix)))].sort();
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(root, 'spec'), {recursive: true});
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts/audit_card_quality.mjs'),
    path.join(root, 'scripts/audit_card_quality.mjs'),
  );
  fs.copyFileSync(
    path.join(repositoryRoot, 'spec/card-quality-audit.json'),
    path.join(root, 'spec/card-quality-audit.json'),
  );
  const fingerprint = computeCardCorpusFingerprint(root);
  execFileSync(
    process.execPath,
    [
      'scripts/audit_card_quality.mjs',
      '--scope-card-ids',
      cardIds.join(','),
      '--write-scope-report',
      'reviews/audit_scopes/current-authorization-audit.json',
    ],
    {cwd: root, stdio: 'ignore'},
  );
  fs.copyFileSync(
    path.join(root, 'reviews/audit_scopes/current-authorization-audit.json'),
    path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
  );
  const authorizationAuditBytes = fs.readFileSync(
    path.join(root, 'reviews/audit_scopes/current-authorization-audit.json'),
  );
  const reviewAuditBytes = fs.readFileSync(
    path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
  );
  const audit = JSON.parse(authorizationAuditBytes);
  const reviewAuditSha256 = `sha256:${sha256(reviewAuditBytes)}`;
  const authorizationAuditSha256 = `sha256:${sha256(authorizationAuditBytes)}`;
  const reviewScope = {track: 'cet4', box_prefixes: boxPrefixes, card_ids: cardIds};
  const reviewInput = buildModelAcceptanceInputSha256({
    decisionType: 'full_track_review',
    scope: reviewScope,
    corpusFingerprint: fingerprint.digest,
    auditSha256: reviewAuditSha256,
  });
  const reviewPath = 'reviews/agent_self_review/current-full-track-review.json';
  const review = {
    schema_version: 'model-owned-full-track-review.v2',
    review_id: 'current-full-track-review-fixture',
    created_at: '2026-08-26T12:00:00.000Z',
    model_acceptances: [
      acceptance(reviewInput, ['card_semantic_review', 'source_provenance_review'], 'fixture:review:a'),
      acceptance(reviewInput, ['card_semantic_review', 'source_provenance_review'], 'fixture:review:b'),
    ],
    scope: reviewScope,
    specs_read: ['spec/review-workflow.json'],
    coverage: {
      expected_card_count: cardIds.length,
      reviewed_card_ids: cardIds,
      analysis_reference_check: {
        answer_matches_card: true,
        choice_or_bank_references_match_source: true,
        distractor_labels_match_explanations: true,
      },
      boxes: boxPrefixes.map(boxPrefix => ({box_prefix: boxPrefix, status: 'pass'})),
    },
    quality_audit: {
      report: 'reviews/audit_scopes/current-review-audit.json',
      report_sha256: reviewAuditSha256,
      corpus_fingerprint: fingerprint.digest,
      scope_has_no_hard_blockers: true,
      scope_summary: structuredClone(audit.scope_summary),
    },
    representative_cards: [cardIds[0]],
    removed_cards: [],
    batch_review: {
      status: 'ready_for_model_authorization',
      summary: 'Complete exact-track model review fixture.',
      remaining_risks: [],
      next_step: 'Create runtime-version-bound authorization.',
    },
  };
  const reviewIdentity = writeJson(root, reviewPath, review);
  const runtimePath = 'reviews/runtime_payloads/current-full-track-runtime.json';
  const runtimePayload = {
    source: {id: 'trusted-media-test-fixture', label: 'Trusted media test fixture'},
    track: 'cet4',
    card_records: cards,
    assets: [],
    release: null,
  };
  runtimePayload.content_version =
    deriveRuntimePayloadContentIdentity(runtimePayload).content_version;
  const runtimeIdentity = writeJson(root, runtimePath, runtimePayload);
  const authorizationPath = 'reviews/approved_batches/current-full-track-authorization.json';
  const authorizationScope = {
    track: 'cet4',
    purpose: 'formal_content',
    box_prefixes: boxPrefixes,
    card_ids: cardIds,
  };
  const authorizationInput = buildModelAcceptanceInputSha256({
    decisionType: 'full_track_content_authorization',
    scope: authorizationScope,
    corpusFingerprint: fingerprint.digest,
    auditSha256: authorizationAuditSha256,
    linkedReviewIdentity: {
      path: reviewPath,
      sha256: reviewIdentity.sha256,
    },
    additionalBindings: buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
      contentVersion: runtimePayload.content_version,
      runtimePayloadSha256: runtimeIdentity.sha256,
    }),
  });
  const authorization = {
    schema_version: 'model-owned-content-authorization.v2',
    authorization_id: 'current-full-track-authorization-fixture',
    authorization_mode: 'full_track',
    authorized_at: '2026-08-26T12:30:00.000Z',
    content_version: runtimePayload.content_version,
    model_acceptances: [
      acceptance(authorizationInput, ['content_authorization'], 'fixture:authorization:a'),
      acceptance(authorizationInput, ['content_authorization'], 'fixture:authorization:b'),
    ],
    scope: authorizationScope,
    summary: 'Exact current full-track test authorization.',
    representative_cards: [cardIds[0]],
    card_quality_audit: {
      report: 'reviews/audit_scopes/current-authorization-audit.json',
      report_sha256: authorizationAuditSha256,
      corpus_fingerprint: fingerprint.digest,
      scope_has_no_hard_blockers: true,
      scope_summary: structuredClone(audit.scope_summary),
    },
    validation: {
      harness: 'node scripts/validate_harness.mjs',
      cards: 'node scripts/validate_cards.mjs',
      card_quality_audit: 'node scripts/audit_card_quality.mjs',
      model_review: reviewPath,
      model_review_sha256: reviewIdentity.sha256,
      runtime_payload: runtimePath,
      runtime_payload_sha256: runtimeIdentity.sha256,
    },
    authorization_limits: [
      'Only the exact listed scope is authorized.',
      'No unrelated generation or provider fact is authorized.',
      'No deployment or device fact is authorized.',
    ],
  };
  writeJson(root, authorizationPath, authorization);
  return {authorization, authorizationPath, fingerprint, reviewPath, runtimePath};
}
