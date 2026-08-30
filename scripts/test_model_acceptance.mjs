#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildContentAuthorizationAdditionalBindings,
  buildModelAcceptanceInputSha256,
  deriveRuntimePayloadContentIdentity,
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

test('full-track authorization binds canonical runtime content_version without burdening ordinary authorization', () => {
  const base = {
    decisionType: 'full_track_content_authorization',
    scope: {
      track: 'cet4',
      purpose: 'formal_content',
      box_prefixes: ['0000'],
      card_ids: ['000001'],
    },
    corpusFingerprint: `sha256:${'a'.repeat(64)}`,
    auditSha256: `sha256:${'b'.repeat(64)}`,
    linkedReviewIdentity: {
      path: 'reviews/agent_self_review/full-track-review.json',
      sha256: `sha256:${'c'.repeat(64)}`,
    },
  };
  const versionA = `sha256:${'d'.repeat(64)}`;
  const versionB = `sha256:${'e'.repeat(64)}`;
  const payloadA = `sha256:${'f'.repeat(64)}`;
  const payloadB = `sha256:${'1'.repeat(64)}`;
  const inputA = buildModelAcceptanceInputSha256({
    ...base,
    additionalBindings: buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
      contentVersion: versionA,
      runtimePayloadSha256: payloadA,
    }),
  });
  const inputB = buildModelAcceptanceInputSha256({
    ...base,
    additionalBindings: buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
      contentVersion: versionB,
      runtimePayloadSha256: payloadA,
    }),
  });
  assert.notEqual(inputA, inputB);
  assert.notEqual(
    inputA,
    buildModelAcceptanceInputSha256({
      ...base,
      additionalBindings: buildContentAuthorizationAdditionalBindings({
        authorizationMode: 'full_track',
        contentVersion: versionA,
        runtimePayloadSha256: payloadB,
      }),
    }),
  );
  assert.throws(
    () => buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
    }),
    /content_version/,
  );
  assert.throws(
    () => buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
      contentVersion: versionA,
    }),
    /runtime_payload_sha256/,
  );
  assert.deepEqual(
    buildContentAuthorizationAdditionalBindings({
      authorizationMode: undefined,
      contentVersion: undefined,
    }),
    {},
  );
  assert.deepEqual(
    buildContentAuthorizationAdditionalBindings({
      authorizationMode: undefined,
      contentVersion: versionA,
    }),
    {content_version: versionA},
  );
});

test('full-track runtime content_version is derived from normalized immutable payload content', () => {
  const payload = {
    source: {id: 'fixture', label: 'Fixture'},
    track: 'cet4',
    card_records: [{card_id: '000001', front: {text: 'Prompt'}}],
    release: null,
  };
  const identity = deriveRuntimePayloadContentIdentity(payload);
  assert.match(identity.content_version, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(identity.card_ids, ['000001']);
  assert.equal(
    deriveRuntimePayloadContentIdentity({
      ...payload,
      content_version: identity.content_version,
    }).content_version,
    identity.content_version,
  );
  assert.throws(
    () => deriveRuntimePayloadContentIdentity({
      ...payload,
      content_version: `sha256:${'0'.repeat(64)}`,
    }),
    /does not match normalized content/,
  );
});

test('runtime identity rejects prompt, model, harness, and credential authoring fields', () => {
  const base = {
    source: {id: 'fixture', label: 'Fixture'},
    track: 'cet4',
    card_records: [{card_id: '000001', front: {text: 'Prompt'}}],
  };
  const mutations = [
    card => {
      card.front.system_prompt = 'sentinel-system-prompt';
    },
    card => {
      card.model = 'sentinel-model';
    },
    card => {
      card.harness = {run_id: 'sentinel-run'};
    },
    card => {
      card.credentials = {token: 'sentinel-token'};
    },
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(base);
    mutate(payload.card_records[0]);
    assert.throws(
      () => deriveRuntimePayloadContentIdentity(payload),
      /authoring-only field/,
    );
  }
});

test('sharded runtime manifest reconstructs one canonical content identity and rejects shard replay', () => {
  const direct = {
    source: {id: 'fixture', label: 'Fixture'},
    track: 'cet4',
    card_records: [
      {card_id: '000001', front: {text: 'One'}},
      {card_id: '000002', front: {text: 'Two'}},
    ],
    assets: [{
      asset_id: 'audio-1',
      duration_ms: 1000,
      media_type: 'audio/mpeg',
      sha256: `sha256:${'a'.repeat(64)}`,
      size_bytes: 100,
    }],
  };
  const contentVersion =
    deriveRuntimePayloadContentIdentity(direct).content_version;
  const shards = new Map([
    ['reviews/runtime_payloads/fixture-001.json', {
      schema_version: 'card-make-runtime-card-shard.v1',
      track: 'cet4',
      card_records: [direct.card_records[0]],
    }],
    ['reviews/runtime_payloads/fixture-002.json', {
      schema_version: 'card-make-runtime-card-shard.v1',
      track: 'cet4',
      card_records: [direct.card_records[1]],
    }],
  ]);
  const sha256 = value => `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
  const manifest = {
    schema_version: 'card-make-runtime-payload-manifest.v1',
    source: direct.source,
    track: 'cet4',
    content_version: contentVersion,
    card_record_shards: [...shards].map(([path, shard]) => ({
      path,
      sha256: sha256(shard),
      card_count: 1,
      first_card_id: shard.card_records[0].card_id,
      last_card_id: shard.card_records[0].card_id,
    })),
    assets: direct.assets,
    release: null,
  };
  const loadShard = path => ({
    payload: structuredClone(shards.get(path)),
    sha256: sha256(shards.get(path)),
  });
  assert.deepEqual(
    deriveRuntimePayloadContentIdentity(manifest, {loadShard}),
    deriveRuntimePayloadContentIdentity({...direct, content_version: contentVersion}),
  );
  assert.throws(
    () => deriveRuntimePayloadContentIdentity(manifest, {
      loadShard: path => ({...loadShard(path), sha256: `sha256:${'0'.repeat(64)}`}),
    }),
    /shard is invalid/,
  );
  const replayed = structuredClone(manifest);
  replayed.card_record_shards.reverse();
  assert.throws(
    () => deriveRuntimePayloadContentIdentity(replayed, {loadShard}),
    /card range is invalid/,
  );
});

function acceptance(overrides = {}) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'agent:codex',
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

test('requires a typed machine principal for current model acceptance', () => {
  const value = acceptance();
  value.actor.agent = 'codex-untyped';
  assert.ok(validateModelAcceptance(value).some(
    issue => issue.code === 'model_acceptance_actor_agent_principal_invalid'));
  value.actor.agent = 'agent:codex-typed';
  assert.equal(validateModelAcceptance(value).length, 0);
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
