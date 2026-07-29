#!/usr/bin/env node

import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DURATION_TOLERANCE_MS = 50;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function requireTrack(value) {
  if (!['cet4', 'cet6'].includes(value)) throw new Error('--track must be cet4 or cet6');
  return value;
}

function collectAudioCards(root, track) {
  const directory = path.join(root, 'card_boxes_json');
  const cards = [];
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const document = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (document.track !== track) continue;
    for (const card of document.cards || []) {
      const assetPath = card.audio?.path || card.audio?.url;
      if (!assetPath) continue;
      cards.push({
        asset_path: assetPath,
        card_id: String(card.card_id),
        declared_duration_ms: Number(card.audio.duration_ms),
        transcript: card.audio.transcript,
      });
    }
  }
  return cards.sort((left, right) => left.card_id.localeCompare(right.card_id));
}

function readManifest(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'ai_tts', 'audio-lfs-manifest.json'), 'utf8'),
  );
  return new Map((manifest.files || []).map(entry => [entry.path, entry]));
}

function issue(code, details = {}) {
  return {code, ...details};
}

export function parseAfinfo(output) {
  const duration = Number(output.match(/estimated duration:\s+([0-9.]+) sec/)?.[1]);
  const channels = Number(output.match(/Data format:\s+(\d+) ch/)?.[1]);
  const sampleRate = Number(output.match(/Data format:\s+\d+ ch,\s+(\d+) Hz/)?.[1]);
  const bitrate = Number(output.match(/bit rate:\s+(\d+)/)?.[1]);
  if (![duration, channels, sampleRate, bitrate].every(Number.isFinite)) {
    throw new Error('afinfo output is incomplete');
  }
  return {
    bitrate_bps: bitrate,
    channels,
    duration_ms: Math.round(duration * 1000),
    format: 'mp3',
    sample_rate_hz: sampleRate,
  };
}

export function parseFfprobe(output) {
  const document = JSON.parse(output);
  const stream = (document.streams || []).find(item => item.codec_type === 'audio');
  const duration = Number(stream?.duration ?? document.format?.duration);
  const bitrate = Number(stream?.bit_rate ?? document.format?.bit_rate);
  const channels = Number(stream?.channels);
  const sampleRate = Number(stream?.sample_rate);
  if (![duration, bitrate, channels, sampleRate].every(Number.isFinite)) {
    throw new Error('ffprobe output is incomplete');
  }
  return {
    bitrate_bps: bitrate,
    channels,
    duration_ms: Math.round(duration * 1000),
    format: stream.codec_name,
    sample_rate_hz: sampleRate,
  };
}

export function createSystemAudioProbe(command) {
  if (!['afinfo', 'ffprobe'].includes(command)) {
    throw new Error('--probe must be afinfo or ffprobe');
  }
  return assetPath => {
    const args =
      command === 'afinfo'
        ? [assetPath]
        : [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name,channels,sample_rate,duration,bit_rate:format=duration,bit_rate',
            '-of',
            'json',
            assetPath,
          ];
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 1024 * 1024});
    if (result.error || result.status !== 0) throw new Error(`${command} failed`);
    return command === 'afinfo' ? parseAfinfo(result.stdout) : parseFfprobe(result.stdout);
  };
}

function distribution(records, field) {
  const values = new Map();
  for (const record of records) {
    const key = String(record.technical[field]);
    values.set(key, (values.get(key) || 0) + 1);
  }
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function auditAudioTechnical({
  durationToleranceMs = DEFAULT_DURATION_TOLERANCE_MS,
  probe,
  root = ROOT,
  track = 'cet4',
}) {
  const cards = collectAudioCards(root, requireTrack(track));
  const manifest = readManifest(root);
  const errors = [];
  const seenPaths = new Map();
  const assets = [];

  for (const card of cards) {
    const priorCardId = seenPaths.get(card.asset_path);
    if (priorCardId) {
      errors.push(
        issue('duplicate_audio_path_reference', {
          asset_path: card.asset_path,
          card_ids: [priorCardId, card.card_id],
        }),
      );
      continue;
    }
    seenPaths.set(card.asset_path, card.card_id);

    const transcript = typeof card.transcript === 'string' ? card.transcript.trim() : '';
    if (!transcript) errors.push(issue('audio_transcript_missing', {card_id: card.card_id}));
    const manifestEntry = manifest.get(card.asset_path);
    if (!manifestEntry) {
      errors.push(
        issue('audio_manifest_entry_missing', {
          asset_path: card.asset_path,
          card_id: card.card_id,
        }),
      );
      continue;
    }

    const absolutePath = path.join(root, card.asset_path);
    if (!fs.existsSync(absolutePath)) {
      errors.push(issue('audio_asset_missing', {asset_path: card.asset_path, card_id: card.card_id}));
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    const digest = sha256(bytes);
    if (digest !== manifestEntry.sha256 || bytes.byteLength !== manifestEntry.size_bytes) {
      errors.push(
        issue('audio_asset_manifest_mismatch', {
          asset_path: card.asset_path,
          card_id: card.card_id,
        }),
      );
      continue;
    }

    let technical;
    try {
      technical = probe(absolutePath);
    } catch {
      errors.push(issue('audio_probe_failed', {asset_path: card.asset_path, card_id: card.card_id}));
      continue;
    }
    if (
      technical.format !== 'mp3' ||
      !Number.isInteger(technical.channels) ||
      technical.channels < 1 ||
      !Number.isInteger(technical.sample_rate_hz) ||
      technical.sample_rate_hz <= 0 ||
      !Number.isFinite(technical.bitrate_bps) ||
      technical.bitrate_bps <= 0 ||
      !Number.isInteger(technical.duration_ms) ||
      technical.duration_ms <= 0
    ) {
      errors.push(issue('audio_probe_result_invalid', {asset_path: card.asset_path, card_id: card.card_id}));
      continue;
    }

    const durationDeltaMs = Math.abs(technical.duration_ms - card.declared_duration_ms);
    if (!Number.isFinite(card.declared_duration_ms) || durationDeltaMs > durationToleranceMs) {
      errors.push(
        issue('audio_duration_mismatch', {
          asset_path: card.asset_path,
          card_id: card.card_id,
          declared_duration_ms: card.declared_duration_ms,
          probed_duration_ms: technical.duration_ms,
        }),
      );
    }
    assets.push({
      asset_path: card.asset_path,
      card_id: card.card_id,
      declared_duration_ms: card.declared_duration_ms,
      duration_delta_ms: durationDeltaMs,
      file_sha256: digest,
      size_bytes: bytes.byteLength,
      technical,
      transcript_sha256: transcript ? sha256(Buffer.from(transcript, 'utf8')) : null,
    });
  }

  const durations = assets.map(record => record.technical.duration_ms);
  const hasIssue = codes => errors.some(entry => codes.includes(entry.code));
  return {
    schema_version: 'audio-technical-audit.v1',
    generated_at: new Date().toISOString(),
    track,
    authority_boundary:
      'technical integrity only; does not prove speech-to-transcript match, pronunciation, perceptual quality, source authenticity, or formal audio readiness',
    summary: {
      referenced_audio_cards: cards.length,
      unique_audio_paths: seenPaths.size,
      technically_verified_assets: assets.length,
      errors: errors.length,
      format_distribution: distribution(assets, 'format'),
      channel_distribution: distribution(assets, 'channels'),
      sample_rate_hz_distribution: distribution(assets, 'sample_rate_hz'),
      bitrate_bps_distribution: distribution(assets, 'bitrate_bps'),
      duration_ms: durations.length
        ? {
            min: Math.min(...durations),
            max: Math.max(...durations),
            average: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          }
        : null,
    },
    verification: {
      unique_asset_path_per_card: hasIssue(['duplicate_audio_path_reference'])
        ? 'failed'
        : 'passed',
      file_hash_and_size: hasIssue([
        'audio_manifest_entry_missing',
        'audio_asset_missing',
        'audio_asset_manifest_mismatch',
      ])
        ? 'failed'
        : 'passed',
      decoder_probe: hasIssue(['audio_probe_failed', 'audio_probe_result_invalid'])
        ? 'failed'
        : 'passed',
      declared_duration_binding: hasIssue(['audio_duration_mismatch']) ? 'failed' : 'passed',
      transcript_presence_and_hash: hasIssue(['audio_transcript_missing']) ? 'failed' : 'passed',
      speech_to_transcript_match: 'not_verified_requires_listening_or_independent_ASR_review',
      clipping_noise_pronunciation_rhythm_stress_pauses:
        'not_verified_requires_perceptual_QC',
      formal_audio_qc_records_created: 0,
    },
    errors,
    assets,
    ok: errors.length === 0,
  };
}

function runCli() {
  const track = requireTrack(option(process.argv, '--track', 'cet4'));
  const probeName = option(process.argv, '--probe', process.platform === 'darwin' ? 'afinfo' : 'ffprobe');
  const reportPath = path.resolve(
    ROOT,
    option(process.argv, '--report-path', `exports/${track}-audio-technical-audit.json`),
  );
  const report = auditAudioTechnical({
    probe: createSystemAudioProbe(probeName),
    root: ROOT,
    track,
  });
  fs.mkdirSync(path.dirname(reportPath), {recursive: true});
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        report_path: path.relative(ROOT, reportPath),
        summary: report.summary,
        verification: report.verification,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
