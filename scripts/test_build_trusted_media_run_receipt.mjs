import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {buildTrustedMediaArtifacts as buildTrustedMediaArtifactsImpl} from './build_trusted_media_run_receipt.mjs';
import {
  PERCEPTUAL_CHECKS,
  buildAudioPerceptualWorklist,
  canonicalStringify,
} from './manage_audio_perceptual_worklist.mjs';
import {createCurrentFullTrackAuthorizationFixture} from './test_current_full_track_authorization_fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/trusted-media-runner-lock.json')));

function buildTrustedMediaArtifacts(options) {
  return buildTrustedMediaArtifactsImpl({
    ...options,
    technicalAuditReplayPath:
      options.technicalAuditReplayPath ??
      path.join(options.repoRoot, 'reviews/audio_technical_audits/cet4.json'),
  });
}

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
    'scripts/replay_trusted_media_raw_outputs.py',
    'scripts/audit_audio_technical.mjs',
    'scripts/manage_audio_perceptual_worklist.mjs',
    'scripts/lib/card_integrity.mjs',
    'scripts/lib/model_acceptance.mjs',
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
  for (let index = 1; index <= 1180; index += 1) {
    const cardId = String(index).padStart(6, '0');
    const transcript = `Trusted media sentence ${cardId}.`;
    const boxPrefix = String((index - 1) % 108).padStart(4, '0');
    const card = {
      card_id: cardId,
      track: 'cet4',
      interaction_id: 'flip',
      knowledge_ref: {
        library_id: '0',
        library_name: '听力',
        group_id: '0',
        group_name: '测试',
        box_id: '0',
        box_name: '测试盒',
        box_prefix: boxPrefix,
      },
      quality_metadata: {
        main_training_goal: '完整听取音频',
        secondary_training_goals: [],
        weak_point_tags: ['listening_weak'],
        difficulty: {primary: 'pass', secondary: []},
        card_prototype: 'integrated_micro_drill',
        box_progression_role: 'recognition',
        material: {
          text_source_type: 'simulation',
          source_note: 'Test-only simulated CET material.',
          audio_generation_method: index <= 301 ? 'TTS_AI_generated' : 'none',
          tts_text_reviewed: true,
          tts_audio_reviewed: false,
        },
        exam_value: 'Test-only listening transfer value.',
        review_status: 'draft',
      },
    };
    if (index <= 301) {
      const relativeAsset = `ai_tts/cet4/${boxPrefix}/${cardId}.mp3`;
      const file = write(root, relativeAsset, Buffer.from(`audio-${cardId}`));
      card.audio = {path: relativeAsset, transcript};
      assets.push({
        card_id: cardId,
        asset_path: relativeAsset,
        file_sha256: file.sha256,
        size_bytes: file.size_bytes,
        transcript_sha256: sha256(transcript),
        declared_duration_ms: 1000,
        signal: {
          estimated_transcript_wpm: 120,
          mean_volume_db: -20,
          peak_volume_db: -1,
          track_mean_volume_deviation_db: 0,
          transcript_word_count: 4,
        },
        technical: {
          bitrate_bps: 64000,
          channels: 1,
          duration_ms: 1000,
          format: 'mp3',
          sample_rate_hz: 16000,
        },
      });
    }
    cards.push(card);
  }
  write(root, 'card_boxes_json/test.json', {track: 'cet4', cards});
  const technicalAudit = {
    schema_version: 'audio-technical-audit.v1',
    track: 'cet4',
    generated_at: '2026-08-26T12:00:00.000Z',
    authority_boundary: 'technical integrity only',
    ok: true,
    summary: {errors: 0},
    verification: {
      unique_asset_path_per_card: 'passed',
      file_hash_and_size: 'passed',
      decoder_probe: 'passed',
      declared_duration_binding: 'passed',
      transcript_presence_and_hash: 'passed',
      coarse_signal_diagnostics: 'passed',
    },
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
  const {authorizationPath} = createCurrentFullTrackAuthorizationFixture({
    root,
    repositoryRoot: ROOT,
    cards,
  });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Trusted Media Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Trusted Media Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    execFileSync('git', args, {cwd: root, env: gitEnv, stdio: 'ignore'});
  }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const runDir = path.join(root, 'run-output');
  fs.mkdirSync(runDir);
  const runFiles = [];
  for (const name of ['a', 'b', 'f', 'g']) {
    const definition = LOCK.runs.find(run => run.name === name);
    const records = worklist.entries.map(entry => ({
      schema_version: 'trusted-media-model-run-record.v1',
      run_id: `32975067429:1:${name}`,
      run_name: name,
      purpose: definition.purpose,
      temperature: definition.temperature,
      card_id: entry.card_id,
      entry_identity_sha256: entry.entry_identity_sha256,
      asset_path: entry.audio.asset_path,
      asset_sha256: entry.audio.file_sha256,
      audio_coverage: {
        decoder: 'mlx_audio.stt.utils.load_audio',
        decoded_sample_count: 16000,
        model_input_sample_count: 16000,
        model_max_sample_count: LOCK.runtime.model_max_sample_count,
        model_feature_frame_count: LOCK.runtime.model_feature_frame_count,
        model_audio_token_count: LOCK.runtime.model_audio_token_count,
        sample_rate_hz: LOCK.runtime.sample_rate_hz,
        truncated: false,
      },
      complete_asset_consumed: true,
      status: 'ok',
      result: definition.purpose === 'blind_transcript' ? {
        transcript_heard: entry.audio.transcript,
      } : {
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
      raw_outputs: [],
      transcript_similarity: 1,
    }));
    for (const record of records) {
      record.raw_outputs = [JSON.stringify(record.result)];
    }
    const payload = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const file = write(root, `run-output/run-${name}.jsonl`, payload);
    runFiles.push({
      name,
      run_id: `32975067429:1:${name}`,
      purpose: definition.purpose,
      temperature: definition.temperature,
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
      id: LOCK.model.id,
      revision: LOCK.model.revision,
      weights_manifest_sha256: LOCK.model.weights_manifest_sha256,
    },
    execution: {
      workflow_run_id: '32975067429',
      workflow_run_attempt: 1,
      runner_class: LOCK.runtime.runner_class,
      started_at: '2026-08-26T12:02:00.000Z',
      completed_at: '2026-08-26T12:59:00.000Z',
    },
    runs: runFiles,
    decisions: worklist.entries.map(entry => ({
      card_id: entry.card_id,
      checks,
      acceptance_sources: [['a', 'f'], ['b', 'g']],
    })),
    result: {reviewed_card_count: 301, passed_card_count: 301, failed_card_count: 0},
  };
  const runPackageFile = write(root, 'run-output/run-package.json', runPackage);
  write(root, 'run-output/model-weights-manifest.json', {
    files: [{path: 'weights.safetensors', size_bytes: 1, sha256: sha256('weights')}],
    sha256: LOCK.model.weights_manifest_sha256,
  });
  write(root, 'run-output/mlx-audio-package-manifest.json', {
    files: [{path: '__init__.py', size_bytes: 1, sha256: sha256('mlx-audio')}],
    sha256: LOCK.runtime.mlx_audio_package_manifest_sha256,
  });
  write(root, 'run-output/python-environment-manifest.json', {
    files: [{path: 'mlx_audio/__init__.py', size_bytes: 1, sha256: sha256('python-env')}],
    sha256: LOCK.runtime.python_environment_manifest_sha256,
  });
  return {
    authorizationFile: {path: path.join(root, authorizationPath)},
    root,
    runDir,
    runPackageFile,
    sourceCommit,
    worklistFile,
  };
}

test('builder emits exact 301-asset reviewed worklist and receipt', t => {
  const fixture = buildFixture(t);
  const result = buildTrustedMediaArtifacts({
    authorizationPath: fixture.authorizationFile.path,
    outputDir: fixture.runDir,
    repoRoot: fixture.root,
    runPackagePath: fixture.runPackageFile.path,
    sourceCommit: fixture.sourceCommit,
    worklistPath: fixture.worklistFile.path,
    createdAt: new Date('2026-08-26T13:00:00.000Z'),
  });
  const receipt = JSON.parse(fs.readFileSync(result.receipt.path));
  const reviewed = JSON.parse(fs.readFileSync(result.reviewed_worklist.path));
  assert.equal(receipt.result.passed_card_count, 301);
  assert.equal(receipt.review_runs.length, 4);
  assert.equal(receipt.source.workflow_path, '.github/workflows/trusted-media-run.yml');
  assert.equal(reviewed.progress.passed, 301);
  assert.equal(reviewed.progress.failed, 0);
  assert.equal(reviewed.entries[0].review.model_acceptances.length, 2);
  assert.deepEqual(
    reviewed.entries[0].review.model_acceptances.map(acceptance => acceptance.actor.agent),
    ['agent:trusted-media-af', 'agent:trusted-media-bg'],
  );
  assert.equal(result.receipt.size_bytes < 1024 * 1024, true);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.runDir, 'ai_tts/cet4/0000/000001.mp3')),
    fs.readFileSync(path.join(fixture.root, 'ai_tts/cet4/0000/000001.mp3')),
  );
});

test('builder rejects a hand-authored technical audit without replayed signals', t => {
  const fixture = buildFixture(t);
  const replayPath = path.join(fixture.root, 'replayed-technical-audit.json');
  const replay = JSON.parse(fs.readFileSync(
    path.join(fixture.root, 'reviews/audio_technical_audits/cet4.json'),
  ));
  delete replay.assets[0].signal;
  fs.writeFileSync(replayPath, `${JSON.stringify(replay)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      technicalAuditReplayPath: replayPath,
      worklistPath: fixture.worklistFile.path,
    }),
    /lacks complete passing signal measurements/,
  );
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
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /file identity does not match package|retained raw model outputs do not replay packaged results/,
  );
});

test('builder rejects a result not supported by the retained raw model output', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const run = runPackage.runs.find(item => item.name === 'a');
  const runPath = path.join(fixture.runDir, run.path);
  const records = fs.readFileSync(runPath, 'utf8').trim().split('\n').map(JSON.parse);
  records[0].result.natural_rhythm = false;
  const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(runPath, bytes);
  run.sha256 = sha256(bytes);
  run.size_bytes = bytes.length;
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /retained raw model outputs do not replay packaged results/,
  );
});

test('builder rejects one general run reused as both acceptances', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  runPackage.decisions[0].acceptance_sources = [['a', 'f'], ['a', 'g']];
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /reuses one general run/,
  );
});

test('builder requires two distinct blind transcript runs in every acceptance', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  runPackage.runs = runPackage.runs.filter(run => !['f', 'g'].includes(run.name));
  for (const decision of runPackage.decisions) {
    decision.acceptance_sources = [['a'], ['b']];
  }
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /blind transcript runs|one blind transcript run/,
  );
});

test('builder rejects one pronunciation specialist reused across acceptance lanes', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const sourceRun = runPackage.runs.find(run => run.name === 'a');
  const sourceRecords = fs.readFileSync(
    path.join(fixture.runDir, sourceRun.path),
    'utf8',
  ).trim().split('\n').map(JSON.parse);
  const definition = LOCK.runs.find(run => run.name === 'd');
  const records = sourceRecords.map(record => ({
    ...record,
    run_id: '32975067429:1:d',
    run_name: 'd',
    purpose: definition.purpose,
    temperature: definition.temperature,
    result: {
      transcript_heard: record.result.transcript_heard,
      accurate_pronunciation: true,
      specific_error: '',
    },
  }));
  for (const record of records) {
    record.raw_outputs = [JSON.stringify(record.result)];
  }
  const bytes = Buffer.from(
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
  );
  const runFile = write(fixture.root, 'run-output/run-d.jsonl', bytes);
  runPackage.runs.push({
    name: 'd',
    run_id: '32975067429:1:d',
    purpose: definition.purpose,
    temperature: definition.temperature,
    path: path.basename(runFile.path),
    sha256: runFile.sha256,
    size_bytes: runFile.size_bytes,
    card_count: 301,
    complete_asset_count: 301,
  });
  for (const decision of runPackage.decisions) {
    decision.acceptance_sources = [['a', 'f', 'd'], ['b', 'g', 'd']];
  }
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /no pronunciation specialist or two distinct specialists/,
  );
});

test('builder rejects duplicate card rows hidden behind a 301-line run', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const run = runPackage.runs.find(item => item.name === 'a');
  const runPath = path.join(fixture.runDir, run.path);
  const records = fs.readFileSync(runPath, 'utf8').trim().split('\n').map(JSON.parse);
  records[1] = structuredClone(records[0]);
  const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(runPath, bytes);
  run.sha256 = sha256(bytes);
  run.size_bytes = bytes.length;
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /complete exact-asset consumption/,
  );
});

test('builder recomputes blind transcript similarity from raw text', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const run = runPackage.runs.find(item => item.name === 'f');
  const runPath = path.join(fixture.runDir, run.path);
  const records = fs.readFileSync(runPath, 'utf8').trim().split('\n').map(JSON.parse);
  records[0].result.transcript_heard = 'unrelated blind transcript';
  records[0].raw_outputs = [JSON.stringify(records[0].result)];
  records[0].transcript_similarity = 1;
  const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(runPath, bytes);
  run.sha256 = sha256(bytes);
  run.size_bytes = bytes.length;
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /transcript similarity is invalid/,
  );
});

test('builder rejects model identity drift from the trusted runner lock', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  runPackage.model.weights_manifest_sha256 = sha256('different-weights');
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /model identity does not match the trusted runner lock/,
  );
});

test('builder recomputes complete audio coverage instead of trusting the boolean', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const run = runPackage.runs.find(item => item.name === 'a');
  const runPath = path.join(fixture.runDir, run.path);
  const records = fs.readFileSync(runPath, 'utf8').trim().split('\n').map(JSON.parse);
  records[0].audio_coverage.model_input_sample_count -= 1;
  const bytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(runPath, bytes);
  run.sha256 = sha256(bytes);
  run.size_bytes = bytes.length;
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /does not prove complete untruncated model input/,
  );
});

test('builder refuses a source commit that is not the exact repository HEAD', t => {
  const fixture = buildFixture(t);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: 'f'.repeat(40),
      worklistPath: fixture.worklistFile.path,
    }),
    /source commit must equal the exact repository HEAD/,
  );
});

test('workflow isolates self-hosted model execution from OIDC attestation authority', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/trusted-media-run.yml'), 'utf8');
  const reviewJob = workflow.slice(
    workflow.indexOf('  review:'),
    workflow.indexOf('\n  verify:'),
  );
  const verifyJob = workflow.slice(
    workflow.indexOf('  verify:'),
    workflow.indexOf('\n  attest:'),
  );
  const attestJob = workflow.slice(workflow.indexOf('  attest:'));
  assert.match(reviewJob, /runs-on: \[self-hosted, macOS, ARM64, softbook-media\]/);
  assert.doesNotMatch(reviewJob, /id-token: write|attestations: write|actions\/attest@/);
  assert.match(reviewJob, /name: trusted-media-raw-/);
  assert.match(reviewJob, /if: always\(\)/);
  assert.match(reviewJob, /Fail after retaining rejected review evidence/);
  assert.match(reviewJob, /Initialize bounded review deadline/);
  assert.match(reviewJob, /TRUSTED_MEDIA_DEADLINE_EPOCH/);
  assert.match(reviewJob, /--deadline-epoch/);
  assert.match(reviewJob, /repository: LENKIN233\/softbook_cet/);
  assert.match(reviewJob, /ref: 53871ceb3b1a9090cd6f3cbb87086450feb177ca/);
  assert.match(reviewJob, /product-authority-review/);
  assert.match(verifyJob, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(verifyJob, /id-token: write|attestations: write|actions\/attest@/);
  assert.match(verifyJob, /lfs: true/);
  assert.match(verifyJob, /Rebuild and byte-verify receipt on GitHub-hosted runner/);
  assert.match(verifyJob, /repository: LENKIN233\/softbook_cet/);
  assert.match(verifyJob, /product-authority-verify/);
  assert.match(verifyJob, /TRUSTED_SOURCE_ROOT/);
  assert.match(verifyJob, /diff -qr "\$downloaded\/ai_tts" "\$rebuilt\/ai_tts"/);
  assert.match(attestJob, /runs-on: ubuntu-latest/);
  assert.match(attestJob, /id-token: write/);
  assert.match(attestJob, /attestations: write/);
  assert.match(attestJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.doesNotMatch(attestJob, /actions\/checkout@|node scripts\/|python3 -/);
  assert.match(reviewJob, /PYTHONNOUSERSITE: "1"/);
  assert.match(reviewJob, /GIT_NO_REPLACE_OBJECTS: "1"/);
  assert.match(reviewJob, /GIT_GRAFT_FILE: \/dev\/null/);
  assert.match(reviewJob, /GIT_REPLACE_REF_BASE: refs\/disabled\/softbook-trusted-media/);
  assert.match(reviewJob, /Replay exact technical audio audit/);
  assert.match(reviewJob, /--technical-audit-replay/);
  assert.match(verifyJob, /audit_audio_technical\.mjs/);
  assert.match(verifyJob, /--technical-audit-replay/);
  assert.match(verifyJob, /trusted-media-tree-manifest\.v2/);
  assert.match(verifyJob, /'size_bytes': item\[1\]/);
  assert.match(verifyJob, /value\.get\('sha256'\) != expected/);
  assert.match(verifyJob, /filename == 'python-environment-manifest\.json'/);
  assert.match(verifyJob, /len\(item\) != 3/);
});

test('PR contract gate downloads LFS only for formal media evidence changes', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-gates.yml'), 'utf8');
  const contractJob = workflow.split('  contract-harness:')[1].split('  content-scope:')[0];
  assert.match(contractJob, /lfs: false/);
  assert.match(contractJob, /formal_media_evidence_changed/);
  assert.match(contractJob, /formal_media_evidence_present/);
  assert.match(contractJob, /git cat-file -e/);
  assert.match(contractJob, /reviews\/trusted_media_receipts/);
  assert.match(contractJob, /git lfs pull --include='ai_tts\/\*\*\/\*\.mp3'/);
});

test('independent builders derive byte-identical receipt time from the run package', t => {
  const fixture = buildFixture(t);
  const rebuildDir = path.join(fixture.root, 'run-output-rebuild');
  fs.mkdirSync(rebuildDir);
  for (const filename of fs.readdirSync(fixture.runDir).filter(name =>
    (name.startsWith('run-') && (name.endsWith('.jsonl') || name === 'run-package.json')) ||
    [
      'model-weights-manifest.json',
      'mlx-audio-package-manifest.json',
      'python-environment-manifest.json',
    ].includes(name)
  )) {
    fs.copyFileSync(path.join(fixture.runDir, filename), path.join(rebuildDir, filename));
  }
  const first = buildTrustedMediaArtifacts({
    authorizationPath: fixture.authorizationFile.path,
    outputDir: fixture.runDir,
    repoRoot: fixture.root,
    runPackagePath: fixture.runPackageFile.path,
    sourceCommit: fixture.sourceCommit,
    worklistPath: fixture.worklistFile.path,
  });
  const second = buildTrustedMediaArtifacts({
    authorizationPath: fixture.authorizationFile.path,
    outputDir: rebuildDir,
    repoRoot: fixture.root,
    runPackagePath: path.join(rebuildDir, 'run-package.json'),
    sourceCommit: fixture.sourceCommit,
    worklistPath: fixture.worklistFile.path,
  });
  assert.equal(first.receipt.sha256, second.receipt.sha256);
  assert.deepEqual(fs.readFileSync(first.receipt.path), fs.readFileSync(second.receipt.path));
});

test('builder rejects a pronunciation override supported by only one acceptance lane', t => {
  const fixture = buildFixture(t);
  const runPackage = JSON.parse(fs.readFileSync(fixture.runPackageFile.path));
  const generalRun = runPackage.runs.find(item => item.name === 'a');
  const generalPath = path.join(fixture.runDir, generalRun.path);
  const generalRecords = fs.readFileSync(generalPath, 'utf8').trim().split('\n').map(JSON.parse);
  for (const record of generalRecords) {
    record.result.accurate_pronunciation = false;
    record.raw_outputs = [JSON.stringify(record.result)];
  }
  const generalBytes = Buffer.from(
    `${generalRecords.map(record => JSON.stringify(record)).join('\n')}\n`,
  );
  fs.writeFileSync(generalPath, generalBytes);
  generalRun.sha256 = sha256(generalBytes);
  generalRun.size_bytes = generalBytes.length;

  const definition = LOCK.runs.find(item => item.name === 'd');
  const specialistRecords = generalRecords.map(record => {
    const result = {
      transcript_heard: record.result.transcript_heard,
      accurate_pronunciation: true,
      specific_error: '',
    };
    return {
      ...record,
      run_id: '32975067429:1:d',
      run_name: 'd',
      purpose: definition.purpose,
      temperature: definition.temperature,
      result,
      raw_outputs: [JSON.stringify(result)],
    };
  });
  const specialistBytes = Buffer.from(
    `${specialistRecords.map(record => JSON.stringify(record)).join('\n')}\n`,
  );
  const specialistFile = write(fixture.root, 'run-output/run-d.jsonl', specialistBytes);
  runPackage.runs.push({
    name: 'd',
    run_id: '32975067429:1:d',
    purpose: definition.purpose,
    temperature: definition.temperature,
    path: 'run-d.jsonl',
    sha256: specialistFile.sha256,
    size_bytes: specialistFile.size_bytes,
    card_count: 301,
    complete_asset_count: 301,
  });
  for (const decision of runPackage.decisions) {
    decision.acceptance_sources = [['a', 'f', 'd'], ['b', 'g']];
  }
  fs.writeFileSync(fixture.runPackageFile.path, `${JSON.stringify(runPackage)}\n`);
  assert.throws(
    () => buildTrustedMediaArtifacts({
      authorizationPath: fixture.authorizationFile.path,
      outputDir: fixture.runDir,
      repoRoot: fixture.root,
      runPackagePath: fixture.runPackageFile.path,
      sourceCommit: fixture.sourceCommit,
      worklistPath: fixture.worklistFile.path,
    }),
    /no pronunciation specialist or two distinct specialists/,
  );
});
