import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function validateRecord(record, errors, source, { template = false } = {}) {
  const spec = readJson(SPEC_PATH);
  const requiredTopFields = [
    'audio_qc_id',
    'created_at',
    'agent',
    'scope',
    'source_records',
    'text_gate',
    'generation_plan',
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
  if (record.approval_boundary?.formal_content_approval_still_requires_user !== true) {
    pushIssue(errors, 'audio_qc_user_approval_boundary_missing', { source });
  }
  if (record.approval_boundary?.content_approval_record_required_for_formal_use !== true) {
    pushIssue(errors, 'audio_qc_approval_record_boundary_missing', { source });
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
    const perCard = new Map((record.per_card_qc || []).map(entry => [String(entry.card_id), entry]));
    for (const cardId of cardIds) {
      const entry = perCard.get(cardId);
      if (!entry) {
        pushIssue(errors, 'audio_qc_formal_ready_missing_per_card_qc', { source, card_id: cardId });
        continue;
      }
      if (entry.audio_matches_text !== true || entry.target_signal_audible !== true) {
        pushIssue(errors, 'audio_qc_formal_ready_failed_per_card_qc', { source, card_id: cardId });
      }
    }
  }
}

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

if (!result.ok) process.exit(1);
