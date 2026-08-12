import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  approveControlledPilotReview,
  buildControlledPilotReview,
  parseArgs,
  validateControlledPilotApproval,
  validateControlledPilotReview,
} from './manage_controlled_pilot_approval.mjs';

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

test('builds exact 14-box, 120-card aggregate evidence without approval', t => {
  const fixture = createFixture(t);
  const review = build(fixture);
  assert.equal(review.status, 'ready_for_user_approval');
  assert.equal(review.approval.approved_by_user, false);
  assert.equal(review.scope.card_ids.length, 120);
  assert.equal(review.source_records.agent_self_reviews.length, 28);
  assert.equal(review.coverage.sample_cards, 42);
  assert.equal(review.coverage.expansion_cards, 78);
  assert.deepEqual(validateControlledPilotReview(review), []);
});

test('rejects a missing expansion review and a runtime payload scope drift', t => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.root, 'reviews/agent_self_review/expansion-0000.json'));
  assert.throws(() => build(fixture), /exactly one expansion review for 0000/);
  const second = createFixture(t);
  second.runtimePayload.card_records[0].card_id = '999999';
  writeJson(second.runtimePayloadPath, second.runtimePayload);
  assert.throws(() => build(second), /Runtime payload card IDs do not match/);
});

test('rejects non-source findings and incomplete synthetic disclosure', t => {
  const fixture = createFixture(t);
  fixture.audit.scope_summary.by_severity.content_risk = 1;
  fixture.audit.scope_summary.by_rule.front_leaks_correct_answer = 1;
  writeJson(fixture.auditPath, fixture.audit);
  assert.throws(() => build(fixture), /exact 120 synthetic-card boundary/);
});

test('creates exact product approval only from explicit approved transition', t => {
  const fixture = createFixture(t);
  const review = build(fixture);
  assert.throws(
    () => approveControlledPilotReview({approvedAt: '2026-08-12T16:00:00+08:00', review}),
    /approval source is required/,
  );
  const result = approveControlledPilotReview({
    approvalSource: 'codex-task:test explicit user confirmation',
    approvedAt: '2026-08-12T16:00:00+08:00',
    review,
    reviewPath: 'reviews/controlled_pilot_reviews/review.json',
  });
  assert.equal(result.approvedReview.status, 'user_approved');
  assert.deepEqual(Object.keys(result.artifact).sort(), [
    'approved_at', 'approved_by_user', 'card_ids', 'content_version',
    'pilot_id', 'schema_version', 'scope', 'status',
  ]);
  assert.equal(result.artifact.scope, 'controlled_pilot_120');
  assert.deepEqual(validateControlledPilotApproval(result.artifact, result.approvedReview), []);
});

test('CLI parsing requires an explicit user-approval attestation', () => {
  const args = [
    'approve', '--review', 'reviews/controlled_pilot_reviews/review.json',
    '--approved-at', '2026-08-12T16:00:00+08:00',
    '--approval-source', 'codex-task:explicit user confirmation',
  ];
  assert.throws(() => parseArgs(args), /--attest-user-approved/);
  assert.equal(parseArgs([...args, '--attest-user-approved']).attestUserApproved, true);
});

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
  return {audit, auditPath, confirmation, confirmationPath, root, runtimePayload, runtimePayloadPath};
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
