import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {buildTrustedMediaArtifacts} from './build_trusted_media_run_receipt.mjs';
import {
  PERCEPTUAL_CHECKS,
  buildAudioPerceptualWorklist,
  canonicalStringify,
} from './manage_audio_perceptual_worklist.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  fs.writeFileSync(target, bytes);
  return {bytes, path: target, sha256: sha256(bytes), size_bytes: bytes.length};
}

function copyProducerAssets(root) {
  for (const relativePath of [
    '.github/workflows/trusted-media-run.yml',
    'scripts/run_trusted_media_review.py',
    'scripts/build_trusted_media_run_receipt.mjs',
    'scripts/manage_audio_perceptual_worklist.mjs',
    'spec/trusted-media-runner-lock.json',
  ]) {
    write(root, relativePath, fs.readFileSync(path.join(ROOT, relativePath)));
  }
}

function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-media-builder-'));
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  copyProducerAssets(root);
  const cards = [];
  const assets = [];
  for (let index = 1; index <= 301; index += 1) {
    const cardId = String(index).padStart(6, '0');
    const transcript = `Trusted media sentence ${cardId}.`;
    const relativeAsset = `ai_tts/cet4/0000/${cardId}.mp3`;
    const file = write(root, relativeAsset, Buffer.from(`audio-${cardId}`));
    cards.push({
      card_id: cardId,
      knowledge_ref: {
        library_id: '0',
        library_name: '听力',
        group_id: '0',
        group_name: '测试',
        box_id: '0',
        box_name: '测试盒',
        box_prefix: '0000',
      },
      quality_metadata: {
        main_training_goal: '完整听取音频',
        box_progression_role: 'recognition',
      },
      audio: {path: relativeAsset, transcript},
    });
    assets.push({
      card_id: cardId,
      asset_path: relativeAsset,
      file_sha256: file.sha256,
      size_bytes: file.size_bytes,
      transcript_sha256: sha256(transcript),
      declared_duration_ms: 1000,
      technical: {duration_ms: 1000},
    });
  }
  write(root, 'card_boxes_json/test.json', {track: 'cet4', cards});
  const technicalAudit = {
    schema_version: 'audio-technical-audit.v1',
    track: 'cet4',
    generated_at: '2026-08-26T12:00:00.000Z',
    ok: true,
    summary: {errors: 0},
    assets,
  };
  const auditFile = write(
    root,
    'reviews/audio_technical_audits/cet4.json',
    `${JSON.stringify(technicalAudit, null, 2)}\n`,
  );
  const {worklist} = buildAudioPerceptualWorklist({
    clock: () => new Date('2026-08-26T12:01:00.000Z'),
    root,
    technicalAuditPath: auditFile.path,
    track: 'cet4',
  });
  const worklistFile = write(
    root,
    'reviews/audio_perceptual_worklists/cet4-pending.json',
    `${JSON.stringify(worklist)}\n`,
  );
  const modelReview = write(
    root,
    'reviews/agent_self_review/cet4-full-review.json',
    {schema_version: 'model-owned-full-track-review.v2'},
  );
  const qualityAudit = write(
    root,
    'reviews/audit_scopes/cet4-full-audit.json',
    {schema_version: 'card-quality-audit.v1'},
  );
  const authorization = {
    schema_version: 'model-owned-content-authorization.v2',
    authorization_mode: 'full_track',
    content_version: `sha256:${sha256('content')}`,
    scope: {
      track: 'cet4',
      purpose: 'formal_content',
      card_ids: Array.from({length: 1180}, (_, index) => String(index + 1).padStart(6, '0')),
      box_prefixes: Array.from({length: 108}, (_, index) => String(index).padStart(4, '0')),
    },
    validation: {
      model_review: path.relative(root, modelReview.path),
      model_review_sha256: `sha256:${modelReview.sha256}`,
    },
    card_quality_audit: {
      report: path.relative(root, qualityAudit.path),
      report_sha256: `sha256:${qualityAudit.sha256}`,
      scope_has_no_hard_blockers: true,
      scope_summary: {
        card_count: 1180,
        by_severity: {hard_blocker: 0, content_risk: 0, review_gap: 0},
      },
    },
  };
  const authorizationFile = write(
    root,
    'reviews/approved_batches/cet4-full.json',
    authorization,
  );
  const runDir = path.join(root, 'run-output');
  fs.mkdirSync(runDir);
  const runFiles = [];
  for (const name of ['a', 'b']) {
    const records = worklist.entries.map(entry => ({
      schema_version: 'trusted-media-model-run-record.v1',
      run_id: `32975067429:1:${name}`,
      run_name: name,
      purpose: 'full_perceptual',
      temperature: name === 'a' ? 0 : 0.1,
      card_id: entry.card_id,
      entry_identity_sha256: entry.entry_identity_sha256,
      asset_path: entry.audio.asset_path,
      asset_sha256: entry.audio.file_sha256,
      complete_asset_consumed: true,
      status: 'ok',
      result: {
        transcript_heard: entry.audio.transcript,
        matches_text: true,
        target_signal_audible: true,
        accurate_pronunciation: true,
        suitable_speed: true,
        natural_rhythm: true,
        stress_pauses_do_not_mislead: true,
        no_unwanted_noise_or_clipping: true,
        notes: '',
      },
      raw_outputs: ['accepted'],
      transcript_similarity: 1,
    }));
    const payload = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const file = write(root, `run-output/run-${name}.jsonl`, payload);
    runFiles.push({
      name,
      run_id: `32975067429:1:${name}`,
      purpose: 'full_perceptual',
      temperature: name === 'a' ? 0 : 0.1,
      path: path.basename(file.path),
      sha256: file.sha256,
      size_bytes: file.size_bytes,
      card_count: 301,
      complete_asset_count: 301,
    });
  }
  const checks = Object.fromEntries(PERCEPTUAL_CHECKS.map(check => [check, true]));
  const runPackage = {
    schema_version: 'trusted-media-model-run-package.v1',
    model: {
      id: 'mlx-community/Qwen2-Audio-7B-Instruct-4bit',
      revision: 'c65570002626f41b4dc08b7b54f42f99f3e82e7f',
      weights_manifest_sha256: sha256('weights'),
    },
    execution: {
      workflow_run_id: '32975067429',
      workflow_run_attempt: 1,
      runner_class: 'self_hosted_macos_arm64',
      started_at: '2026-08-26T12:02:00.000Z',
      completed_at: '2026-08-26T12:59:00.000Z',
    },
    runs: runFiles,
    decisions: worklist.entries.map(entry => ({
      card_id: entry.card_id,
      checks,
      acceptance_sources: [['a'], ['b']],
    })),
    result: {reviewed_card_count: 301, passed_card_count: 301, failed_card_count: 0},
  };
  const runPackageFile = write(root, 'run-output/run-package.json', runPackage);
  return {authorizationFile, root, runDir, runPackageFile, worklistFile};
}

test('builder emits exact 301-asset reviewed worklist and receipt', t => {
  const fixture = buildFixture(t);
  const result = buildTrustedMediaArtifacts({
    authorizationPath: fixture.authorizationFile.path,
    outputDir: fixture.runDir,
    repoRoot: fixture.root,
    runPackagePath: fixture.runPackageFile.path,
    sourceCommit: sha256('commit').slice(0, 40),
    worklistPath: fixture.worklistFile.path,
    createdAt: new Date('2026-08-26T13:00:00.000Z'),
  });
  const receipt = JSON.parse(fs.readFileSync(result.receipt.path));
  const reviewed = JSON.parse(fs.readFileSync(result.reviewed_worklist.path));
  assert.equal(receipt.result.passed_card_count, 301);
  assert.equal(receipt.review_runs.length, 2);
  assert.equal(receipt.source.workflow_path, '.github/workflows/trusted-media-run.yml');
  assert.equal(reviewed.progress.passed, 301);
  assert.equal(reviewed.progress.failed, 0);
  assert.equal(reviewed.entries[0].review.model_acceptances.length, 2);
  assert.equal(result.receipt.size_bytes < 1024 * 1024, true);
});

test('builder rejects a run file changed after package creation', t => {
  const fixture = buildFixture(t);
  fs.appendFileSync(path.join(fixture.runDir, 'run-a.jsonl'), '{}\n');
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: sha256('commit').slice(0, 40),
      worklistPath: fixture.worklistFile.path,
    }),
    /file identity does not match package/,
  );
});

test('builder rejects one general run reused as both acceptances', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  runPackage.decisions[0].acceptance_sources = [['a'], ['a']];
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: sha256('commit').slice(0, 40),
      worklistPath: fixture.worklistFile.path,
    }),
    /reuses one general run/,
  );
});
