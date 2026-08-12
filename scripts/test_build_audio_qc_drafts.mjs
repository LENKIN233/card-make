import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {buildAudioQcDrafts} from './build_audio_qc_drafts.mjs';
import {
  buildAudioPerceptualWorklist,
  PERCEPTUAL_CHECKS,
  reviewAudioPerceptualEntry,
} from './manage_audio_perceptual_worklist.mjs';

const ATTESTATIONS = Object.freeze({
  no_autoplay_assumption: true,
  front_side_no_required_subtitles: true,
  tts_audio_not_used_as_source_authenticity: true,
});

test('builds one formal-ready legacy QC record per box after complete human review', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist, 'github:human-reviewer');
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);

  const result = buildAudioQcDrafts({
    attestations: ATTESTATIONS,
    clock: () => new Date('2026-08-12T08:00:00.000Z'),
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });

  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map(record => record.scope.box_prefixes[0]), ['0000', '0010']);
  assert.equal(result.summary.card_count, 2);
  assert.equal(result.summary.formal_content_approval_created, false);
  for (const record of result.records) {
    assert.equal(record.verdict.formal_audio_ready, true);
    assert.equal(record.legacy_adoption.reviewer, 'github:human-reviewer');
    assert.equal(record.generation_plan.provider, 'legacy_unknown');
    assert.equal(record.source_records.linked_approved_batch, '');
    assert.equal(record.source_records.linked_agent_self_reviews.length, 1);
    assert.equal(record.generated_assets[0].file_sha256.length, 64);
    assert.equal(record.qa_checks.tts_audio_not_used_as_source_authenticity, true);
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
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /worklist is not complete/,
  );
});

test('requires all three product-semantics attestations', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist, 'team:audio-reviewer');
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
      attestations: {
        no_autoplay_assumption: true,
        front_side_no_required_subtitles: true,
      },
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /tts_audio_not_used_as_source_authenticity attestation is required/,
  );
});

test('permits different reviewers across boxes but not within one box record', t => {
  const fixture = createFixture(t);
  let reviewed = reviewAll(fixture.worklist, '000001', 'github:first-human');
  reviewed = reviewAll(reviewed, '001001', 'external:second-human');
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  const result = buildAudioQcDrafts({
    attestations: ATTESTATIONS,
    root: fixture.root,
    worklistPath: fixture.worklistPath,
  });
  assert.deepEqual(result.summary.reviewers, [
    'external:second-human',
    'github:first-human',
  ]);
});

test('refuses different reviewers inside one box QC record', t => {
  const fixture = createFixture(t, {sameBox: true});
  let reviewed = reviewAll(fixture.worklist, '000001', 'github:first-human');
  reviewed = reviewAll(reviewed, '000002', 'external:second-human');
  writeWorklist(fixture, reviewed);
  commitFixture(fixture);
  assert.throws(
    () => buildAudioQcDrafts({
      attestations: ATTESTATIONS,
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /same human reviewer/,
  );
});

test('refuses an untracked or dirty reviewed worklist', t => {
  const fixture = createFixture(t);
  const reviewed = completeWorklist(fixture.worklist, 'github:human-reviewer');
  writeWorklist(fixture, reviewed);
  assert.throws(
    () => buildAudioQcDrafts({
      attestations: ATTESTATIONS,
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
      root: fixture.root,
      worklistPath: fixture.worklistPath,
    }),
    /exactly match the tracked HEAD artifact/,
  );
});

function createFixture(t, {sameBox = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-qc-drafts-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const cards = [
    card({
      boxPrefix: '0000',
      cardId: '000001',
      groupId: '0',
      groupName: '听前预测',
      mainTrainingGoal: '根据选项关键词组合预测听力主话题',
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
        })
      : card({
          boxPrefix: '0010',
          cardId: '001001',
          groupId: '1',
          groupName: '语音现象',
          mainTrainingGoal: '识别 turn off 中的辅音加元音连读',
          transcript: 'We need to turn off the old server before midnight.',
        }),
  ];
  fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
  fs.mkdirSync(path.join(root, 'exports'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/audio_perceptual_worklists'), {recursive: true});
  fs.mkdirSync(path.join(root, 'reviews/agent_self_review'), {recursive: true});
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
  const {worklist} = buildAudioPerceptualWorklist({
    clock: () => new Date('2026-08-11T01:00:00.000Z'),
    root,
    scopeCardIds: cards.map(entry => entry.card_id),
    technicalAudit: audit,
    technicalAuditPath: auditPath,
    track: 'cet4',
  });
  return {
    root,
    worklist,
    worklistPath: 'reviews/audio_perceptual_worklists/pilot.json',
  };
}

function card({boxPrefix, cardId, groupId, groupName, mainTrainingGoal, transcript}) {
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
        tts_text_reviewed: true,
      },
    },
  };
}

function completeWorklist(worklist, reviewer) {
  return worklist.entries.reduce(
    (current, entry) => reviewAll(current, entry.card_id, reviewer),
    worklist,
  );
}

function reviewAll(worklist, cardId, reviewer) {
  return reviewAudioPerceptualEntry({
    cardId,
    checkUpdates: PERCEPTUAL_CHECKS.map(name => ({name, value: 'pass'})),
    clock: () => new Date(`2026-08-11T02:0${cardId === '000001' ? '1' : '2'}:00.000Z`),
    listenedToEntireAsset: true,
    reviewer,
    worklist,
  });
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
