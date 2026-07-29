import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD_DIR = 'reviews/audio_vendor_selection';
const SUITE_PATH = `${RECORD_DIR}/CASES.json`;
const TEMPLATE_PATH = `${RECORD_DIR}/TEMPLATE.json`;
const EXPECTED_CATEGORIES = new Map([
  ['dialogue', 4],
  ['monologue', 4],
  ['weak_form', 4],
  ['linking', 4],
  ['error_prone_pronunciation', 4],
]);
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_MAPPING_FIELDS = ['blind_id', 'provider', 'model', 'voice', 'speed', 'generated_at', 'version'];

function resolveWorkspacePath(specPath) {
  return path.resolve(ROOT, specPath);
}

function readJson(specPath) {
  return JSON.parse(fs.readFileSync(resolveWorkspacePath(specPath), 'utf8'));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(specPath) {
  return sha256Bytes(fs.readFileSync(resolveWorkspacePath(specPath)));
}

function pushIssue(errors, code, details = {}) {
  errors.push({ code, ...details });
}

function sameMembers(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function parseArgs(argv) {
  const result = { record: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--record') {
      result.record = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return result;
}

function listRecordFiles() {
  const dir = resolveWorkspacePath(RECORD_DIR);
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json') && !['CASES.json', 'TEMPLATE.json'].includes(file))
    .sort()
    .map(file => `${RECORD_DIR}/${file}`);
}

function validateSuite(suite, errors) {
  if (suite.schema !== 'audio-vendor-selection-suite.v1') {
    pushIssue(errors, 'audio_vendor_suite_schema_invalid');
  }
  if (suite.status !== 'active' || suite.track !== 'cet4') {
    pushIssue(errors, 'audio_vendor_suite_scope_invalid');
  }
  const cases = Array.isArray(suite.cases) ? suite.cases : [];
  if (cases.length !== 20) {
    pushIssue(errors, 'audio_vendor_suite_case_count_invalid', { actual: cases.length, expected: 20 });
  }
  const ids = cases.map(entry => entry.case_id);
  if (new Set(ids).size !== ids.length) {
    pushIssue(errors, 'audio_vendor_suite_duplicate_case_id');
  }
  const categoryCounts = new Map();
  for (const entry of cases) {
    if (!hasText(entry.case_id) || !hasText(entry.transcript) || !hasText(entry.target_signal)) {
      pushIssue(errors, 'audio_vendor_suite_case_field_missing', { case_id: entry.case_id });
    }
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
  }
  for (const [category, count] of EXPECTED_CATEGORIES) {
    if (categoryCounts.get(category) !== count) {
      pushIssue(errors, 'audio_vendor_suite_category_coverage_invalid', {
        category,
        actual: categoryCounts.get(category) || 0,
        expected: count,
      });
    }
  }
  for (const category of categoryCounts.keys()) {
    if (!EXPECTED_CATEGORIES.has(category)) {
      pushIssue(errors, 'audio_vendor_suite_unknown_category', { category });
    }
  }
  return new Map(cases.map(entry => [entry.case_id, entry]));
}

function validateCompleteAssets(candidate, suiteCases, errors, source) {
  const assets = Array.isArray(candidate.assets) ? candidate.assets : [];
  const assetIds = assets.map(asset => asset.case_id);
  if (!sameMembers(assetIds, suiteCases.keys()) || new Set(assetIds).size !== assetIds.length) {
    pushIssue(errors, 'audio_vendor_candidate_case_coverage_invalid', {
      source,
      blind_id: candidate.blind_id,
      actual: assetIds.length,
      expected: suiteCases.size,
    });
  }
  for (const asset of assets) {
    const suiteCase = suiteCases.get(asset.case_id);
    if (!suiteCase) continue;
    if (!hasText(asset.path) || !String(asset.path).startsWith('ai_tts/vendor_selection/')) {
      pushIssue(errors, 'audio_vendor_asset_path_invalid', { source, blind_id: candidate.blind_id, case_id: asset.case_id });
      continue;
    }
    const fullPath = resolveWorkspacePath(asset.path);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      pushIssue(errors, 'audio_vendor_asset_missing', { source, blind_id: candidate.blind_id, case_id: asset.case_id });
    } else if (!SHA256.test(String(asset.file_sha256 || '')) || sha256File(asset.path) !== asset.file_sha256) {
      pushIssue(errors, 'audio_vendor_asset_hash_mismatch', { source, blind_id: candidate.blind_id, case_id: asset.case_id });
    }
    const expectedTranscriptHash = sha256Bytes(suiteCase.transcript);
    if (asset.transcript_sha256 !== expectedTranscriptHash) {
      pushIssue(errors, 'audio_vendor_transcript_hash_mismatch', { source, blind_id: candidate.blind_id, case_id: asset.case_id });
    }
  }
}

function evaluationLeaksIdentity(evaluation) {
  const forbidden = new Set(['provider', 'model', 'voice', 'voice_or_speaker']);
  const stack = [evaluation];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) return true;
      stack.push(child);
    }
  }
  return false;
}

function calculateResults(record, suiteCases, errors, source) {
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidateIds = candidates.map(candidate => candidate.blind_id);
  if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length || candidateIds.some(id => !/^[a-z][a-z0-9_-]+$/.test(String(id || '')))) {
    pushIssue(errors, 'audio_vendor_candidate_ids_invalid', { source });
  }
  const allAssetPaths = candidates.flatMap(candidate => (candidate.assets || []).map(asset => asset.path));
  if (new Set(allAssetPaths).size !== allAssetPaths.length) {
    pushIssue(errors, 'audio_vendor_asset_path_reused_across_candidates', { source });
  }

  const evaluations = Array.isArray(record.evaluations) ? record.evaluations : [];
  const evaluationById = new Map(evaluations.map(entry => [entry.blind_id, entry]));
  if (evaluationById.size !== evaluations.length || !sameMembers(evaluationById.keys(), candidateIds)) {
    pushIssue(errors, 'audio_vendor_evaluation_candidate_coverage_invalid', { source });
  }

  const summaries = [];
  for (const candidate of candidates) {
    validateCompleteAssets(candidate, suiteCases, errors, source);
    const evaluation = evaluationById.get(candidate.blind_id);
    if (!evaluation) continue;
    if (evaluationLeaksIdentity(evaluation)) {
      pushIssue(errors, 'audio_vendor_blind_evaluation_leaks_identity', { source, blind_id: candidate.blind_id });
    }
    if (!hasText(evaluation.reviewer) || evaluation.reviewer_role !== 'human_perceptual_reviewer' || !hasText(evaluation.scores_recorded_at)) {
      pushIssue(errors, 'audio_vendor_human_reviewer_evidence_missing', { source, blind_id: candidate.blind_id });
    }
    const scores = Array.isArray(evaluation.cases) ? evaluation.cases : [];
    const scoreIds = scores.map(entry => entry.case_id);
    if (!sameMembers(scoreIds, suiteCases.keys()) || new Set(scoreIds).size !== scoreIds.length) {
      pushIssue(errors, 'audio_vendor_score_case_coverage_invalid', { source, blind_id: candidate.blind_id });
    }
    let total = 0;
    let blockerCount = 0;
    for (const score of scores) {
      if (!Number.isInteger(score.listening_score) || score.listening_score < 1 || score.listening_score > 5) {
        pushIssue(errors, 'audio_vendor_listening_score_invalid', { source, blind_id: candidate.blind_id, case_id: score.case_id });
      } else {
        total += score.listening_score;
      }
      if (!Array.isArray(score.blockers)) {
        pushIssue(errors, 'audio_vendor_blockers_not_array', { source, blind_id: candidate.blind_id, case_id: score.case_id });
      } else {
        blockerCount += score.blockers.length;
        if (score.blockers.some(blocker => !hasText(blocker))) {
          pushIssue(errors, 'audio_vendor_blocker_reason_missing', { source, blind_id: candidate.blind_id, case_id: score.case_id });
        }
      }
    }
    summaries.push({
      blind_id: candidate.blind_id,
      mean: scores.length === suiteCases.size ? total / suiteCases.size : 0,
      blocker_count: blockerCount,
    });
  }
  return summaries;
}

function chooseWinner(eligible, providerById) {
  if (eligible.length === 0) return null;
  const highestMean = Math.max(...eligible.map(entry => entry.mean));
  const tied = eligible.filter(entry => entry.mean === highestMean);
  const tencent = tied.filter(entry => providerById.get(entry.blind_id)?.provider === 'tencent_cloud');
  return [...(tencent.length > 0 ? tencent : tied)].sort((a, b) => a.blind_id.localeCompare(b.blind_id))[0].blind_id;
}

function validateRecord(record, suiteCases, suiteHash, errors, source, { template = false } = {}) {
  for (const field of ['schema', 'selection_id', 'created_at', 'track', 'suite', 'blind_protocol', 'candidates', 'evaluations', 'unblinding', 'decision', 'quality_boundaries', 'validation']) {
    if (!(field in record)) pushIssue(errors, 'audio_vendor_record_field_missing', { source, field });
  }
  if (record.schema !== 'audio-vendor-selection.v1' || record.track !== 'cet4') {
    pushIssue(errors, 'audio_vendor_record_scope_invalid', { source });
  }
  if (record.suite?.file !== SUITE_PATH) {
    pushIssue(errors, 'audio_vendor_suite_path_drift', { source });
  }
  if (!template && record.suite?.file_sha256 !== suiteHash) {
    pushIssue(errors, 'audio_vendor_suite_hash_mismatch', { source });
  }
  if (record.decision?.minimum_mean_score !== 4 || record.decision?.maximum_blockers !== 0 || record.decision?.tie_breaker !== 'prefer_tencent_cloud_then_blind_id') {
    pushIssue(errors, 'audio_vendor_decision_policy_drift', { source });
  }
  if (!sameMembers(record.unblinding?.mapping_required_fields || [], REQUIRED_MAPPING_FIELDS)) {
    pushIssue(errors, 'audio_vendor_unblinding_mapping_schema_drift', { source });
  }
  for (const [field, expected] of Object.entries({
    human_perceptual_review_required: true,
    automation_cannot_supply_listening_scores: true,
    selection_is_not_per_card_audio_qc: true,
    selection_does_not_approve_content: true,
  })) {
    if (record.quality_boundaries?.[field] !== expected) {
      pushIssue(errors, 'audio_vendor_quality_boundary_missing', { source, field });
    }
  }
  if (template) {
    if (record.decision?.status !== 'pending' || record.decision?.winner_blind_id !== null) {
      pushIssue(errors, 'audio_vendor_template_must_be_pending', { source });
    }
    return null;
  }

  if (!hasText(record.selection_id) || !hasText(record.created_at)) {
    pushIssue(errors, 'audio_vendor_record_identity_missing', { source });
  }

  if (record.decision?.status !== 'complete') {
    pushIssue(errors, 'audio_vendor_record_not_complete', { source, status: record.decision?.status });
    return null;
  }
  if (record.blind_protocol?.provider_identity_hidden_during_scoring !== true || record.blind_protocol?.scores_recorded_before_unblinding !== true) {
    pushIssue(errors, 'audio_vendor_blind_protocol_not_attested', { source });
  }
  if (record.unblinding?.completed_after_scoring !== true || !hasText(record.unblinding?.completed_at)) {
    pushIssue(errors, 'audio_vendor_unblinding_evidence_missing', { source });
  }

  const summaries = calculateResults(record, suiteCases, errors, source);
  const mapping = Array.isArray(record.unblinding?.mapping) ? record.unblinding.mapping : [];
  const providerById = new Map(mapping.map(entry => [entry.blind_id, entry]));
  const candidateIds = (record.candidates || []).map(entry => entry.blind_id);
  if (providerById.size !== mapping.length || !sameMembers(providerById.keys(), candidateIds)) {
    pushIssue(errors, 'audio_vendor_unblinding_candidate_coverage_invalid', { source });
  }
  const providers = [];
  for (const entry of mapping) {
    if (REQUIRED_MAPPING_FIELDS.some(field => !hasText(entry[field]))) {
      pushIssue(errors, 'audio_vendor_unblinding_generation_field_missing', { source, blind_id: entry.blind_id });
    }
    providers.push(entry.provider);
  }
  if (new Set(providers).size !== providers.length) {
    pushIssue(errors, 'audio_vendor_duplicate_provider', { source });
  }
  const completedAt = Date.parse(record.unblinding?.completed_at);
  for (const evaluation of record.evaluations || []) {
    const scoredAt = Date.parse(evaluation.scores_recorded_at);
    if (!Number.isFinite(completedAt) || !Number.isFinite(scoredAt) || scoredAt > completedAt) {
      pushIssue(errors, 'audio_vendor_unblinding_before_scores_locked', { source, blind_id: evaluation.blind_id });
    }
  }

  const eligible = summaries.filter(entry => entry.blocker_count === 0 && entry.mean >= 4);
  const eligibleIds = eligible.map(entry => entry.blind_id);
  if (eligible.length === 0) {
    pushIssue(errors, 'audio_vendor_no_eligible_candidate', { source });
  }
  if (!sameMembers(record.decision?.eligible_blind_ids || [], eligibleIds)) {
    pushIssue(errors, 'audio_vendor_eligible_candidates_mismatch', { source, expected: eligibleIds });
  }
  const winner = chooseWinner(eligible, providerById);
  if (record.decision?.winner_blind_id !== winner) {
    pushIssue(errors, 'audio_vendor_winner_mismatch', { source, expected: winner, actual: record.decision?.winner_blind_id });
  }
  return { source, summaries, eligible_blind_ids: eligibleIds, winner_blind_id: winner };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, errors: [{ code: 'audio_vendor_cli_invalid', message: error.message }] }, null, 2));
  process.exit(1);
}

const errors = [];
const suite = readJson(SUITE_PATH);
const suiteCases = validateSuite(suite, errors);
const suiteHash = sha256File(SUITE_PATH);
validateRecord(readJson(TEMPLATE_PATH), suiteCases, suiteHash, errors, TEMPLATE_PATH, { template: true });
const recordFiles = options.record ? [options.record] : listRecordFiles();
const results = recordFiles.map(file => validateRecord(readJson(file), suiteCases, suiteHash, errors, file)).filter(Boolean);

const output = { ok: errors.length === 0, errors, suite_sha256: suiteHash, records_checked: recordFiles.length, results };
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exit(1);
