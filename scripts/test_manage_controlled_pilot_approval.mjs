import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authorizeControlledPilotReviewV2,
  parseArgs,
  validateControlledPilotAuthorizationV2,
  validateControlledPilotReviewV2,
  validateTrackedRecords,
} from './manage_controlled_pilot_approval.mjs';
import {buildModelAcceptanceInputSha256} from './lib/model_acceptance.mjs';

const CONTENT_VERSION = `sha256:${'a'.repeat(64)}`;
const TARGETS = Array.from({length: 14}, (_, index) => {
  const prefix = String(index).padStart(4, '0');
  const target = index < 8 ? 9 : 8;
  return {
    box_prefix: prefix,
    target_card_count: target,
    sample_card_ids: [1, 2, 3].map(card => `${prefix}${String(card).padStart(2, '0')}`),
  };
});

test('legacy build and approve CLI commands are archive-only', () => {
  assert.throws(() => parseArgs(['build']), /archive-only/);
  assert.throws(() => parseArgs(['approve']), /archive-only/);
  assert.deepEqual(parseArgs([
    'authorize',
    '--review', 'reviews/controlled_pilot_reviews/review.json',
    '--acceptances', 'exports/model-acceptances.json',
    '--authorized-at', '2026-08-23T12:00:00+08:00',
    '--output', 'reviews/controlled_pilot_approvals/authorization.json',
  ]), {
    apply: false,
    command: 'authorize',
    review: 'reviews/controlled_pilot_reviews/review.json',
    acceptances: 'exports/model-acceptances.json',
    authorized_at: '2026-08-23T12:00:00+08:00',
    output: 'reviews/controlled_pilot_approvals/authorization.json',
  });
});

test('model-owned pilot authorization binds complete review, sources, audit, runtime, and two independent runs', t => {
  const fixture = createFixture(t);
  const cardIds = fixture.allIds;
  const auditSha256 = digest(fs.readFileSync(fixture.auditPath));
  const sourceReviewPath = 'reviews/agent_self_review/model-full-track-source.json';
  const sourceScope = {
    track: 'cet4',
    box_prefixes: TARGETS.map(target => target.box_prefix),
    card_ids: cardIds,
  };
  const sourceInput = buildModelAcceptanceInputSha256({
    decisionType: 'full_track_review',
    scope: sourceScope,
    corpusFingerprint: `sha256:${'b'.repeat(64)}`,
    auditSha256,
  });
  writeJson(path.join(fixture.root, sourceReviewPath), {
    schema_version: 'model-owned-full-track-review.v2',
    review_id: 'pilot-source-review',
    created_at: '2026-08-23T11:00:00+08:00',
    model_acceptances: [
      modelAcceptance('codex-task:source-first', sourceInput, ['card_semantic_review', 'source_provenance_review']),
      modelAcceptance('codex-task:source-second', sourceInput, ['card_semantic_review', 'source_provenance_review']),
    ],
    scope: sourceScope,
    quality_audit: {
      report: 'reviews/audit_scopes/pilot.json',
      report_sha256: auditSha256,
      corpus_fingerprint: 'b'.repeat(64),
    },
  });
  const reviewPath = 'reviews/controlled_pilot_reviews/model-review.json';
  const review = {
    schema_version: 'controlled-pilot-review.v2',
    review_id: 'pilot-model-review',
    created_at: '2026-08-23T11:30:00+08:00',
    pilot_id: 'cet4-controlled-pilot-v2',
    content_version: CONTENT_VERSION,
    scope: {
      track: 'cet4',
      purpose: 'controlled_pilot',
      card_count: 120,
      box_prefixes: TARGETS.map(target => target.box_prefix),
      card_ids: cardIds,
    },
    source_records: {
      runtime_payload: 'exports/runtime.json',
      runtime_payload_sha256: digest(fs.readFileSync(fixture.runtimePayloadPath)),
      model_reviews: [sourceReviewPath],
      scoped_audit: 'reviews/audit_scopes/pilot.json',
      scoped_audit_sha256: auditSha256,
    },
    coverage: {
      reviewed_cards: 120,
      boxes: TARGETS.map(target => ({
        box_prefix: target.box_prefix,
        card_ids: cardIds.filter(cardId => cardId.startsWith(target.box_prefix)),
        status: 'passed',
      })),
    },
    quality: {
      corpus_fingerprint: `sha256:${'b'.repeat(64)}`,
      hard_blockers: 0,
      content_risks: 0,
      review_gaps: 0,
      source_risks: 120,
      synthetic_source_cards: 120,
      source_disclosure: 'synthetic_training_content_not_true_exam',
    },
    authorization: {
      model_acceptance: null,
      authorized_at: null,
      artifact_path: null,
    },
    authorization_boundary: {
      audio_qc_required_separately: true,
      pilot_publication_required_separately: true,
      external_facts_must_not_be_inferred: true,
      gate_eligible: false,
    },
    status: 'ready_for_model_authorization',
  };
  writeJson(path.join(fixture.root, reviewPath), review);
  assert.deepEqual(validateControlledPilotReviewV2(review, {root: fixture.root}), []);
  const reviewSha256 = digest(fs.readFileSync(path.join(fixture.root, reviewPath)));
  const authorizationInput = buildModelAcceptanceInputSha256({
    decisionType: 'controlled_pilot_authorization',
    scope: review.scope,
    corpusFingerprint: review.quality.corpus_fingerprint,
    auditSha256,
    linkedReviewIdentity: {path: reviewPath, sha256: reviewSha256},
    additionalBindings: {
      pilot_id: review.pilot_id,
      content_version: review.content_version,
      runtime_payload_sha256: review.source_records.runtime_payload_sha256,
    },
  });
  const first = modelAcceptance('codex-task:pilot-first', authorizationInput);
  const second = modelAcceptance('codex-task:pilot-second', authorizationInput);
  const artifact = authorizeControlledPilotReviewV2({
    authorizedAt: '2026-08-23T12:00:00+08:00',
    modelAcceptances: [first, second],
    review,
    reviewPath,
    root: fixture.root,
  });
  assert.equal(artifact.schema_version, 'controlled-pilot-authorization.v2');
  assert.equal(artifact.status, 'authorized');
  assert.equal(artifact.model_acceptances.length, 2);
  assert.deepEqual(validateControlledPilotAuthorizationV2(
    artifact,
    review,
    {reviewPath, root: fixture.root},
  ), []);
  writeJson(
    path.join(fixture.root, 'reviews/controlled_pilot_approvals/model-authorization.json'),
    artifact,
  );
  assert.deepEqual(validateTrackedRecords(fixture.root).errors, []);
  assert.throws(
    () => authorizeControlledPilotReviewV2({
      authorizedAt: '2026-08-23T12:00:00+08:00',
      modelAcceptances: [first, first],
      review,
      reviewPath,
      root: fixture.root,
    }),
    /run_id_duplicate/,
  );
  const tampered = structuredClone(review);
  tampered.source_records.runtime_payload_sha256 = `sha256:${'c'.repeat(64)}`;
  assert.notDeepEqual(validateControlledPilotReviewV2(tampered, {root: fixture.root}), []);
});

function modelAcceptance(
  runId,
  inputSha256 = CONTENT_VERSION,
  capabilities = ['content_authorization'],
) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-08-23T12:00:00+08:00',
      input_sha256: inputSha256,
      capabilities,
      summary: 'Independent controlled-pilot authorization pass.',
      findings: [],
    },
    decision: 'accepted',
  };
}

function build(fixture) {
  return buildControlledPilotReview({
    audit: fixture.audit,
    auditPath: fixture.auditPath,
    clock: () => new Date('2026-08-12T08:00:00.000Z'),
    confirmation: fixture.confirmation,
    confirmationPath: fixture.confirmationPath,
    contentVersion: CONTENT_VERSION,
    pilotId: 'cet4-controlled-pilot-test',
    root: fixture.root,
    runtimePayload: fixture.runtimePayload,
    runtimePayloadPath: fixture.runtimePayloadPath,
  });
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-pilot-approval-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  for (const directory of [
    'card_boxes_json',
    'exports',
    'reviews/agent_self_review',
    'reviews/audit_scopes',
    'reviews/controlled_pilot_reviews',
    'reviews/controlled_pilot_approvals',
    'reviews/sample_confirmations',
  ]) fs.mkdirSync(path.join(root, directory), {recursive: true});

  const allCards = [];
  const allIds = [];
  for (const target of TARGETS) {
    const ids = Array.from({length: target.target_card_count}, (_, index) =>
      `${target.box_prefix}${String(index + 1).padStart(2, '0')}`);
    allIds.push(...ids);
    allCards.push(...ids.map(cardId => ({
      card_id: cardId,
      track: 'cet4',
      interaction_id: 'flip',
      knowledge_ref: {box_prefix: target.box_prefix},
      quality_flags: ['synthetic_source'],
    })));
    const expansionIds = ids.slice(3);
    writeJson(
      path.join(root, `reviews/agent_self_review/sample-${target.box_prefix}.json`),
      reviewRecord({ids: ids.slice(0, 3), prefix: target.box_prefix, sample: true}),
    );
    writeJson(
      path.join(root, `reviews/agent_self_review/expansion-${target.box_prefix}.json`),
      reviewRecord({ids: expansionIds, prefix: target.box_prefix, sample: false}),
    );
  }
  writeJson(path.join(root, 'card_boxes_json/cet4.json'), {track: 'cet4', cards: allCards});

  const confirmation = {
    schema_version: 'sample-confirmation.v1',
    confirmation_id: 'confirmation',
    confirmed_by_user: true,
    scope: {
      track: 'cet4',
      purpose: 'controlled_pilot',
      target_card_count: 120,
      box_targets: TARGETS,
    },
    authorizes: {confirmed_box_expansion: true},
    does_not_authorize: ['formal_content_approval'],
    final_user_approval_required: true,
    gate_eligible: false,
  };
  const confirmationPath = path.join(root, 'reviews/sample_confirmations/confirmation.json');
  writeJson(confirmationPath, confirmation);

  const audit = {
    ok: true,
    audit_version: 'card-make-quality-audit-v1',
    report_type: 'scoped_card_quality_audit',
    corpus_fingerprint: {digest: 'b'.repeat(64)},
    scope: {card_ids: [...allIds].sort(), missing_card_ids: []},
    scope_summary: {
      card_ids: [...allIds].sort(),
      card_count: 120,
      issue_count: 120,
      by_severity: {hard_blocker: 0, content_risk: 0, review_gap: 0, source_risk: 120},
      by_rule: {
        front_leaks_correct_answer: 0,
        synthetic_source: 120,
        unverified_source: 0,
      },
    },
    scoped_hard_blocker_issues: [],
  };
  const auditPath = path.join(root, 'reviews/audit_scopes/pilot.json');
  writeJson(auditPath, audit);

  const runtimePayload = {
    track: 'cet4',
    content_version: CONTENT_VERSION,
    card_records: allIds.map(card_id => ({card_id})),
    assets: Array.from({length: 24}, (_, index) => ({asset_id: `asset-${index}`})),
  };
  const runtimePayloadPath = path.join(root, 'exports/runtime.json');
  writeJson(runtimePayloadPath, runtimePayload);
  return {allIds, audit, auditPath, confirmation, confirmationPath, root, runtimePayload, runtimePayloadPath};
}

function reviewRecord({ids, prefix, sample}) {
  return {
    scope: {box_prefixes: [prefix], card_ids: ids},
    sample_policy: sample
      ? {review_scope_type: 'three_card_sample_per_box'}
      : {review_scope_type: 'confirmed_box_expansion', sample_confirmation_id: 'confirmation'},
    cards: ids.map(card_id => ({
      card_id,
      status: 'pass',
      blocker_scan: {logic_error: false},
      analysis_reference_check: {
        answer_matches_card: true,
        choice_or_bank_references_match_source: true,
        distractor_labels_match_explanations: true,
      },
    })),
    batch_review: {
      status: sample ? 'recommend_user_confirmation' : 'reviewed_confirmed_box_expansion',
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
