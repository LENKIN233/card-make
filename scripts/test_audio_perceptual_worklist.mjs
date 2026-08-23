#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PERCEPTUAL_CHECKS,
  audioPerceptualDecisionInputSha256,
  buildAudioPerceptualWorklist,
  parseArguments,
  reviewAudioPerceptualEntry,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';

test('a passing technical audit builds a pending model-owned v3 queue', t => {
  const fixture = createFixture(t);
  const result = buildFixtureWorklist(fixture);

  assert.equal(result.worklist.schema_version, 'audio-perceptual-worklist.v3');
  assert.deepEqual(result.worklist.scope, {
    mode: 'full_track',
    card_ids: ['000001'],
    expected_entry_count: 1,
    full_track_audio_card_count: 1,
    card_ids_fingerprint: digest('["000001"]'),
  });
  assert.deepEqual(result.worklist.progress, {
    total: 1,
    pending: 1,
    passed: 0,
    failed: 0,
    capability_unavailable: 0,
    complete: false,
  });
  assert.deepEqual(result.worklist.context_quality, {
    entries_with_complete_training_context: 1,
    missing_main_training_goal: 0,
    missing_box_progression_role: 0,
    formal_content_context_ready: true,
  });
  assert.equal(result.worklist.entries[0].audio.transcript, fixture.transcript);
  assert.deepEqual(
    Object.values(result.worklist.entries[0].checks),
    PERCEPTUAL_CHECKS.map(() => 'pending'),
  );
  assert.deepEqual(
    validateAudioPerceptualWorklist(result.worklist, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }),
    [],
  );
});

test('one-card model review requires complete consumption, all checks, and two exact-input runs', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  const checkUpdates = PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'}));
  const modelAcceptances = acceptancesForEntry(initial.entries[0], checkUpdates);
  const completed = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates,
    clock: () => new Date('2026-07-30T01:05:00.000Z'),
    completeAssetConsumed: true,
    modelAcceptances,
    worklist: initial,
  });
  assert.equal(completed.entries[0].review.status, 'passed');
  assert.equal(completed.entries[0].review.replacement_required, false);
  assert.equal(completed.progress.complete, true);
  assert.deepEqual(
    validateAudioPerceptualWorklist(completed, {
      requireComplete: true,
      root: fixture.root,
      technicalAudit: fixture.audit,
    }),
    [],
  );
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates,
        completeAssetConsumed: true,
        modelAcceptances,
        worklist: completed,
      }),
    /cannot be overwritten/,
  );
});

test('missing model capability, incomplete consumption, and incomplete failure evidence fail closed', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  const passChecks = PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'}));
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: passChecks,
        completeAssetConsumed: true,
        modelAcceptances: [],
        worklist: initial,
      }),
    /model acceptance is invalid/,
  );
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: passChecks,
        modelAcceptances: acceptancesForEntry(initial.entries[0], passChecks),
        worklist: initial,
      }),
    /complete_asset_consumed/,
  );
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: PERCEPTUAL_CHECKS.map(name => ({
          name,
          value: name === 'accurate_pronunciation' ? 'fail' : 'pass',
        })),
        completeAssetConsumed: true,
        modelAcceptances: acceptancesForEntry(
          initial.entries[0],
          PERCEPTUAL_CHECKS.map(name => ({
            name,
            value: name === 'accurate_pronunciation' ? 'fail' : 'pass',
          })),
        ),
        worklist: initial,
      }),
    /requires notes/,
  );

  const failed = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates: PERCEPTUAL_CHECKS.map(name => ({
      name,
      value: name === 'accurate_pronunciation' ? 'fail' : 'pass',
    })),
    completeAssetConsumed: true,
    modelAcceptances: acceptancesForEntry(
      initial.entries[0],
      PERCEPTUAL_CHECKS.map(name => ({
        name,
        value: name === 'accurate_pronunciation' ? 'fail' : 'pass',
      })),
    ),
    notes: 'The final consonant is pronounced incorrectly.',
    worklist: initial,
  });
  assert.equal(failed.entries[0].review.status, 'failed');
  assert.deepEqual(failed.entries[0].review.failure_codes, ['pronunciation_error']);
  assert.equal(failed.entries[0].review.replacement_required, true);
  const unavailable = reviewAudioPerceptualEntry({
    cardId: '000001',
    capabilityUnavailable: true,
    notes: 'No audio-capable model was available.',
    worklist: initial,
  });
  assert.equal(unavailable.entries[0].review.status, 'capability_unavailable');
});

test('reviewed entries survive stable refresh and changed identity requires acknowledgement', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  const checkUpdates = PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'}));
  const reviewed = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates,
    completeAssetConsumed: true,
    modelAcceptances: acceptancesForEntry(initial.entries[0], checkUpdates),
    worklist: initial,
  });
  const stable = buildFixtureWorklist(fixture, {existing: reviewed});
  assert.equal(stable.preserved_reviews, 1);
  assert.equal(stable.worklist.entries[0].review.status, 'passed');

  fixture.transcript = 'A changed transcript requires the audio to be reviewed again.';
  writeCardAndAudit(fixture);
  assert.throws(
    () => buildFixtureWorklist(fixture, {existing: reviewed}),
    /Reviewed audio identity changed/,
  );
  const reset = buildFixtureWorklist(fixture, {
    allowReviewedReset: true,
    existing: reviewed,
  });
  assert.equal(reset.reset_reviews, 1);
  assert.equal(reset.worklist.entries[0].review.status, 'pending');
});

test('scoped queue binds an exact subset while revalidating the full technical audit', t => {
  const fixture = createFixture(t);
  addSecondAudioCard(fixture);
  const result = buildFixtureWorklist(fixture, {scopeCardIds: ['000002']});

  assert.equal(result.worklist.schema_version, 'audio-perceptual-worklist.v3');
  assert.match(result.worklist.worklist_id, /^cet4-scoped-audio-perceptual-qc-/);
  assert.deepEqual(result.worklist.scope, {
    mode: 'card_ids',
    card_ids: ['000002'],
    expected_entry_count: 1,
    full_track_audio_card_count: 2,
    card_ids_fingerprint: digest('["000002"]'),
  });
  assert.deepEqual(result.worklist.entries.map(entry => entry.card_id), ['000002']);
  assert.deepEqual(
    validateAudioPerceptualWorklist(result.worklist, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }),
    [],
  );

  assert.throws(
    () => buildFixtureWorklist(fixture, {scopeCardIds: ['999999']}),
    /unknown audio cards/,
  );
  assert.throws(
    () => buildFixtureWorklist(fixture, {scopeCardIds: ['000002', '000002']}),
    /must be unique/,
  );
  const changedScope = structuredClone(result.worklist);
  changedScope.scope.card_ids = ['000001'];
  assert.match(
    validateAudioPerceptualWorklist(changedScope, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }).join('\n'),
    /scope does not match|entry order/,
  );
  assert.throws(
    () =>
      buildFixtureWorklist(fixture, {
        existing: result.worklist,
        scopeCardIds: ['000001'],
      }),
    /scope does not match requested scope/,
  );
});

test('legacy v1 full-track worklists remain valid and cannot declare a subset', t => {
  const fixture = createFixture(t);
  const current = buildFixtureWorklist(fixture).worklist;
  const legacy = structuredClone(current);
  legacy.schema_version = 'audio-perceptual-worklist.v1';
  delete legacy.scope;
  legacy.review_policy = {
    review_mode: 'human_perceptual_qc',
    agent_may_mark_passed: false,
    one_card_per_review_action: true,
    full_asset_listening_attestation_required: true,
    all_checks_required_before_terminal_status: true,
    failed_audio_requires_replacement: true,
    terminal_review_immutable: true,
    passing_worklist_is_not_formal_audio_qc: true,
  };
  legacy.entries[0].review = {
    status: 'pending',
    reviewer: null,
    listening_attestation: null,
    started_at: null,
    completed_at: null,
    notes: '',
    failure_codes: [],
    replacement_required: null,
  };
  legacy.progress = {
    total: 1,
    pending: 1,
    in_progress: 0,
    passed: 0,
    failed: 0,
    complete: false,
  };
  assert.deepEqual(
    validateAudioPerceptualWorklist(legacy, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }),
    [],
  );
  assert.match(
    validateAudioPerceptualWorklist(legacy, {
      requireComplete: true,
      root: fixture.root,
      technicalAudit: fixture.audit,
    }).join('\n'),
    /archive-only/,
  );
  legacy.scope = current.scope;
  assert.match(
    validateAudioPerceptualWorklist(legacy, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }).join('\n'),
    /worklist keys are not exact/,
  );
});

test('worklist validation detects transcript and audio byte tampering', t => {
  const fixture = createFixture(t);
  const worklist = buildFixtureWorklist(fixture).worklist;
  worklist.entries[0].audio.transcript = 'tampered';
  assert.match(
    validateAudioPerceptualWorklist(worklist, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }).join('\n'),
    /transcript hash|entry_identity/,
  );

  const clean = buildFixtureWorklist(fixture).worklist;
  fs.appendFileSync(fixture.assetPath, 'changed');
  assert.match(
    validateAudioPerceptualWorklist(clean, {
      root: fixture.root,
      technicalAudit: fixture.audit,
    }).join('\n'),
    /asset bytes mismatch/,
  );
});

test('CLI arguments require model acceptances, complete consumption, and all checks', () => {
  const args = [
      'review',
      '--file',
      'exports/worklist.json',
      '--card-id',
      '000001',
      '--acceptances',
      'exports/acceptances.json',
      '--complete-asset-consumed',
      ...PERCEPTUAL_CHECKS.flatMap(name => ['--check', `${name}=pass`]),
      '--notes',
      'Pronunciation issue.',
      '--apply',
    ];
  const parsed = parseArguments(args);
  assert.equal(parsed.modelAcceptancesPath, 'exports/acceptances.json');
  assert.equal(parsed.completeAssetConsumed, true);
  assert.equal(parsed.checkUpdates.length, 7);
  assert.equal(parsed.apply, true);
  assert.throws(
    () =>
      parseArguments([
        ...args,
        '--check', 'audio_matches_text=fail',
      ]),
    /duplicate --check/,
  );
  assert.deepEqual(
    parseArguments([
      'build',
      '--technical-audit',
      'exports/audit.json',
      '--output',
      'exports/worklist.json',
      '--scope-card-ids',
      '000002,000001',
    ]).scopeCardIds,
    ['000002', '000001'],
  );
  assert.throws(
    () =>
      parseArguments([
        'validate',
        '--file',
        'exports/worklist.json',
        '--scope-card-ids',
        '000001',
      ]),
    /valid only for build/,
  );
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-perceptual-worklist-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const fixture = {
    root,
    transcript: 'The students can link it up after class.',
    assetBytes: Buffer.from('fake-mp3-audio-bytes'),
    assetPath: path.join(root, 'ai_tts/cet4/0000/000001.mp3'),
    auditPath: path.join(root, 'exports/cet4-audio-technical-audit.json'),
  };
  writeCardAndAudit(fixture);
  return fixture;
}

function writeCardAndAudit(fixture) {
  fs.mkdirSync(path.join(fixture.root, 'card_boxes_json'), {recursive: true});
  fs.mkdirSync(path.dirname(fixture.assetPath), {recursive: true});
  fs.mkdirSync(path.dirname(fixture.auditPath), {recursive: true});
  fs.writeFileSync(fixture.assetPath, fixture.assetBytes);
  const cardDocument = {
    track: 'cet4',
    cards: [
      {
        card_id: '000001',
        card_group_name: '语音现象',
        card_box_name: '连读',
        audio: {
          path: 'ai_tts/cet4/0000/000001.mp3',
          duration_ms: 1000,
          transcript: fixture.transcript,
        },
        knowledge_ref: {
          library_id: '0',
          library_name: '听力',
          group_id: '1',
          group_name: '语音现象',
          box_id: '0',
          box_name: '连读',
          box_prefix: '0010',
        },
        quality_metadata: {
          main_training_goal: '识别辅音与元音之间的连读',
          box_progression_role: 'recognition',
        },
      },
    ],
  };
  fs.writeFileSync(
    path.join(fixture.root, 'card_boxes_json/cet4.json'),
    `${JSON.stringify(cardDocument, null, 2)}\n`,
  );
  fixture.audit = {
    schema_version: 'audio-technical-audit.v1',
    generated_at: '2026-07-30T00:00:00.000Z',
    track: 'cet4',
    summary: {errors: 0},
    verification: {},
    errors: [],
    assets: [
      {
        asset_path: 'ai_tts/cet4/0000/000001.mp3',
        card_id: '000001',
        declared_duration_ms: 1000,
        duration_delta_ms: 0,
        file_sha256: digest(fixture.assetBytes),
        size_bytes: fixture.assetBytes.length,
        technical: {
          bitrate_bps: 48000,
          channels: 1,
          duration_ms: 1000,
          format: 'mp3',
          sample_rate_hz: 24000,
        },
        transcript_sha256: digest(fixture.transcript),
      },
    ],
    ok: true,
  };
  fs.writeFileSync(fixture.auditPath, `${JSON.stringify(fixture.audit, null, 2)}\n`);
}

function addSecondAudioCard(fixture) {
  const transcript = 'However, the second speaker changes the direction.';
  const assetBytes = Buffer.from('second-fake-mp3-audio-bytes');
  const assetPath = path.join(fixture.root, 'ai_tts/cet4/0000/000002.mp3');
  fs.writeFileSync(assetPath, assetBytes);
  const cardFile = path.join(fixture.root, 'card_boxes_json/cet4.json');
  const document = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
  const card = structuredClone(document.cards[0]);
  card.card_id = '000002';
  card.audio = {
    path: 'ai_tts/cet4/0000/000002.mp3',
    duration_ms: 1200,
    transcript,
  };
  document.cards.push(card);
  fs.writeFileSync(cardFile, `${JSON.stringify(document, null, 2)}\n`);
  fixture.audit.assets.push({
    asset_path: 'ai_tts/cet4/0000/000002.mp3',
    card_id: '000002',
    declared_duration_ms: 1200,
    duration_delta_ms: 0,
    file_sha256: digest(assetBytes),
    size_bytes: assetBytes.length,
    technical: {
      bitrate_bps: 48000,
      channels: 1,
      duration_ms: 1200,
      format: 'mp3',
      sample_rate_hz: 24000,
    },
    transcript_sha256: digest(transcript),
  });
  fs.writeFileSync(fixture.auditPath, `${JSON.stringify(fixture.audit, null, 2)}\n`);
}

function buildFixtureWorklist(fixture, options = {}) {
  return buildAudioPerceptualWorklist({
    clock: () => new Date('2026-07-30T00:10:00.000Z'),
    root: fixture.root,
    technicalAudit: fixture.audit,
    technicalAuditPath: fixture.auditPath,
    track: 'cet4',
    ...options,
  });
}

function acceptancesForEntry(entry, checkUpdates) {
  const checks = Object.fromEntries(checkUpdates.map(update => [update.name, update.value]));
  const inputSha256 = audioPerceptualDecisionInputSha256(entry, checks);
  return [
    modelAcceptance(inputSha256, `audio-entry-${entry.card_id}-first`),
    modelAcceptance(inputSha256, `audio-entry-${entry.card_id}-second`),
  ];
}

function modelAcceptance(inputSha256, runId) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'codex',
      model: 'audio-capable-model',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-07-30T01:00:00.000Z',
      input_sha256: inputSha256,
      capabilities: ['audio_perceptual_review'],
      summary: 'The exact audio asset and all seven checks were reviewed.',
      findings: [],
    },
    decision: 'accepted',
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
