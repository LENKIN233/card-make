#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {buildAudioPerceptualWorklist, PERCEPTUAL_CHECKS} from './manage_audio_perceptual_worklist.mjs';
import {
  applyReviewSubmission,
  createAudioPerceptualReviewStation,
  parseReviewStationArguments,
} from './serve_audio_perceptual_review.mjs';

test('review station requires one explicit worklist and a safe port', () => {
  assert.deepEqual(parseReviewStationArguments(['--file', 'exports/pilot.json']), {
    file: 'exports/pilot.json',
    port: 4179,
  });
  assert.deepEqual(
    parseReviewStationArguments(['--file', 'exports/pilot.json', '--port', '4310']),
    {file: 'exports/pilot.json', port: 4310},
  );
  assert.throws(() => parseReviewStationArguments([]), /--file is required/);
  assert.throws(
    () => parseReviewStationArguments(['--file', 'exports/pilot.json', '--port', '80']),
    /1024 to 65535/,
  );
});

test('submission can complete only the current card with a human identity and all checks', t => {
  const fixture = createFixture(t);
  const passing = submission(fixture.worklist.entries[0].card_id);
  const updated = applyReviewSubmission({
    submission: passing,
    technicalAudit: fixture.audit,
    worklist: fixture.worklist,
    root: fixture.root,
  });
  assert.equal(updated.entries[0].review.status, 'passed');
  assert.equal(updated.entries[1].review.status, 'pending');
  assert.equal(updated.progress.passed, 1);

  assert.throws(
    () => applyReviewSubmission({
      submission: {...passing, card_id: fixture.worklist.entries[1].card_id},
      technicalAudit: fixture.audit,
      worklist: fixture.worklist,
      root: fixture.root,
    }),
    /当前显示的一条/,
  );
  assert.throws(
    () => applyReviewSubmission({
      submission: {...passing, reviewer: 'team:codex-agent'},
      technicalAudit: fixture.audit,
      worklist: fixture.worklist,
      root: fixture.root,
    }),
    /identify a human/,
  );
  assert.throws(
    () => applyReviewSubmission({
      submission: {...passing, listened_to_entire_asset: false},
      technicalAudit: fixture.audit,
      worklist: fixture.worklist,
      root: fixture.root,
    }),
    /完整播放/,
  );
  const incomplete = structuredClone(passing);
  delete incomplete.checks.natural_rhythm;
  assert.throws(
    () => applyReviewSubmission({
      submission: incomplete,
      technicalAudit: fixture.audit,
      worklist: fixture.worklist,
      root: fixture.root,
    }),
    /七项听感检查必须完整/,
  );
});

test('failed submission needs notes and becomes a replacement result', t => {
  const fixture = createFixture(t);
  const failed = submission(fixture.worklist.entries[0].card_id);
  failed.checks.accurate_pronunciation = 'fail';
  assert.throws(
    () => applyReviewSubmission({
      submission: failed,
      technicalAudit: fixture.audit,
      worklist: fixture.worklist,
      root: fixture.root,
    }),
    /requires notes/,
  );
  failed.notes = 'The final consonant is pronounced incorrectly.';
  const updated = applyReviewSubmission({
    submission: failed,
    technicalAudit: fixture.audit,
    worklist: fixture.worklist,
    root: fixture.root,
  });
  assert.equal(updated.entries[0].review.status, 'failed');
  assert.equal(updated.entries[0].review.replacement_required, true);
  assert.deepEqual(updated.entries[0].review.failure_codes, ['pronunciation_error']);
});

test('loopback server exposes only the current queue entry and its bound audio', async t => {
  const fixture = createFixture(t);
  const server = createAudioPerceptualReviewStation({
    root: fixture.root,
    worklistPath: 'exports/pilot.json',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const stateResponse = await fetch(`${base}/api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.current.card_id, fixture.worklist.entries[0].card_id);
  assert.equal('asset_path' in state.current, false);

  const audioResponse = await fetch(`${base}${state.current.audio_url}`, {
    headers: {Range: 'bytes=0-3'},
  });
  assert.equal(audioResponse.status, 206);
  assert.equal(audioResponse.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await audioResponse.arrayBuffer()).toString(), 'fake');

  const pageResponse = await fetch(base);
  const page = await pageResponse.text();
  assert.match(page, /逐条听，逐条确认/);
  assert.match(page, /没有批量通过|不提供批量通过/);
  assert.match(page, /skippedAhead/);
  assert.match(pageResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

function submission(cardId) {
  return {
    card_id: cardId,
    reviewer: 'external:human-listener',
    listened_to_entire_asset: true,
    checks: Object.fromEntries(PERCEPTUAL_CHECKS.map(name => [name, 'pass'])),
    notes: '',
  };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-review-station-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
  fs.mkdirSync(path.join(root, 'ai_tts/cet4/0000'), {recursive: true});
  fs.mkdirSync(path.join(root, 'exports'), {recursive: true});

  const transcripts = [
    'The students can link it up after class.',
    'However, the second speaker changes direction.',
  ];
  const cards = transcripts.map((transcript, index) => {
    const cardId = `00000${index + 1}`;
    const assetPath = `ai_tts/cet4/0000/${cardId}.mp3`;
    fs.writeFileSync(path.join(root, assetPath), Buffer.from(`fake-mp3-${index + 1}`));
    return {
      card_id: cardId,
      card_group_name: '语音现象',
      card_box_name: '连读',
      audio: {path: assetPath, duration_ms: 1000, transcript},
      knowledge_ref: {
        library_id: '0', library_name: '听力', group_id: '1', group_name: '语音现象',
        box_id: '0', box_name: '连读', box_prefix: '0000',
      },
      quality_metadata: {main_training_goal: '识别连读', box_progression_role: 'recognition'},
    };
  });
  fs.writeFileSync(
    path.join(root, 'card_boxes_json/cet4.json'),
    `${JSON.stringify({track: 'cet4', cards}, null, 2)}\n`,
  );
  const assets = cards.map(card => {
    const bytes = fs.readFileSync(path.join(root, card.audio.path));
    return {
      asset_path: card.audio.path,
      card_id: card.card_id,
      declared_duration_ms: 1000,
      duration_delta_ms: 0,
      file_sha256: digest(bytes),
      size_bytes: bytes.length,
      technical: {bitrate_bps: 48000, channels: 1, duration_ms: 1000, format: 'mp3', sample_rate_hz: 24000},
      transcript_sha256: digest(card.audio.transcript),
    };
  });
  const audit = {
    schema_version: 'audio-technical-audit.v1', generated_at: '2026-08-12T00:00:00.000Z',
    track: 'cet4', summary: {errors: 0}, verification: {}, errors: [], assets, ok: true,
  };
  const auditPath = path.join(root, 'exports/audit.json');
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  const worklist = buildAudioPerceptualWorklist({
    root,
    technicalAudit: audit,
    technicalAuditPath: auditPath,
    track: 'cet4',
  }).worklist;
  fs.writeFileSync(path.join(root, 'exports/pilot.json'), `${JSON.stringify(worklist, null, 2)}\n`);
  return {audit, root, worklist};
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
