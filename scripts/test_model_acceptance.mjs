#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelAcceptanceInputSha256,
  isCurrentModelAcceptance,
  isLegacyV1HumanAuthorityRecord,
  validateIndependentModelAcceptances,
  validateModelAcceptance,
} from './lib/model_acceptance.mjs';

test('canonical model input binds decision, exact scope, audit, corpus, and linked review', () => {
  const base = {
    decisionType: 'content_authorization',
    scope: {
      track: 'cet4',
      purpose: 'formal_content',
      box_prefixes: ['0001', '0000'],
      card_ids: ['000002', '000001'],
    },
    corpusFingerprint: `sha256:${'a'.repeat(64)}`,
    auditSha256: `sha256:${'b'.repeat(64)}`,
    linkedReviewIdentity: {
      path: 'reviews/agent_self_review/review.json',
      sha256: `sha256:${'c'.repeat(64)}`,
    },
  };
  const digest = buildModelAcceptanceInputSha256(base);
  assert.equal(
    digest,
    buildModelAcceptanceInputSha256({
      ...base,
      scope: {
        ...base.scope,
        box_prefixes: [...base.scope.box_prefixes].reverse(),
        card_ids: [...base.scope.card_ids].reverse(),
      },
    }),
  );
  for (const changed of [
    {...base, decisionType: 'card_review'},
    {...base, scope: {...base.scope, card_ids: ['000001']}},
    {...base, auditSha256: `sha256:${'d'.repeat(64)}`},
    {...base, linkedReviewIdentity: {...base.linkedReviewIdentity, path: 'reviews/agent_self_review/other.json'}},
  ]) {
    assert.notEqual(buildModelAcceptanceInputSha256(changed), digest);
  }
});

function acceptance(overrides = {}) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      run_id: 'codex-task:01a02d8b-6046-7f12-b336-3772cd02707d',
    },
    evidence: {
      reviewed_at: '2026-08-23T12:00:00+08:00',
      input_sha256: `sha256:${'a'.repeat(64)}`,
      capabilities: ['card_semantic_review', 'content_authorization'],
      summary: 'The exact bound scope passed semantic and provenance review.',
      findings: [],
    },
    decision: 'accepted',
    ...overrides,
  };
}

test('accepts exact model-owned evidence with required capability', () => {
  assert.equal(isCurrentModelAcceptance(acceptance(), {
    requireAccepted: true,
    requiredCapabilities: ['content_authorization'],
  }), true);
});

test('rejects missing evidence, invented capabilities, and non-accepted decisions', () => {
  const invalid = acceptance({
    evidence: {
      reviewed_at: 'not-a-time',
      input_sha256: 'sha256:not-a-digest',
      capabilities: ['pretend_human_review'],
      summary: '',
      findings: [{
        code: 'blocking_fixture',
        severity: 'blocking',
        message: 'Fixture blocker.',
      }],
    },
    decision: 'rejected',
  });
  const codes = validateModelAcceptance(invalid, {
    requireAccepted: true,
    requiredCapabilities: ['audio_perceptual_review'],
  }).map(issue => issue.code);
  assert.ok(codes.includes('model_acceptance_reviewed_at_invalid'));
  assert.ok(codes.includes('model_acceptance_input_sha256_invalid'));
  assert.ok(codes.includes('model_acceptance_capabilities_invalid'));
  assert.ok(codes.includes('model_acceptance_summary_missing'));
  assert.ok(codes.includes('model_acceptance_not_accepted'));
});

test('classifies legacy human authority fields as archive-only evidence', () => {
  assert.equal(isLegacyV1HumanAuthorityRecord({approved_by_user: true}), true);
  assert.equal(isLegacyV1HumanAuthorityRecord({confirmed_by_user: true}), true);
  assert.equal(isLegacyV1HumanAuthorityRecord({coverage: {human_reviewer: 'external:fixture'}}), true);
  assert.equal(isLegacyV1HumanAuthorityRecord(acceptance()), false);
});

test('template placeholders are accepted only in explicit template mode', () => {
  const template = acceptance({
    actor: {
      kind: 'model_harness',
      agent: '<agent-id>',
      model: '<model-id>',
      run_id: '<run-id>',
    },
    evidence: {
      reviewed_at: '<RFC3339_WITH_TIMEZONE>',
      input_sha256: 'sha256:<64 lowercase hex characters>',
      capabilities: ['card_semantic_review'],
      summary: '<semantic-review-summary>',
      findings: [],
    },
  });
  assert.equal(validateModelAcceptance(template).length > 0, true);
  assert.deepEqual(validateModelAcceptance(template, {allowTemplatePlaceholders: true}), []);
});

test('accepted evidence cannot hide a blocking semantic finding', () => {
  const invalid = acceptance();
  invalid.evidence.findings.push({
    code: 'source_claim_unverified',
    severity: 'blocking',
    message: 'The claimed source could not be verified.',
  });
  assert.ok(validateModelAcceptance(invalid).some(
    issue => issue.code === 'model_acceptance_accepted_with_blocking_finding',
  ));
});

test('high-risk acceptance requires independent runs bound to one input', () => {
  const first = acceptance();
  const second = acceptance();
  second.actor.run_id = 'codex-task:independent-second-pass';
  assert.deepEqual(validateIndependentModelAcceptances([first, second], {
    requiredCapabilities: ['content_authorization'],
  }), []);
  second.actor.run_id = first.actor.run_id;
  assert.ok(validateIndependentModelAcceptances([first, second]).some(
    issue => issue.code === 'independent_model_acceptance_run_id_duplicate',
  ));
});
