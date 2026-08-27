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

const ATTESTATIONS = Object.freeze({
  no_autoplay_assumption: true,
  front_side_no_required_subtitles: true,
  tts_audio_not_used_as_source_authenticity: true,
});

test('builds one formal-ready model-owned QC record per box after complete model review', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);

  const result = buildAudioQcDrafts({
    attestations: ATTESTATIONS,
    clock: () => new Date('2026-08-12T08:00:00.000Z'),
    contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });

  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map(record => record.scope.box_prefixes[0]), ['0000', '0010']);
  assert.equal(result.summary.card_count, 2);
  assert.equal(result.summary.formal_content_approval_created, false);
  assert.equal(result.summary.linked_content_authorization, fixture.authorizationPath);
  assert.match(result.summary.linked_content_authorization_sha256, /^[a-f0-9]{64}$/);
  for (const record of result.records) {
    assert.equal(record.verdict.formal_audio_ready, true);
    assert.equal(record.schema_version, 'model-owned-audio-qc.v2');
    assert.equal(record.model_acceptances.length, 2);
    assert.deepEqual(
      record.model_acceptances.map(acceptance => acceptance.actor.agent),
      ['audio-evidence-aggregate-lane-1', 'audio-evidence-aggregate-lane-2'],
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
  }
  assert.equal(
    result.records.find(record => record.scope.box_prefixes[0] === '0010')
      .text_gate.transcripts[0].target_signal,
    '识别 turn off 中的辅音加元音连读',
  );
});

test('fails closed while any perceptual entry is pending', t => {
  const fixture = createFixture(t);
  writeWorklist(fixture, fixture.worklist);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
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
    () => buildAudioQcDrafts({
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
  const result = buildAudioQcDrafts({
    attestations: ATTESTATIONS,
    contentAuthorizationPath: fixture.authorizationPath,
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every(record =>
    record.text_gate.tts_text_reviewed === true &&
    record.source_records.linked_agent_self_reviews.includes(
      'reviews/agent_self_review/current-full-track.json',
    )));
});

test('missing legacy flag and missing current model-owned review still fail closed', t => {
  const fixture = createFixture(t, {ttsTextReviewed: false});
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
    /passed TTS text review gate or current model-owned semantic review/,
  );
});

test('rejects duplicate per-card evidence lanes before aggregation', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  reviewed.entries[0].review.model_acceptances[1] =
    reviewed.entries[0].review.model_acceptances[0];
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
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
    () => buildAudioQcDrafts({
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /does not cover the audio scope/,
  );
});

test('refuses an untracked or dirty reviewed worklist', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist);
  writeWorklist(fixture, reviewed);
  assert.throws(
    () => buildAudioQcDrafts({
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
    () => buildAudioQcDrafts({
      attestations: ATTESTATIONS,
      contentAuthorizationPath: fixture.authorizationPath,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /exactly match the tracked HEAD artifact/,
  );
});

function createFixture(
  t,
  {modelOwnedTextReview = false, sameBox = false, ttsTextReviewed = true} = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-qc-drafts-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const cards = [
    card({
      boxPrefix: '0000',
      cardId: '000001',
      groupId: '0',
      groupName: '听前预测',
      mainTrainingGoal: '根据选项关键词组合预测听力主话题',
      ttsTextReviewed,
      transcript: 'The speaker compares electric buses with diesel fleets.',
    }),
    sameBox
      ? card({
          boxPrefix: '0000',
          cardId: '000002',
          groupId: '0',
          groupName: '听前预测',
          mainTrainingGoal: '根据选项关键词组合预测听力主话题',
          transcript: 'The speaker introduces a second comparison topic.',
          ttsTextReviewed,
        })
      : card({
          boxPrefix: '0010',
          cardId: '001001',
          groupId: '1',
          groupName: '语音现象',
          mainTrainingGoal: '识别 turn off 中的辅音加元音连读',
          transcript: 'We need to turn off the old server before midnight.',
          ttsTextReviewed,
        }),
  ];
  fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
  fs.mkdirSync(path.join(root, 'exports'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/audio_perceptual_worklists'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/agent_self_review'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/approved_batches'), {recursive: true});
  fs.writeFileSync(
    path.join(root, 'card_boxes_json/cet4.json'),
    `${JSON.stringify({track: 'cet4', cards}, null, 2)}\n`,
  );
  for (const entry of cards) {
    const absolute = path.join(root, entry.audio.path);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    fs.writeFileSync(absolute, Buffer.from(`audio-${entry.card_id}`));
    fs.writeFileSync(
      path.join(root, `reviews/agent_self_review/${entry.card_id}.json`),
      `${JSON.stringify({
        review_id: `review-${entry.card_id}`,
        created_at: '2026-08-11T00:00:00.000Z',
        scope: {card_ids: [entry.card_id]},
      }, null, 2)}\n`,
    );
  }
  const audit = {
    schema_version: 'audio-technical-audit.v1',
    generated_at: '2026-08-11T00:00:00.000Z',
    track: 'cet4',
    summary: {errors: 0},
    verification: {},
    errors: [],
    assets: cards.map(entry => {
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
    scopeCardIds: cards.map(entry => entry.card_id),
    technicalAudit: audit,
    technicalAuditPath: auditPath,
    track: 'cet4',
  });
  const authorizationPath = 'reviews/approved_batches/current.json';
  const authorizationInput = `sha256:${digest('fixture-content-authorization')}`;
  fs.writeFileSync(
    path.join(root, authorizationPath),
    `${JSON.stringify({
      schema_version: 'model-owned-content-authorization.v2',
      authorization_mode: 'full_track',
      model_acceptances: [
        contentAcceptance(authorizationInput, 'content:first'),
        contentAcceptance(authorizationInput, 'content:second'),
      ],
      scope: {
        track: 'cet4',
        purpose: 'formal_content',
        card_ids: cards.map(card => card.card_id),
      },
      card_quality_audit: {
        scope_has_no_hard_blockers: true,
        scope_summary: {
          by_severity: {hard_blocker: 0, content_risk: 0, review_gap: 0},
        },
      },
    }, null, 2)}\n`,
  );
  return {
    authorizationPath,
    root,
    worklist,
    worklistPath: 'reviews/audio_perceptual_worklists/pilot.json',
  };
}

function card({
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
    card_group_name: groupName,
    card_box_name: boxPrefix === '0010' ? '连读' : '根据选项预测话题',
    audio: {
      path: `ai_tts/cet4/${boxPrefix}/${cardId}.mp3`,
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
      box_progression_role: 'recognition',
      material: {
        text_source_type: 'simulation',
        audio_generation_method: 'TTS_AI_generated',
        tts_text_reviewed: ttsTextReviewed,
      },
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
    created_at: '2026-08-12T00:00:00.000Z',
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
      agent: 'codex',
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
  fs.writeFileSync(
    path.join(fixture.root, fixture.worklistPath),
    `${JSON.stringify(worklist, null, 2)}\n`,
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
