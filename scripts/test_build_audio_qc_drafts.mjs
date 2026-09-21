import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {buildAudioQcDrafts} from './build_audio_qc_drafts.mjs';
import {
  audioPerceptualDecisionInputSha256,
  buildAudioPerceptualWorklist,
  PERCEPTUAL_CHECKS,
  reviewAudioPerceptualEntry,
} from './manage_audio_perceptual_worklist.mjs';
import {createCurrentFullTrackAuthorizationFixture} from './test_current_full_track_authorization_fixture.mjs';
import {auditAudioQcRecord, validateAudioQcRecord} from './validate_audio_qc.mjs';
import {createHistoricalAudioQcReplay} from './lib/historical_audio_qc.mjs';

const ATTESTATIONS = Object.freeze({
  no_autoplay_assumption: true,
  front_side_no_required_subtitles: true,
  tts_audio_not_used_as_source_authenticity: true,
});

function buildFixtureAudioQc(fixture, options) {
  return buildAudioQcDrafts({
    attestationBundlePath: fixture.attestationBundlePath,
    execFile: fixture.execFile,
    trustedReceiptPath: fixture.trustedReceiptPath,
    typeSpecificVerifier: fixture.typeSpecificVerifier,
    ...options,
  });
}

test('complete CET6 evidence produces QC only for its registered track and counts', t => {
  const fixture = createFixture(t, {track: 'cet6'});
  writeWorklist(fixture, completeWorklist(fixture.worklist));
  commitFixture(fixture);
  const options = {attestations: ATTESTATIONS, contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root, worklistPath: fixture.worklistPath};
  const result = buildFixtureAudioQc(fixture, options);
  assert.equal(result.summary.card_count, 328);
  assert.equal(result.records.flatMap(record => record.scope.card_ids).length, 328);
  const receiptFile = path.join(fixture.root, fixture.trustedReceiptPath);
  const original = fs.readFileSync(receiptFile);
  for (const mutation of [
    receipt => { receipt.candidate.audio_asset_count = 301; },
    receipt => { receipt.candidate.track = 'cet4'; },
    receipt => { receipt.candidate.track = '__proto__'; },
  ]) {
    const receipt = JSON.parse(original); mutation(receipt);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt) + '\n');
    commitFixture(fixture);
    assert.throws(() => buildFixtureAudioQc(fixture, options), /receipt does not bind/);
  }
});

test('immutable old QC remains auditable but never authorizes changed content', t => {
  const fixture = createFixture(t);
  writeWorklist(fixture, completeWorklist(fixture.worklist));
  commitFixture(fixture);
  const built = buildFixtureAudioQc(fixture, {attestations: ATTESTATIONS,
    contentAuthorizationPath: fixture.authorizationPath, root: fixture.root,
    worklistPath: fixture.worklistPath});
  const record = built.records[0], source = 'reviews/audio_qc/history.json';
  fs.mkdirSync(path.join(fixture.root, 'reviews/audio_qc'), {recursive: true});
  const recordBytes = JSON.stringify(record, null, 2) + '\n';
  fs.writeFileSync(path.join(fixture.root, source), recordBytes);
  commitFixture(fixture);
  const options = {root: fixture.root, source, execFile: fixture.execFile,
    typeSpecificVerifier: fixture.typeSpecificVerifier};
  assert.deepEqual(validateAudioQcRecord(record, options), []);
  const cardsPath = path.join(fixture.root, 'card_boxes_json/cet4.json');
  const corpus = JSON.parse(fs.readFileSync(cardsPath));
  corpus.cards[0].front = {text: 'A revised training question.'};
  fs.writeFileSync(cardsPath, JSON.stringify(corpus, null, 2) + '\n');
  // This also verifies that a cached receipt cannot hide working-tree drift.
  assert.ok(validateAudioQcRecord(record, options).some(issue => /not current/.test(issue.message || '')));
  const replay = createHistoricalAudioQcReplay(options);
  t.after(() => replay.dispose());
  assert.equal(auditAudioQcRecord(record, {...options, historicalReplay: replay}).ok, false,
    'a new record at HEAD cannot fall back to history');
  commitFixture(fixture);
  const audited = auditAudioQcRecord(record, {...options, historicalReplay: replay});
  assert.deepEqual(audited.errors, []);
  assert.equal(audited.evidence_status, 'historical');
  assert.equal(audited.current_formal_ready, false);
  assert.equal(audited.historical_replay.formal_ready, false);
  assert.ok(validateAudioQcRecord(record, options).some(issue => /not current/.test(issue.message || '')));
  // Whitespace-only edits are still evidence-byte drift, even with the same JSON meaning.
  fs.appendFileSync(path.join(fixture.root, source), ' ');
  assert.equal(auditAudioQcRecord(record, {...options, historicalReplay: replay}).ok, false);
  execFileSync('git', ['add', '--', source], {cwd: fixture.root});
  fs.writeFileSync(path.join(fixture.root, source), recordBytes);
  assert.equal(auditAudioQcRecord(record, {...options, historicalReplay: replay}).ok, false,
    'restoring only the worktree must not hide a staged evidence change');
  execFileSync('git', ['restore', '--staged', '--source=HEAD', '--', source], {cwd: fixture.root});
  const manifest = path.join(fixture.root, 'reviews/trusted_media_runs/current-receipt/audio-manifest.json');
  fs.appendFileSync(manifest, ' ');
  assert.equal(auditAudioQcRecord(record, {...options, historicalReplay: replay}).ok, false);
  commitFixture(fixture);
  assert.equal(auditAudioQcRecord(record, {...options, historicalReplay: replay}).ok, false,
    'committing changed linked artifacts must not relabel them as immutable history');
});

test('builds one formal-ready model-owned QC record per box after complete model review', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);

  const result = buildFixtureAudioQc(fixture, {
    attestations: ATTESTATIONS,
    clock: () => new Date('2026-08-12T08:00:00.000Z'),
    contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });

  assert.equal(result.records.length, 108);
  assert.equal(new Set(result.records.map(record => record.scope.box_prefixes[0])).size, 108);
  assert.equal(result.summary.card_count, 301);
  assert.equal(result.summary.formal_content_approval_created, false);
  assert.equal(result.summary.linked_content_authorization, fixture.authorizationPath);
  assert.match(result.summary.linked_content_authorization_sha256, /^[a-f0-9]{64}$/);
  for (const record of result.records) {
    assert.equal(record.verdict.formal_audio_ready, true);
    assert.equal(record.schema_version, 'model-owned-audio-qc.v2');
    assert.equal(record.model_acceptances.length, 2);
    assert.deepEqual(
      record.model_acceptances.map(acceptance => acceptance.actor.agent),
      ['agent:audio-evidence-aggregate-lane-1', 'agent:audio-evidence-aggregate-lane-2'],
    );
    assert.equal(record.generation_plan.provider, 'legacy_unknown');
    assert.equal(record.source_records.linked_approved_batch, fixture.authorizationPath);
    assert.equal(record.source_records.linked_agent_self_reviews.length, 1);
    assert.equal(record.generated_assets[0].file_sha256.length, 64);
    assert.equal(record.qa_checks.tts_audio_not_used_as_source_authenticity, true);
    assert.equal(record.per_card_qc[0].complete_asset_consumed, true);
    for (const field of [
      'matches_text', 'target_signal', 'pronunciation', 'speed', 'rhythm',
      'stress_pauses', 'no_noise',
    ]) assert.equal(record.per_card_qc[0][field], true);
    assert.deepEqual(
      validateAudioQcRecord(record, {
        execFile: fixture.execFile,
        root: fixture.root,
        typeSpecificVerifier: fixture.typeSpecificVerifier,
      }),
      [],
    );
  }
  assert.deepEqual(fixture.verificationCalls(), {attestation: 1, semantic: 1});
  assert.equal(
    result.records.find(record => record.scope.box_prefixes[0] === '0010')
      .text_gate.transcripts[0].target_signal,
    '识别 turn off 中的辅音加元音连读',
  );
});

test('formal QC re-verifies exact tracked receipt and attestation bytes', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  const result = buildFixtureAudioQc(fixture, {
    attestations: ATTESTATIONS,
    contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root,
    typeSpecificVerifier: fixture.typeSpecificVerifier,
    worklistPath: fixture.worklistPath,
  });
  const forged = structuredClone(result.records[0]);
  forged.source_records.trusted_media_receipt_sha256 = '0'.repeat(64);
  const issues = validateAudioQcRecord(forged, {
    execFile: fixture.execFile,
    root: fixture.root,
  });
  assert.ok(issues.some(issue =>
    issue.code === 'audio_qc_trusted_media_evidence_verification_failed'));
});

test('formal QC rejects attested evidence whose raw package cannot replay', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      typeSpecificVerifier: () => ({ok: false, formal_ready: false}),
      worklistPath: fixture.worklistPath,
    }),
    /type-specific artifact replay is not formal-ready/,
  );
});

test('type-specific verifier failure keeps one bounded diagnostic without bearer data', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
      attestationBundlePath: fixture.attestationBundlePath,
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      execFile: fixture.execFile,
      root: fixture.root,
      trustedReceiptPath: fixture.trustedReceiptPath,
      typeSpecificVerifier() {
        const error = new Error('verifier failed');
        error.stdout = Buffer.from('Authorization: Bearer secret-value exact replay mismatch');
        throw error;
      },
      worklistPath: fixture.worklistPath,
    }),
    error =>
      /exact replay mismatch/.test(error.message) &&
      !/secret-value/.test(error.message) &&
      error.message.length < 1200,
  );
});

test('fails closed while any perceptual entry is pending', t => {
  const fixture = createFixture(t);
  writeWorklist(fixture, fixture.worklist);
  commitFixture(fixture);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /worklist is not complete/,
  );
});

test('requires all three product-semantics attestations', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: {
        no_autoplay_assumption: true,
        front_side_no_required_subtitles: true,
      },
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /tts_audio_not_used_as_source_authenticity attestation is required/,
  );
});

test('current model-owned full-track review satisfies the TTS text gate without a legacy boolean', t => {
  const fixture = createFixture(t, {
    modelOwnedTextReview: true,
    ttsTextReviewed: false,
  });
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  const result = buildFixtureAudioQc(fixture, {
    attestations: ATTESTATIONS,
    contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });
  assert.equal(result.records.length, 108);
  const authorization = JSON.parse(fs.readFileSync(
    path.join(fixture.root, fixture.authorizationPath),
  ));
  assert.ok(result.records.every(record =>
    record.text_gate.tts_text_reviewed === true &&
    record.source_records.linked_agent_self_reviews.includes(
      authorization.validation.model_review,
    )));
});

test('rejects duplicate per-card evidence lanes before aggregation', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  reviewed.entries[0].review.model_acceptances[1] =
    reviewed.entries[0].review.model_acceptances[0];
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /worklist is invalid|run_id_duplicate|reuses model run_id/,
  );
});

test('current content authorization must cover every audio card', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  const authorizationFile = path.join(fixture.root, fixture.authorizationPath);
  const authorization = JSON.parse(fs.readFileSync(authorizationFile));
  authorization.scope.card_ids.pop();
  fs.writeFileSync(authorizationFile, `${JSON.stringify(authorization, null, 2)}\n`);
  commitFixture(fixture);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /failed canonical replay|does not cover the audio scope/,
  );
});

test('refuses an untracked or dirty reviewed worklist', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /direct tracked file in HEAD/,
  );
  commitFixture(fixture);
  fs.appendFileSync(path.join(fixture.root, fixture.worklistPath), ' ');
  assert.throws(
    () => buildFixtureAudioQc(fixture, {
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /exactly match the tracked HEAD artifact/,
  );
});

test('formal QC cannot be built without a tracked trusted receipt and attestation', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /escapes the workspace|is missing/,
  );
});

test('formal QC rejects an attestation that does not bind the exact receipt', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
      attestationBundlePath: fixture.attestationBundlePath,
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      execFile: () => JSON.stringify([{
        verificationResult: {
          verifiedTimestamps: [{type: 'transparency_log'}],
          statement: {subject: [{digest: {sha256: digest('different receipt')}}]},
        },
      }]),
      root: fixture.root,
      trustedReceiptPath: fixture.trustedReceiptPath,
      worklistPath: fixture.worklistPath,
    }),
    /attestation does not bind the exact receipt bytes/,
  );
});

function createFixture(
  t,
  {modelOwnedTextReview = false, ttsTextReviewed = true, track = 'cet4'} = {},
) {
  const expected = track === 'cet6' ? {cards: 1234, boxes: 110, audio: 328} : {cards: 1180, boxes: 108, audio: 301};
  let attestationCalls = 0;
  let semanticCalls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-qc-drafts-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const cards = [
    card({
      track,
      boxPrefix: track === 'cet6' ? '1000' : '0000',
      cardId: track === 'cet6' ? '100001' : '000001',
      groupId: '0',
      groupName: '听前预测',
      mainTrainingGoal: '根据选项关键词组合预测听力主话题',
      ttsTextReviewed,
      transcript: 'The speaker compares electric buses with diesel fleets.',
    }),
    card({
      track,
      boxPrefix: track === 'cet6' ? '1010' : '0010',
      cardId: track === 'cet6' ? '101001' : '001001',
      groupId: '1',
      groupName: '语音现象',
      mainTrainingGoal: '识别 turn off 中的辅音加元音连读',
      transcript: 'We need to turn off the old server before midnight.',
      ttsTextReviewed,
    }),
  ];
  for (let index = 0; index < expected.cards - 2; index += 1) {
    const audioCandidate = index < expected.audio - 2;
    const boxPrefix = String((track === 'cet6' ? 1000 : 0) + index % expected.boxes).padStart(4, '0');
    const generated = card({
      track,
      boxPrefix,
      cardId: track === 'cet6' ? boxPrefix + String(3 + Math.floor(index / expected.boxes)).padStart(2, '0') : String(100001 + index).padStart(6, '0'),
      groupId: String(index % 9),
      groupName: '完整音频测试',
      mainTrainingGoal: '完整听取并识别训练信号',
      transcript: `Generated trusted media transcript ${index}.`,
      ttsTextReviewed,
    });
    if (!audioCandidate) {
      delete generated.audio;
      generated.quality_metadata.material.audio_generation_method = 'none';
    }
    cards.push(generated);
  }
  const audioCards = cards.filter(card => card.audio);
  assert.equal(cards.length, expected.cards);
  assert.equal(audioCards.length, expected.audio);
  assert.equal(new Set(cards.map(card => card.knowledge_ref.box_prefix)).size, expected.boxes);
  fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
  fs.mkdirSync(path.join(root, 'exports'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/audio_perceptual_worklists'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/agent_self_review'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/approved_batches'), {recursive: true});
  const trustedRunDirectory = path.join(
    root,
    'reviews/trusted_media_runs/current-receipt',
  );
  fs.mkdirSync(trustedRunDirectory, {recursive: true});
  for (const filename of [
    'run-package.json',
    'model-weights-manifest.json',
    'mlx-audio-package-manifest.json',
    'python-environment-manifest.json',
  ]) {
    fs.writeFileSync(
      path.join(trustedRunDirectory, filename),
      `${JSON.stringify({fixture: filename})}\n`,
    );
  }
  fs.writeFileSync(
    path.join(root, `card_boxes_json/${track}.json`),
    `${JSON.stringify({track, cards}, null, 2)}\n`,
  );
  const cet6Card = structuredClone(cards.at(-1));
  cet6Card.card_id = track === 'cet6' ? '000001' : '900001';
  cet6Card.track = track === 'cet6' ? 'cet4' : 'cet6';
  cet6Card.knowledge_ref.box_prefix = '9000';
  fs.writeFileSync(
    path.join(root, `card_boxes_json/${cet6Card.track}.json`),
    `${JSON.stringify({track: cet6Card.track, cards: [cet6Card]}, null, 2)}\n`,
  );
  for (const entry of audioCards) {
    const absolute = path.join(root, entry.audio.path);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    fs.writeFileSync(absolute, Buffer.from(`audio-${entry.card_id}`));
  }
  const audit = {
    schema_version: 'audio-technical-audit.v1',
    generated_at: '2026-08-11T00:00:00.000Z',
    track,
    summary: {errors: 0},
    verification: {},
    errors: [],
    assets: audioCards.map(entry => {
      const bytes = fs.readFileSync(path.join(root, entry.audio.path));
      return {
        asset_path: entry.audio.path,
        card_id: entry.card_id,
        declared_duration_ms: entry.audio.duration_ms,
        duration_delta_ms: 0,
        file_sha256: digest(bytes),
        size_bytes: bytes.length,
        technical: {
          bitrate_bps: 48000,
          channels: 1,
          duration_ms: entry.audio.duration_ms,
          format: 'mp3',
          sample_rate_hz: 24000,
        },
        transcript_sha256: digest(entry.audio.transcript),
      };
    }),
    ok: true,
  };
  const auditPath = path.join(root, 'exports/audit.json');
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (modelOwnedTextReview) writeModelOwnedTextReview(root, cards);
  const {worklist} = buildAudioPerceptualWorklist({
    clock: () => new Date('2026-08-11T01:00:00.000Z'),
    root,
    scopeCardIds: audioCards.map(entry => entry.card_id),
    technicalAudit: audit,
    technicalAuditPath: auditPath,
    track,
  });
  const {authorizationPath} = createCurrentFullTrackAuthorizationFixture({
    root,
    repositoryRoot: path.resolve(import.meta.dirname, '..'),
    cards,
    track,
  });
  fs.writeFileSync(path.join(trustedRunDirectory, 'audio-manifest.json'), JSON.stringify({
    schema_version: 'trusted-media-audio-manifest.v1', track, asset_count: audioCards.length,
    assets: audit.assets.map(({card_id, asset_path, file_sha256, size_bytes}) => ({card_id, asset_path, file_sha256, size_bytes})),
  }) + '\n');
  return {
    track,
    expected,
    attestationBundlePath: 'reviews/trusted_media_receipts/current-bundle.jsonl',
    authorizationPath,
    execFile(command, args) {
      attestationCalls += 1;
      assert.equal(command, 'gh');
      assert.ok(args.includes('--signer-workflow'));
      const receiptBytes = fs.readFileSync(
        path.join(root, 'reviews/trusted_media_receipts/current-receipt.json'),
      );
      return JSON.stringify([{
        verificationResult: {
          verifiedTimestamps: [{type: 'transparency_log'}],
          statement: {subject: [{digest: {sha256: digest(receiptBytes)}}]},
        },
      }]);
    },
    root,
    typeSpecificVerifier({receiptPath}) {
      semanticCalls += 1;
      const receiptBytes = fs.readFileSync(receiptPath);
      const receipt = JSON.parse(receiptBytes);
      return {
        ok: true,
        formal_ready: true,
        receipt_sha256: digest(receiptBytes),
        source_commit_sha: receipt.finalization.commit_sha,
        execution_source_commit_sha: receipt.source.commit_sha,
      };
    },
    trustedReceiptPath: 'reviews/trusted_media_receipts/current-receipt.json',
    verificationCalls: () => ({attestation: attestationCalls, semantic: semanticCalls}),
    worklist,
    worklistPath: 'reviews/audio_perceptual_worklists/pilot.json',
  };
}

function card({
  track = 'cet4',
  boxPrefix,
  cardId,
  groupId,
  groupName,
  mainTrainingGoal,
  transcript,
  ttsTextReviewed = true,
}) {
  return {
    card_id: cardId,
    track,
    interaction_id: 'flip',
    card_group_name: groupName,
    card_box_name: boxPrefix === '0010' ? '连读' : '根据选项预测话题',
    audio: {
      path: `ai_tts/${track}/${boxPrefix}/${cardId}.mp3`,
      duration_ms: 1000,
      transcript,
    },
    knowledge_ref: {
      library_id: '0',
      library_name: '听力',
      group_id: groupId,
      group_name: groupName,
      box_id: '0',
      box_name: boxPrefix === '0010' ? '连读' : '根据选项预测话题',
      box_prefix: boxPrefix,
    },
    quality_metadata: {
      main_training_goal: mainTrainingGoal,
      secondary_training_goals: [],
      weak_point_tags: ['listening_weak'],
      difficulty: {primary: 'pass', secondary: []},
      card_prototype: 'integrated_micro_drill',
      box_progression_role: 'recognition',
      material: {
        text_source_type: 'simulation',
        source_note: 'Test-only simulated CET material.',
        audio_generation_method: 'TTS_AI_generated',
        tts_text_reviewed: ttsTextReviewed,
        tts_audio_reviewed: false,
      },
      exam_value: 'Test-only listening transfer value.',
      review_status: 'draft',
    },
  };
}

function writeModelOwnedTextReview(root, cards) {
  const cardIds = cards.map(card => card.card_id);
  const audit = {
    schema_version: 'card-quality-scoped-audit.v1',
    scope_summary: {
      card_ids: cardIds,
      card_count: cardIds.length,
      issue_count: 0,
      by_severity: {
        hard_blocker: 0,
        content_risk: 0,
        review_gap: 0,
        source_risk: 0,
      },
      by_rule: {},
    },
  };
  const auditRelative = 'reviews/audit_scopes/current-text-audit.json';
  const auditBytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'reviews/audit_scopes'), {recursive: true});
  fs.writeFileSync(path.join(root, auditRelative), auditBytes);
  const inputSha256 = `sha256:${digest('current-model-text-review')}`;
  const review = {
    schema_version: 'model-owned-full-track-review.v2',
    review_id: 'current-model-text-review',
    created_at: '2026-08-27T00:00:00.000Z',
    model_acceptances: [
      semanticAcceptance(inputSha256, 'text-review:first'),
      semanticAcceptance(inputSha256, 'text-review:second'),
    ],
    scope: {
      track: 'cet4',
      box_prefixes: [...new Set(cards.map(card => card.knowledge_ref.box_prefix))],
      card_ids: cardIds,
    },
    quality_audit: {
      report: auditRelative,
      report_sha256: `sha256:${digest(auditBytes)}`,
      corpus_fingerprint: digest('fixture-corpus'),
      scope_has_no_hard_blockers: true,
      scope_summary: audit.scope_summary,
    },
    batch_review: {
      status: 'ready_for_model_authorization',
      summary: 'Current model-owned text review passed.',
      remaining_risks: [],
      next_step: 'Build audio QC.',
    },
  };
  fs.writeFileSync(
    path.join(root, 'reviews/agent_self_review/current-full-track.json'),
    `${JSON.stringify(review, null, 2)}\n`,
  );
}

function semanticAcceptance(inputSha256, runId) {
  const acceptance = modelAcceptance(inputSha256, runId);
  acceptance.evidence.capabilities = [
    'card_semantic_review',
    'source_provenance_review',
  ];
  return acceptance;
}

function completeWorklist(worklist) {
  return worklist.entries.reduce(
    (current, entry) => reviewAll(current, entry.card_id),
    worklist,
  );
}

function reviewAll(worklist, cardId) {
  const entry = worklist.entries.find(candidate => candidate.card_id === cardId);
  const checks = Object.fromEntries(PERCEPTUAL_CHECKS.map(name => [name, 'pass']));
  const inputSha256 = audioPerceptualDecisionInputSha256(entry, checks);
  return reviewAudioPerceptualEntry({
    cardId,
    checkUpdates: PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'})),
    clock: () => new Date(`2026-08-11T02:0${cardId === '000001' ? '1' : '2'}:00.000Z`),
    completeAssetConsumed: true,
    modelAcceptances: [
      modelAcceptance(inputSha256, `entry:${cardId}:first`),
      modelAcceptance(inputSha256, `entry:${cardId}:second`),
    ],
    worklist,
  });
}

function modelAcceptance(inputSha256, runId) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'agent:codex',
      model: 'audio-capable-model',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-08-11T02:00:00.000Z',
      input_sha256: inputSha256,
      capabilities: ['audio_perceptual_review'],
      summary: 'Exact audio input and all perceptual checks passed.',
      findings: [],
    },
    decision: 'accepted',
  };
}

function contentAcceptance(inputSha256, runId) {
  const acceptance = modelAcceptance(inputSha256, runId);
  acceptance.evidence.capabilities = ['content_authorization'];
  return acceptance;
}

function writeWorklist(fixture, worklist) {
  const worklistBytes = Buffer.from(
    `${JSON.stringify(worklist, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(fixture.root, fixture.worklistPath),
    worklistBytes,
  );
  const authorizationBytes = fs.readFileSync(
    path.join(fixture.root, fixture.authorizationPath),
  );
  const authorization = JSON.parse(authorizationBytes);
  const receipt = {
    schema_version: 'trusted-media-run-receipt.v2',
    source: {
      repository: 'LENKIN233/card-make',
      ref: 'refs/heads/main',
      workflow_path: '.github/workflows/trusted-media-run.yml',
      commit_sha: 'a'.repeat(40),
    },
    finalization: {
      repository: 'LENKIN233/card-make',
      ref: 'refs/heads/main',
      workflow_path: '.github/workflows/trusted-media-run.yml',
      commit_sha: 'c'.repeat(40),
      retained_raw_artifact: {
        workflow_run_id: '32939841276',
        workflow_run_attempt: 1,
        artifact_name: 'trusted-media-raw-32939841276-1',
      },
    },
    execution: {
      workflow_run_id: '32939841276',
      workflow_run_attempt: 1,
      model: {
        id: 'mlx-community/Qwen2-Audio-7B-Instruct-4bit',
        revision: 'b'.repeat(40),
      },
    },
    candidate: {
      track: fixture.track,
      card_count: fixture.expected.cards,
      box_count: fixture.expected.boxes,
      audio_asset_count: fixture.expected.audio,
      content_version: authorization.content_version,
      content_authorization_sha256: digest(authorizationBytes),
    },
    artifacts: {
      review_worklist: {
        sha256: digest(worklistBytes),
        size_bytes: worklistBytes.length,
      },
    },
    result: {
      reviewed_card_count: fixture.expected.audio,
      passed_card_count: fixture.expected.audio,
      failed_card_count: 0,
      every_card_has_two_independent_acceptances: true,
      all_assets_complete_consumed: true,
      all_required_checks_passed: true,
    },
  };
  const receiptDirectory = path.join(
    fixture.root,
    'reviews/trusted_media_receipts',
  );
  fs.mkdirSync(receiptDirectory, {recursive: true});
  fs.writeFileSync(
    path.join(fixture.root, fixture.trustedReceiptPath),
    `${JSON.stringify(receipt)}\n`,
  );
  fs.writeFileSync(
    path.join(fixture.root, fixture.attestationBundlePath),
    '{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.3"}\n',
  );
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function commitFixture(fixture) {
  const env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Audio QC Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Audio QC Test',
  };
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    ['commit', '-q', '-m', 'fixture'],
  ]) {
    execGit(fixture.root, args, env);
  }
}

function execGit(cwd, args, env) {
  execFileSync('git', args, {cwd, env, stdio: 'ignore'});
}
