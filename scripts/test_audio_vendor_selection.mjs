import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_PATH = path.join(ROOT, 'reviews/audio_vendor_selection/CASES.json');
const SUITE = JSON.parse(fs.readFileSync(SUITE_PATH, 'utf8'));
const SUITE_HASH = crypto.createHash('sha256').update(fs.readFileSync(SUITE_PATH)).digest('hex');
const ASSET_ROOT = path.join(ROOT, 'ai_tts/vendor_selection', `.validator-test-${process.pid}`);

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeRecord({ scoresA = 4, scoresB = 4, blockerA = false } = {}) {
  fs.mkdirSync(ASSET_ROOT, { recursive: true });
  const candidates = ['candidate-a', 'candidate-b'].map(blindId => {
    const assets = SUITE.cases.map(entry => {
      const relativePath = `ai_tts/vendor_selection/.validator-test-${process.pid}/${blindId}-${entry.case_id}.mp3`;
      const bytes = Buffer.from(`${blindId}:${entry.case_id}`);
      fs.writeFileSync(path.join(ROOT, relativePath), bytes);
      return { case_id: entry.case_id, path: relativePath, file_sha256: hash(bytes), transcript_sha256: hash(entry.transcript) };
    });
    return { blind_id: blindId, assets };
  });
  const evaluations = candidates.map((candidate, candidateIndex) => ({
    blind_id: candidate.blind_id,
    reviewer: 'human-reviewer',
    reviewer_role: 'human_perceptual_reviewer',
    scores_recorded_at: '2026-07-29T10:00:00+08:00',
    cases: SUITE.cases.map((entry, caseIndex) => ({
      case_id: entry.case_id,
      listening_score: candidateIndex === 0 ? scoresA : scoresB,
      blockers: blockerA && candidateIndex === 0 && caseIndex === 0 ? ['pronunciation_error'] : [],
      notes: 'blind evaluation fixture',
    })),
  }));
  const eligible = [];
  if (!blockerA && scoresA >= 4) eligible.push('candidate-a');
  if (scoresB >= 4) eligible.push('candidate-b');
  const winner = eligible.includes('candidate-a') && scoresA >= scoresB ? 'candidate-a' : eligible[0] || null;
  return {
    schema: 'audio-vendor-selection.v1', selection_id: 'test-selection', created_at: '2026-07-29T09:00:00+08:00', track: 'cet4',
    suite: { file: 'reviews/audio_vendor_selection/CASES.json', file_sha256: SUITE_HASH },
    blind_protocol: { provider_identity_hidden_during_scoring: true, scores_recorded_before_unblinding: true, instructions: 'fixture' },
    candidates, evaluations,
    unblinding: {
      completed_at: '2026-07-29T11:00:00+08:00', completed_after_scoring: true,
      mapping_required_fields: ['blind_id', 'provider', 'model', 'voice', 'speed', 'generated_at', 'version'],
      mapping: [
        { blind_id: 'candidate-a', provider: 'tencent_cloud', model: 'model-a', voice: 'voice-a', speed: '1.0', generated_at: '2026-07-29T09:30:00+08:00', version: 'v1' },
        { blind_id: 'candidate-b', provider: 'aliyun', model: 'model-b', voice: 'voice-b', speed: '1.0', generated_at: '2026-07-29T09:30:00+08:00', version: 'v1' },
      ],
    },
    decision: { status: 'complete', minimum_mean_score: 4, maximum_blockers: 0, tie_breaker: 'prefer_tencent_cloud_then_blind_id', eligible_blind_ids: eligible, winner_blind_id: winner },
    quality_boundaries: { human_perceptual_review_required: true, automation_cannot_supply_listening_scores: true, selection_is_not_per_card_audio_qc: true, selection_does_not_approve_content: true },
    validation: [],
  };
}

function validate(record) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-vendor-selection-'));
  const recordPath = path.join(tempDir, 'record.json');
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  try {
    const stdout = execFileSync(process.execPath, ['scripts/validate_audio_vendor_selection.mjs', '--record', recordPath], { cwd: ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(String(error.stdout));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test.after(() => fs.rmSync(ASSET_ROOT, { recursive: true, force: true }));

test('Tencent Cloud wins an equal-score blind tie', () => {
  const result = validate(makeRecord());
  assert.equal(result.ok, true);
  assert.equal(result.results[0].winner_blind_id, 'candidate-a');
});

test('a blocker disqualifies a candidate', () => {
  const result = validate(makeRecord({ blockerA: true }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].eligible_blind_ids, ['candidate-b']);
  assert.equal(result.results[0].winner_blind_id, 'candidate-b');
});

test('a mean below four disqualifies a candidate', () => {
  const result = validate(makeRecord({ scoresA: 3, scoresB: 5 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].eligible_blind_ids, ['candidate-b']);
});

test('incomplete case coverage fails closed', () => {
  const record = makeRecord();
  record.evaluations[0].cases.pop();
  const result = validate(record);
  assert.equal(result.ok, false);
  assert(result.errors.some(error => error.code === 'audio_vendor_score_case_coverage_invalid'));
});

test('a declared winner mismatch fails closed', () => {
  const record = makeRecord({ scoresA: 5, scoresB: 4 });
  record.decision.winner_blind_id = 'candidate-b';
  const result = validate(record);
  assert.equal(result.ok, false);
  assert(result.errors.some(error => error.code === 'audio_vendor_winner_mismatch'));
});

test('automation cannot stand in for a named human reviewer', () => {
  const record = makeRecord();
  record.evaluations[0].reviewer = '';
  const result = validate(record);
  assert.equal(result.ok, false);
  assert(result.errors.some(error => error.code === 'audio_vendor_human_reviewer_evidence_missing'));
});
