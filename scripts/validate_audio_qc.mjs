import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {validateIndependentModelAcceptances} from './lib/model_acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = 'spec/audio-generation-contract.json';
const RECORD_DIR = 'reviews/audio_qc';
const TEMPLATE_PATH = `${RECORD_DIR}/TEMPLATE.json`;

function resolveWorkspacePath(specPath) {
  return path.resolve(ROOT, specPath);
}

function readJson(specPath) {
  return JSON.parse(fs.readFileSync(resolveWorkspacePath(specPath), 'utf8'));
}

function exists(specPath) {
  return fs.existsSync(resolveWorkspacePath(specPath));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushIssue(list, code, details = {}) {
  list.push({ code, ...details });
}

function listRecordFiles() {
  const dir = resolveWorkspacePath(RECORD_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json') && file !== 'TEMPLATE.json')
    .sort()
    .map(file => `${RECORD_DIR}/${file}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function validateAudioAcceptanceInput(record, {root = ROOT, template = false} = {}) {
  if (template) return {issues: [], input_sha256: null};
  const issues = [];
  const transcripts = new Map();
  const perCardEvidence = new Map();
  for (const entry of record.per_card_qc || []) {
    const cardId = String(entry?.card_id || '');
    if (!cardId || perCardEvidence.has(cardId)) {
      issues.push({code: 'audio_qc_per_card_identity_duplicate', card_id: cardId});
      continue;
    }
    perCardEvidence.set(cardId, entry);
  }
  for (const entry of record.text_gate?.transcripts || []) {
    const cardId = String(entry?.card_id || '');
    if (!cardId || transcripts.has(cardId)) {
      issues.push({code: 'audio_qc_transcript_identity_duplicate', card_id: cardId});
      continue;
    }
    transcripts.set(cardId, entry);
  }
  const identities = [];
  const assetIds = new Set();
  for (const asset of record.generated_assets || []) {
    const cardId = String(asset?.card_id || '');
    if (!cardId || assetIds.has(cardId)) {
      issues.push({code: 'audio_qc_asset_identity_duplicate', card_id: cardId});
      continue;
    }
    assetIds.add(cardId);
    const transcript = transcripts.get(cardId);
    const perCard = perCardEvidence.get(cardId);
    if (!transcript) {
      issues.push({code: 'audio_qc_asset_transcript_missing', card_id: cardId});
      continue;
    }
    if (!perCard) {
      issues.push({code: 'audio_qc_asset_per_card_evidence_missing', card_id: cardId});
      continue;
    }
    const expectedTranscriptHash = sha256(Buffer.from(String(transcript.transcript || ''), 'utf8'));
    if (asset.transcript_sha256 !== expectedTranscriptHash) {
      issues.push({code: 'audio_qc_transcript_hash_mismatch', card_id: cardId});
    }
    const absolute = path.resolve(root, String(asset.path || ''));
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(absolute)) {
      issues.push({code: 'audio_qc_asset_missing_on_disk', card_id: cardId});
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({code: 'audio_qc_asset_not_regular_file', card_id: cardId});
      continue;
    }
    const expectedFileHash = sha256(fs.readFileSync(absolute));
    if (asset.file_sha256 !== expectedFileHash) {
      issues.push({code: 'audio_qc_asset_hash_mismatch', card_id: cardId});
    }
    identities.push({
      card_id: cardId,
      path: asset.path,
      file_sha256: expectedFileHash,
      transcript_sha256: expectedTranscriptHash,
      per_card_qc: {
        complete_asset_consumed: perCard.complete_asset_consumed,
        matches_text: perCard.matches_text,
        target_signal: perCard.target_signal,
        pronunciation: perCard.pronunciation,
        speed: perCard.speed,
        rhythm: perCard.rhythm,
        stress_pauses: perCard.stress_pauses,
        no_noise: perCard.no_noise,
      },
    });
  }
  const scopeIds = new Set((record.scope?.card_ids || []).map(String));
  if (
    scopeIds.size !== assetIds.size ||
    [...scopeIds].some(cardId => !assetIds.has(cardId)) ||
    [...scopeIds].some(cardId => !transcripts.has(cardId)) ||
    [...scopeIds].some(cardId => !perCardEvidence.has(cardId)) ||
    perCardEvidence.size !== scopeIds.size
  ) {
    issues.push({code: 'audio_qc_scope_asset_transcript_coverage_mismatch'});
  }
  identities.sort((left, right) =>
    left.card_id.localeCompare(right.card_id) || left.path.localeCompare(right.path));
  return {
    issues,
    input_sha256: `sha256:${sha256(Buffer.from(JSON.stringify(identities), 'utf8'))}`,
  };
}

function validateRecord(record, errors, source, { template = false } = {}) {
  const spec = readJson(SPEC_PATH);
  const modelOwned = record.schema_version === 'model-owned-audio-qc.v2';
  const requiredTopFields = [
    ...(modelOwned ? ['schema_version', 'model_acceptances'] : ['agent']),
    'audio_qc_id',
    'created_at',
    'scope',
    'source_records',
    'text_gate',
    'generation_plan',
    'legacy_adoption',
    'generated_assets',
    'qa_checks',
    'per_card_qc',
    'verdict',
    'approval_boundary',
    'validation',
  ];
  for (const field of requiredTopFields) {
    if (!(field in record)) pushIssue(errors, 'audio_qc_record_field_missing', { source, field });
  }
  if (modelOwned) {
    for (const issue of validateIndependentModelAcceptances(
      record.model_acceptances,
      {
        allowTemplatePlaceholders: template,
        requiredCapabilities: ['audio_perceptual_review'],
      },
    )) {
      pushIssue(errors, `audio_qc_${issue.code}`, {source, ...issue});
    }
  } else if (!template) {
    pushIssue(errors, 'audio_qc_legacy_archive_only', {source});
  }

  const cardIds = Array.isArray(record.scope?.card_ids) ? record.scope.card_ids.map(String) : [];
  if (!template && cardIds.length === 0) {
    pushIssue(errors, 'audio_qc_scope_card_ids_missing', { source });
  }
  for (const field of ['library', 'group', 'box']) {
    if (!template && !hasText(record.scope?.[field])) {
      pushIssue(errors, 'audio_qc_scope_field_missing', { source, field });
    }
  }

  const allowedMethods = new Set([
    ...(spec.allowed_generation_methods || []),
    ...(spec.legacy_generation_method_aliases || []),
  ]);
  if (!allowedMethods.has(record.generation_plan?.method)) {
    pushIssue(errors, 'audio_qc_generation_method_unknown', {
      source,
      method: record.generation_plan?.method,
    });
  }
  if (record.generation_plan?.output_dir !== spec.asset_policy?.asset_dir) {
    pushIssue(errors, 'audio_qc_output_dir_drift', {
      source,
      expected: spec.asset_policy?.asset_dir,
      actual: record.generation_plan?.output_dir,
    });
  }
  if (record.generation_plan?.overwrite_existing_assets === true && !hasText(record.generation_plan?.replacement_reason)) {
    pushIssue(errors, 'audio_qc_overwrite_missing_replacement_reason', { source });
  }

  const legacyAdoption = record.legacy_adoption?.enabled === true;
  if (legacyAdoption) {
    if (!hasText(record.legacy_adoption?.reviewed_at)) {
      pushIssue(errors, 'audio_qc_legacy_reviewed_at_missing', { source });
    }
    if (!modelOwned && !hasText(record.legacy_adoption?.reviewer)) {
      pushIssue(errors, 'audio_qc_legacy_reviewer_missing', { source });
    }
    if (record.legacy_adoption?.reproducibility_status !== 'non_reproducible') {
      pushIssue(errors, 'audio_qc_legacy_reproducibility_claim_invalid', { source });
    }
    if (record.generation_plan?.provider !== 'legacy_unknown') {
      pushIssue(errors, 'audio_qc_legacy_provider_must_be_unknown', { source });
    }
    if (record.generation_plan?.voice_or_speaker !== 'legacy_unknown') {
      pushIssue(errors, 'audio_qc_legacy_voice_must_be_unknown', { source });
    }
  }

  for (const check of spec.formal_audio_qc?.required_checks || []) {
    if (typeof record.qa_checks?.[check] !== 'boolean') {
      pushIssue(errors, 'audio_qc_required_check_missing_or_not_boolean', { source, check });
    }
  }
  if (record.qa_checks?.tts_audio_not_used_as_source_authenticity !== true) {
    pushIssue(errors, 'audio_qc_source_authenticity_boundary_missing', { source });
  }
  if (record.approval_boundary?.tts_audio_is_not_source_authenticity_evidence !== true) {
    pushIssue(errors, 'audio_qc_tts_boundary_missing', { source });
  }
  if (modelOwned) {
    if (
      record.approval_boundary
        ?.current_model_owned_content_authorization_required !== true ||
      record.approval_boundary?.external_facts_must_not_be_inferred !== true
    ) {
      pushIssue(errors, 'audio_qc_model_owned_boundary_missing', {source});
    }
  } else {
    if (record.approval_boundary?.formal_content_approval_still_requires_user !== true) {
      pushIssue(errors, 'audio_qc_user_approval_boundary_missing', { source });
    }
    if (record.approval_boundary?.content_approval_record_required_for_formal_use !== true) {
      pushIssue(errors, 'audio_qc_approval_record_boundary_missing', { source });
    }
  }

  const transcripts = Array.isArray(record.text_gate?.transcripts) ? record.text_gate.transcripts : [];
  if (!template && record.text_gate?.tts_text_reviewed !== true) {
    pushIssue(errors, 'audio_qc_text_gate_not_reviewed', { source });
  }
  if (!template && transcripts.length === 0) {
    pushIssue(errors, 'audio_qc_transcripts_missing', { source });
  }
  for (const transcript of transcripts) {
    for (const field of ['card_id', 'transcript', 'target_signal', 'pronunciation_notes']) {
      if (!template && !hasText(transcript[field])) {
        pushIssue(errors, 'audio_qc_transcript_field_missing', {
          source,
          card_id: transcript.card_id,
          field,
        });
      }
    }
  }

  const assets = Array.isArray(record.generated_assets) ? record.generated_assets : [];
  if (modelOwned && !template) {
    const identity = validateAudioAcceptanceInput(record);
    for (const issue of identity.issues) pushIssue(errors, issue.code, {source, ...issue});
    for (const acceptance of record.model_acceptances || []) {
      if (acceptance?.evidence?.input_sha256 !== identity.input_sha256) {
        pushIssue(errors, 'audio_qc_model_acceptance_input_mismatch', {
          source,
          expected: identity.input_sha256,
          actual: acceptance?.evidence?.input_sha256 ?? null,
        });
      }
    }
  }
  if (!template && record.verdict?.formal_audio_ready === true && assets.length === 0) {
    pushIssue(errors, 'audio_qc_formal_ready_without_assets', { source });
  }
  for (const asset of assets) {
    if (!template && !String(asset.path || '').startsWith(spec.asset_policy?.asset_dir || 'ai_tts/')) {
      pushIssue(errors, 'audio_qc_asset_outside_audio_dir', {
        source,
        card_id: asset.card_id,
        path: asset.path,
      });
    }
    if (!template && hasText(asset.path) && !exists(asset.path)) {
      pushIssue(errors, 'audio_qc_asset_missing_on_disk', {
        source,
        card_id: asset.card_id,
        path: asset.path,
      });
    }
    if (!template && legacyAdoption) {
      if (!/^[a-f0-9]{64}$/.test(String(asset.file_sha256 || ''))) {
        pushIssue(errors, 'audio_qc_legacy_asset_hash_missing', {
          source,
          card_id: asset.card_id,
        });
      }
      if (!hasText(asset.provenance_note)) {
        pushIssue(errors, 'audio_qc_legacy_asset_provenance_note_missing', {
          source,
          card_id: asset.card_id,
        });
      }
    }
  }

  const formalReady = record.verdict?.formal_audio_ready === true;
  if (formalReady) {
    for (const check of spec.formal_audio_qc?.required_checks || []) {
      if (record.qa_checks?.[check] !== true) {
        pushIssue(errors, 'audio_qc_formal_ready_with_failed_check', { source, check });
      }
    }
    if (record.verdict?.requires_regeneration === true) {
      pushIssue(errors, 'audio_qc_formal_ready_but_requires_regeneration', { source });
    }
    const perCardEntries = Array.isArray(record.per_card_qc)
      ? record.per_card_qc
      : [];
    const perCard = new Map(perCardEntries.map(entry => [String(entry.card_id), entry]));
    if (
      perCard.size !== perCardEntries.length ||
      perCard.size !== cardIds.length ||
      perCardEntries.some(entry => !cardIds.includes(String(entry.card_id)))
    ) {
      pushIssue(errors, 'audio_qc_formal_ready_per_card_scope_mismatch', {source});
    }
    for (const cardId of cardIds) {
      const entry = perCard.get(cardId);
      if (!entry) {
        pushIssue(errors, 'audio_qc_formal_ready_missing_per_card_qc', { source, card_id: cardId });
        continue;
      }
      const generatedAsset = assets.find(asset => String(asset.card_id) === cardId);
      if (
        entry.asset_path !== generatedAsset?.path ||
        [
          'complete_asset_consumed',
          'matches_text',
          'target_signal',
          'pronunciation',
          'speed',
          'rhythm',
          'stress_pauses',
          'no_noise',
        ].some(field => entry[field] !== true)
      ) {
        pushIssue(errors, 'audio_qc_formal_ready_failed_per_card_qc', { source, card_id: cardId });
      }
    }
  }
}

function main() {
  const errors = [];
  const warnings = [];
  if (!exists(SPEC_PATH)) pushIssue(errors, 'audio_generation_contract_missing', { path: SPEC_PATH });
  if (!exists(TEMPLATE_PATH)) pushIssue(errors, 'audio_qc_template_missing', { path: TEMPLATE_PATH });
  if (errors.length === 0) {
    validateRecord(readJson(TEMPLATE_PATH), errors, TEMPLATE_PATH, { template: true });
    for (const file of listRecordFiles()) validateRecord(readJson(file), errors, file);
  }
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    records_checked: errors.length === 0 ? listRecordFiles().length : 0,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
