#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PERCEPTUAL_CHECKS,
  buildAudioPerceptualWorklist,
  parseArguments,
  reviewAudioPerceptualEntry,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';

test('a passing technical audit builds a pending human-only queue', t => {
  const fixture = createFixture(t);
  const result = buildFixtureWorklist(fixture);

  assert.equal(result.worklist.schema_version, 'audio-perceptual-worklist.v1');
  assert.deepEqual(result.worklist.progress, {
    total: 1,
    pending: 1,
    in_progress: 0,
    passed: 0,
    failed: 0,
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

test('one-card review is resumable and becomes passed only after every check', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  const partial = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates: [{name: PERCEPTUAL_CHECKS[0], value: 'pass'}],
    clock: () => new Date('2026-07-30T01:00:00.000Z'),
    listenedToEntireAsset: true,
    reviewer: 'github:human-reviewer',
    worklist: initial,
  });
  assert.equal(partial.entries[0].review.status, 'in_progress');
  assert.equal(partial.progress.in_progress, 1);

  const completed = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates: PERCEPTUAL_CHECKS.slice(1).map(name => ({name, value: 'pass'})),
    clock: () => new Date('2026-07-30T01:05:00.000Z'),
    listenedToEntireAsset: true,
    reviewer: 'github:human-reviewer',
    worklist: partial,
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
        checkUpdates: [{name: PERCEPTUAL_CHECKS[0], value: 'fail'}],
        listenedToEntireAsset: true,
        reviewer: 'github:human-reviewer',
        worklist: completed,
      }),
    /cannot be overwritten/,
  );
});

test('agent identities and incomplete failure records fail closed', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: [{name: PERCEPTUAL_CHECKS[0], value: 'pass'}],
        listenedToEntireAsset: true,
        reviewer: 'team:codex-agent',
        worklist: initial,
      }),
    /identify a human/,
  );
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: [{name: PERCEPTUAL_CHECKS[0], value: 'pass'}],
        reviewer: 'team:cet-reviewer',
        worklist: initial,
      }),
    /listening attestation/,
  );
  assert.throws(
    () =>
      reviewAudioPerceptualEntry({
        cardId: '000001',
        checkUpdates: PERCEPTUAL_CHECKS.map(name => ({
          name,
          value: name === 'accurate_pronunciation' ? 'fail' : 'pass',
        })),
        listenedToEntireAsset: true,
        reviewer: 'team:cet-reviewer',
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
    listenedToEntireAsset: true,
    notes: 'The final consonant is pronounced incorrectly.',
    reviewer: 'team:cet-reviewer',
    worklist: initial,
  });
  assert.equal(failed.entries[0].review.status, 'failed');
  assert.deepEqual(failed.entries[0].review.failure_codes, ['pronunciation_error']);
  assert.equal(failed.entries[0].review.replacement_required, true);
});

test('reviewed entries survive stable refresh and changed identity requires acknowledgement', t => {
  const fixture = createFixture(t);
  const initial = buildFixtureWorklist(fixture).worklist;
  const reviewed = reviewAudioPerceptualEntry({
    cardId: '000001',
    checkUpdates: PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'})),
    listenedToEntireAsset: true,
    reviewer: 'external:cet-listener',
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

test('CLI arguments preserve repeated one-card check updates', () => {
  assert.deepEqual(
    parseArguments([
      'review',
      '--file',
      'exports/worklist.json',
      '--card-id',
      '000001',
      '--reviewer',
      'github:human-reviewer',
      '--attest-listened',
      '--check',
      'audio_matches_text=pass',
      '--check',
      'accurate_pronunciation=fail',
      '--notes',
      'Pronunciation issue.',
      '--apply',
    ]),
    {
      allowReviewedReset: false,
      apply: true,
      attestListened: true,
      cardId: '000001',
      checkUpdates: [
        {name: 'audio_matches_text', value: 'pass'},
        {name: 'accurate_pronunciation', value: 'fail'},
      ],
      command: 'review',
      existingPath: null,
      notes: 'Pronunciation issue.',
      outputPath: null,
      requireComplete: false,
      reviewer: 'github:human-reviewer',
      technicalAuditPath: null,
      track: 'cet4',
      worklistPath: 'exports/worklist.json',
    },
  );
  assert.throws(
    () =>
      parseArguments([
        'review',
        '--file',
        'exports/worklist.json',
        '--card-id',
        '000001',
        '--reviewer',
        'github:human-reviewer',
        '--attest-listened',
        '--check',
        'audio_matches_text=pass',
        '--check',
        'audio_matches_text=fail',
      ]),
    /duplicate --check/,
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

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
