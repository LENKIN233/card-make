import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditAudioTechnical,
  countTranscriptWords,
  parseAfinfo,
  parseFfmpegVolumeDetect,
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

test('parses coarse ffmpeg signal output and counts transcript words', () => {
  assert.deepEqual(
    parseFfmpegVolumeDetect(
      '[Parsed_volumedetect_0] mean_volume: -21.8 dB\n[Parsed_volumedetect_0] max_volume: -7.7 dB\n',
    ),
    {mean_volume_db: -21.8, peak_volume_db: -7.7},
  );
  assert.equal(countTranscriptWords("It's a listening-speed check, not formal QC."), 7);
  assert.throws(() => parseFfmpegVolumeDetect('incomplete'), /incomplete/);
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
    assert.equal(report.verification.coarse_signal_diagnostics, 'not_run_requires_ffmpeg');
    assert.equal(report.verification.formal_audio_qc_records_created, 0);
    assert.match(report.assets[0].transcript_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('coarse signal diagnostics reject track-level and transcript-speed outliers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-signal-outlier-'));
  try {
    fs.mkdirSync(path.join(root, 'card_boxes_json'), {recursive: true});
    fs.mkdirSync(path.join(root, 'ai_tts', 'cet4'), {recursive: true});
    const cards = [];
    const files = [];
    for (let index = 1; index <= 3; index += 1) {
      const cardId = `00000${index}`;
      const assetPath = `ai_tts/cet4/${cardId}.mp3`;
      const bytes = Buffer.from(`signal-${index}`);
      fs.writeFileSync(path.join(root, assetPath), bytes);
      cards.push({
        card_id: cardId,
        audio: {
          path: assetPath,
          duration_ms: index === 3 ? 3000 : 6000,
          transcript:
            index === 3
              ? 'One two three four five six seven eight nine ten eleven twelve.'
              : 'One two three four five six seven eight nine ten.',
        },
      });
      files.push({
        path: assetPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size_bytes: bytes.byteLength,
      });
    }
    fs.writeFileSync(
      path.join(root, 'card_boxes_json', 'three.json'),
      JSON.stringify({track: 'cet4', cards}),
    );
    fs.writeFileSync(
      path.join(root, 'ai_tts', 'audio-lfs-manifest.json'),
      JSON.stringify({files}),
    );

    const report = auditAudioTechnical({
      probe: assetPath => ({
        bitrate_bps: 48000,
        channels: 1,
        duration_ms: assetPath.includes('000003') ? 3000 : 6000,
        format: 'mp3',
        sample_rate_hz: 24000,
      }),
      root,
      signalProbe: assetPath => ({
        mean_volume_db: assetPath.includes('000003') ? -35 : -21,
        peak_volume_db: assetPath.includes('000003') ? 0 : -3,
      }),
      track: 'cet4',
    });

    assert.equal(report.ok, false);
    assert.equal(report.verification.coarse_signal_diagnostics, 'failed');
    assert.deepEqual(
      report.errors.map(entry => entry.code).sort(),
      [
        'audio_estimated_speech_rate_out_of_range',
        'audio_mean_level_out_of_range',
        'audio_peak_level_clipping_risk',
        'audio_track_level_outlier',
      ],
    );
    assert.equal(report.summary.coarse_signal_diagnostics.assets, 3);
    assert.equal(report.summary.coarse_signal_diagnostics.mean_volume_db.median, -21);
    assert.equal(report.assets[2].signal.estimated_transcript_wpm, 240);
    assert.equal(report.assets[2].signal.track_mean_volume_deviation_db, 14);
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
