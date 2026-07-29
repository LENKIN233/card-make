import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditAudioTechnical,
  parseAfinfo,
  parseFfprobe,
} from './audit_audio_technical.mjs';

test('parses afinfo and ffprobe audio metadata', () => {
  assert.deepEqual(
    parseAfinfo(`Data format:     1 ch,  24000 Hz, .mp3\nestimated duration: 7.608000 sec\nbit rate: 48000 bits per second\n`),
    {
      bitrate_bps: 48000,
      channels: 1,
      duration_ms: 7608,
      format: 'mp3',
      sample_rate_hz: 24000,
    },
  );
  assert.deepEqual(
    parseFfprobe(
      JSON.stringify({
        streams: [
          {
            bit_rate: '48000',
            channels: 1,
            codec_name: 'mp3',
            codec_type: 'audio',
            duration: '7.608',
            sample_rate: '24000',
          },
        ],
      }),
    ),
    {
      bitrate_bps: 48000,
      channels: 1,
      duration_ms: 7608,
      format: 'mp3',
      sample_rate_hz: 24000,
    },
  );
});

test('technical audit binds one referenced transcript to exact asset bytes without claiming QC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-technical-audit-'));
  try {
    fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
    fs.mkdirSync(path.join(root, 'ai_tts', 'cet4', '0000'), {recursive: true});
    const assetPath = 'ai_tts/cet4/0000/000001.mp3';
    const bytes = Buffer.from('test-mp3-bytes');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, assetPath), bytes);
    fs.writeFileSync(
      path.join(root, 'card_boxes_json', 'one.json'),
      JSON.stringify({
        track: 'cet4',
        cards: [
          {
            card_id: '000001',
            audio: {
              path: assetPath,
              duration_ms: 7608,
              transcript: 'A reviewed transcript binding.',
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(root, 'ai_tts', 'audio-lfs-manifest.json'),
      JSON.stringify({
        files: [{path: assetPath, sha256: digest, size_bytes: bytes.byteLength}],
      }),
    );

    const report = auditAudioTechnical({
      probe: () => ({
        bitrate_bps: 48000,
        channels: 1,
        duration_ms: 7608,
        format: 'mp3',
        sample_rate_hz: 24000,
      }),
      root,
      track: 'cet4',
    });

    assert.equal(report.ok, true);
    assert.equal(report.summary.technically_verified_assets, 1);
    assert.equal(report.verification.speech_to_transcript_match, 'not_verified_requires_listening_or_independent_ASR_review');
    assert.equal(report.verification.formal_audio_qc_records_created, 0);
    assert.match(report.assets[0].transcript_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('technical audit fails when declared duration drifts from the decoded file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-duration-drift-'));
  try {
    fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
    fs.mkdirSync(path.join(root, 'ai_tts', 'cet4'), {recursive: true});
    const assetPath = 'ai_tts/cet4/drift.mp3';
    const bytes = Buffer.from('drift');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, assetPath), bytes);
    fs.writeFileSync(
      path.join(root, 'card_boxes_json', 'one.json'),
      JSON.stringify({
        track: 'cet4',
        cards: [
          {
            card_id: 'drift',
            audio: {path: assetPath, duration_ms: 7000, transcript: 'Transcript.'},
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(root, 'ai_tts', 'audio-lfs-manifest.json'),
      JSON.stringify({files: [{path: assetPath, sha256: digest, size_bytes: bytes.byteLength}]}),
    );

    const report = auditAudioTechnical({
      probe: () => ({
        bitrate_bps: 48000,
        channels: 1,
        duration_ms: 7608,
        format: 'mp3',
        sample_rate_hz: 24000,
      }),
      root,
      track: 'cet4',
    });
    assert.equal(report.ok, false);
    assert.equal(report.errors[0].code, 'audio_duration_mismatch');
    assert.equal(report.verification.file_hash_and_size, 'passed');
    assert.equal(report.verification.declared_duration_binding, 'failed');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
