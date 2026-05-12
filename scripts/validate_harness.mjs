import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_BLOCKERS = [
  'logic_error',
  'language_error',
  'inappropriate_wording',
  'low_knowledge_density',
  'not_meeting_requirement',
  'reverse_engineered_front',
  'fake_source_claim',
  'low_quality_variation',
];

const REQUIRED_METADATA_FIELDS = [
  'main_training_goal',
  'weak_point_tags',
  'difficulty',
  'card_prototype',
  'material',
  'exam_value',
  'review_status',
];

function resolveWorkspacePath(specPath) {
  return path.resolve(ROOT, specPath);
}

function readJson(specPath) {
  return JSON.parse(fs.readFileSync(resolveWorkspacePath(specPath), 'utf8'));
}

function exists(specPath) {
  return fs.existsSync(resolveWorkspacePath(specPath));
}

function pushIssue(list, code, details) {
  list.push({ code, ...details });
}

function validateManifest(errors) {
  const manifest = readJson('spec/doc-manifest.json');
  for (const doc of manifest.active_docs || []) {
    if (!doc.path || !exists(doc.path)) {
      pushIssue(errors, 'manifest_missing_active_doc', { path: doc.path });
    }
    if (doc.status !== 'active') {
      pushIssue(errors, 'manifest_doc_not_active', { path: doc.path, status: doc.status });
    }
  }
  return manifest;
}

function validateAuthorityMap(errors) {
  const map = readJson('spec/authority-map.json');
  for (const [concept, ownerPath] of Object.entries(map.owners || {})) {
    if (!exists(ownerPath)) {
      pushIssue(errors, 'authority_owner_missing', { concept, ownerPath });
    }
  }
  if (map.conflict_policy?.approval_conflict !== 'No agent, script, legacy field, or PR status can override explicit user approval for formal usable content.') {
    pushIssue(errors, 'approval_conflict_policy_drift', {
      expected: 'explicit user approval overrides agent/script/legacy/PR status',
    });
  }
}

function validateSoftbookRefs(errors, warnings) {
  const workspace = readJson('spec/workspace-contract.json');
  for (const ref of workspace.softbook_cet_authority_refs || []) {
    if (!exists(ref.path)) {
      pushIssue(errors, 'softbook_ref_missing', { path: ref.path });
      continue;
    }

    const refJson = readJson(ref.path);
    if (ref.expected_version && refJson.version !== ref.expected_version) {
      pushIssue(warnings, 'softbook_ref_version_changed', {
        path: ref.path,
        expected: ref.expected_version,
        actual: refJson.version,
      });
    }
  }

  const deprecated = workspace.legacy_status_policy?.deprecated_for_quality_approval || [];
  for (const field of ['production_status', 'contract_ready', 'needs_review']) {
    if (!deprecated.includes(field)) {
      pushIssue(errors, 'legacy_status_not_demoted', { field });
    }
  }

  if (workspace.legacy_status_policy?.replacement_authority !== 'reviews/approved_batches/ records plus explicit user confirmation') {
    pushIssue(errors, 'approval_replacement_authority_drift', {});
  }
}

function validateContentQuality(errors) {
  const quality = readJson('spec/content-quality-contract.json');
  if (quality.north_star?.final_approval_authority !== 'user_only') {
    pushIssue(errors, 'final_approval_authority_not_user_only', {});
  }

  const blockers = new Set((quality.blockers || []).map(blocker => blocker.id));
  for (const blocker of REQUIRED_BLOCKERS) {
    if (!blockers.has(blocker)) {
      pushIssue(errors, 'required_blocker_missing', { blocker });
    }
  }

  if (quality.tts_policy?.audio_generation_method !== 'TTS_AI_generated_by_default') {
    pushIssue(errors, 'tts_generation_policy_drift', {});
  }
  if (quality.tts_policy?.audio_source_type_is_separate_from_text_source_type !== true) {
    pushIssue(errors, 'tts_text_audio_separation_missing', {});
  }

  for (const prototype of [
    'knowledge_explanation',
    'solving_action',
    'error_correction',
    'context_input',
    'output_imitation',
    'exam_strategy',
    'integrated_micro_drill',
  ]) {
    if (!(quality.allowed_card_prototypes || []).includes(prototype)) {
      pushIssue(errors, 'card_prototype_missing', { prototype });
    }
  }
}

function validateMetadataSchema(errors) {
  const schema = readJson('spec/card-metadata.schema.json');
  const required = schema.properties?.quality_metadata?.required || [];
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!required.includes(field)) {
      pushIssue(errors, 'metadata_required_field_missing', { field });
    }
  }
}

function validateWorkflow(errors) {
  const workflow = readJson('spec/review-workflow.json');
  if (workflow.sample_policy?.default_size !== '3 cards per box') {
    pushIssue(errors, 'sample_size_policy_drift', {});
  }
  if (workflow.sample_policy?.batch_generation_requires !== 'user_confirmation_of_sample') {
    pushIssue(errors, 'batch_requires_user_confirmation_missing', {});
  }
  if (workflow.approval_record_policy?.required_for_formal_use !== true) {
    pushIssue(errors, 'approval_record_not_required', {});
  }
  for (const forbidden of [
    'declare_final_formal_usability',
    'batch_generate_before_user_confirms_sample',
    'delete_cards_without_user_confirmation',
    'auto_merge_harness_or_formal_content_PRs',
    'mix_harness_changes_with_bulk_card_content_changes',
  ]) {
    if (!(workflow.agent_permissions?.must_not || []).includes(forbidden)) {
      pushIssue(errors, 'agent_forbidden_permission_missing', { forbidden });
    }
  }
}

function validateReviewDirs(errors) {
  for (const dir of [
    'reviews/agent_self_review',
    'reviews/approved_batches',
    'reviews/drafts',
  ]) {
    const full = resolveWorkspacePath(dir);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      pushIssue(errors, 'review_dir_missing', { dir });
    }
  }
}

function validateEvalsAndPerturbation(errors) {
  const evals = readJson('spec/evals.json');
  const tasks = new Set((evals.golden_tasks || []).map(task => task.id));
  for (const id of ['GT-CARD-001', 'GT-CARD-002', 'GT-CARD-003']) {
    if (!tasks.has(id)) {
      pushIssue(errors, 'golden_task_missing', { id });
    }
  }

  const perturbation = readJson('spec/perturbation-audit.json');
  const guards = new Set((perturbation.anti_drift_guards || []).map(guard => guard.id));
  for (const id of ['PA-CARD-001', 'PA-CARD-002', 'PA-CARD-003', 'PA-CARD-004', 'PA-CARD-005', 'PA-CARD-006', 'PA-CARD-007']) {
    if (!guards.has(id)) {
      pushIssue(errors, 'anti_drift_guard_missing', { id });
    }
  }
}

const errors = [];
const warnings = [];

validateManifest(errors);
validateAuthorityMap(errors);
validateSoftbookRefs(errors, warnings);
validateContentQuality(errors);
validateMetadataSchema(errors);
validateWorkflow(errors);
validateReviewDirs(errors);
validateEvalsAndPerturbation(errors);

const result = {
  ok: errors.length === 0,
  errors,
  warnings,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
