#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateAudioAcceptanceInput,
  validateAudioQcRecord,
} from './validate_audio_qc.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('model audio input binds exact bytes, transcript, and scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardmake-audio-model-input-'));
  try {
    const relative = 'ai_tts/cet4/0000/000001.mp3';
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    const bytes = Buffer.from('exact-audio-bytes');
    const transcript = 'Exact transcript.';
    fs.writeFileSync(absolute, bytes);
    const record = {
      scope: {card_ids: ['000001']},
      source_records: trustedSourceRecords(),
      text_gate: {transcripts: [{card_id: '000001', transcript}]},
      generated_assets: [{
        card_id: '000001',
        path: relative,
        file_sha256: digest(bytes),
        transcript_sha256: digest(Buffer.from(transcript, 'utf8')),
      }],
      per_card_qc: [perCardPass('000001', relative)],
    };
    const valid = validateAudioAcceptanceInput(record, {root});
    assert.deepEqual(valid.issues, []);
    assert.match(valid.input_sha256, /^sha256:[a-f0-9]{64}$/);
    const changedDecision = structuredClone(record);
    changedDecision.per_card_qc[0].no_noise = false;
    assert.notEqual(
      validateAudioAcceptanceInput(changedDecision, {root}).input_sha256,
      valid.input_sha256,
    );

    fs.writeFileSync(absolute, Buffer.from('changed-audio-bytes'));
    const changed = validateAudioAcceptanceInput(record, {root});
    assert.ok(changed.issues.some(issue => issue.code === 'audio_qc_asset_hash_mismatch'));
    assert.notEqual(changed.input_sha256, valid.input_sha256);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('model audio input rejects transcript and scope drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardmake-audio-model-scope-'));
  try {
    const relative = 'ai_tts/cet4/0000/000001.mp3';
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    fs.writeFileSync(absolute, Buffer.from('audio'));
    const result = validateAudioAcceptanceInput({
      scope: {card_ids: ['000001', '000002']},
      source_records: trustedSourceRecords(),
      text_gate: {transcripts: [{card_id: '000001', transcript: 'Changed'}]},
      generated_assets: [{
        card_id: '000001',
        path: relative,
        file_sha256: digest(Buffer.from('audio')),
        transcript_sha256: digest(Buffer.from('Different')),
      }],
      per_card_qc: [perCardPass('000001', relative)],
    }, {root});
    assert.ok(result.issues.some(issue => issue.code === 'audio_qc_transcript_hash_mismatch'));
    assert.ok(result.issues.some(issue =>
      issue.code === 'audio_qc_scope_asset_transcript_coverage_mismatch'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('model audio input rejects a symbolic-link asset', t => {
  if (process.platform === 'win32') return t.skip('symbolic-link fixture is POSIX-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardmake-audio-model-link-'));
  const outside = path.join(os.tmpdir(), `cardmake-audio-outside-${process.pid}.mp3`);
  try {
    fs.writeFileSync(outside, Buffer.from('outside'));
    const relative = 'ai_tts/cet4/0000/000001.mp3';
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    fs.symlinkSync(outside, absolute);
    const transcript = 'Exact transcript.';
    const result = validateAudioAcceptanceInput({
      scope: {card_ids: ['000001']},
      source_records: trustedSourceRecords(),
      text_gate: {transcripts: [{card_id: '000001', transcript}]},
      generated_assets: [{
        card_id: '000001',
        path: relative,
        file_sha256: digest(Buffer.from('outside')),
        transcript_sha256: digest(Buffer.from(transcript)),
      }],
      per_card_qc: [perCardPass('000001', relative)],
    }, {root});
    assert.ok(result.issues.some(issue => issue.code === 'audio_qc_asset_not_regular_file'));
  } finally {
    fs.rmSync(outside, {force: true});
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('model-owned audio records reject legacy person-authority fields', () => {
  const record = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'reviews/audio_qc/TEMPLATE.json'),
    'utf8',
  ));
  record.approved_by_user = true;
  const issues = validateAudioQcRecord(record, {template: true});
  assert.ok(issues.some(
    issue => issue.code === 'audio_qc_person_authority_field_forbidden',
  ));
});

function perCardPass(cardId, assetPath) {
  return {
    card_id: cardId,
    asset_path: assetPath,
    complete_asset_consumed: true,
    matches_text: true,
    target_signal: true,
    pronunciation: true,
    speed: true,
    rhythm: true,
    stress_pauses: true,
    no_noise: true,
    notes: 'fixture pass',
  };
}

function trustedSourceRecords() {
  return {
    trusted_media_receipt: 'reviews/trusted_media_receipts/fixture.json',
    trusted_media_receipt_sha256: digest('receipt'),
    trusted_media_attestation_bundle:
      'reviews/trusted_media_receipts/fixture-bundle.jsonl',
    trusted_media_attestation_bundle_sha256: digest('bundle'),
    trusted_media_source_commit: 'a'.repeat(40),
    trusted_media_model_id: 'mlx-community/Qwen2-Audio-7B-Instruct-4bit',
    trusted_media_model_revision: 'b'.repeat(40),
  };
}
