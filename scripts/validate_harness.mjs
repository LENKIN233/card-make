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
  'box_progression_role',
  'review_status',
];

const REQUIRED_CARD_FIELDS = ['card_id', 'track', 'knowledge_ref', 'interaction_id', 'front', 'analysis'];
const CORE_INTERACTION_IDS = ['flip', 'multiple_choice', 'lock', 'elimination', 'swipe'];
const REQUIRED_GOLDEN_TASKS = ['GT-CARD-001', 'GT-CARD-002', 'GT-CARD-003', 'GT-CARD-004'];
const REQUIRED_SAMPLE_GATE_FIELDS = [
  'quality_metadata_per_card',
  'agent_self_review_record',
  'blocker_scan_per_card',
  'box_progression_roles',
  'no_standalone_hint_layer_interaction',
];
const REQUIRED_GIT_HANDOFF_FIELDS = [
  'branch',
  'base_branch',
  'commit_sha',
  'push_ref',
  'PR_url',
  'PR_state',
  'is_draft',
  'validation',
  'local_status',
  'remaining_risks',
  'merge_authority',
];

function resolveWorkspacePath(specPath) {
  return path.resolve(ROOT, specPath);
}

function readJson(specPath) {
  return JSON.parse(fs.readFileSync(resolveWorkspacePath(specPath), 'utf8'));
}

function readText(specPath) {
  return fs.readFileSync(resolveWorkspacePath(specPath), 'utf8');
}

function exists(specPath) {
  return fs.existsSync(resolveWorkspacePath(specPath));
}

function pushIssue(list, code, details) {
  list.push({ code, ...details });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(value => String(value)));
}

function setsEqual(leftValues, rightValues) {
  const left = stringSet(leftValues);
  const right = stringSet(rightValues);
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function isSubset(values, allowedValues) {
  const allowed = stringSet(allowedValues);
  for (const value of stringSet(values)) {
    if (!allowed.has(value)) return false;
  }
  return true;
}

function issueKey(issue) {
  return `${issue.library_id}.${issue.group_id}`;
}

function listLibraryGroups(doc) {
  const groups = new Map();
  for (const library of doc.libraries || []) {
    for (const group of library.groups || []) {
      groups.set(`${library.id}.${group.id}`, {
        library_id: String(library.id),
        library: library.name,
        group_id: String(group.id),
        group: group.name,
      });
    }
  }
  return groups;
}

function hasRequiredFixtureMetadata(card, errors, fixtureId) {
  for (const field of REQUIRED_CARD_FIELDS) {
    if (!card[field]) {
      pushIssue(errors, 'fixture_card_missing_required_field', {
        fixture: fixtureId,
        card_id: card.card_id,
        field,
      });
    }
  }

  const metadata = card.quality_metadata || {};
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (metadata[field] === undefined || metadata[field] === null) {
      pushIssue(errors, 'fixture_card_missing_quality_metadata', {
        fixture: fixtureId,
        card_id: card.card_id,
        field,
      });
    }
  }
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
    for (const key of ref.required_keys || []) {
      if (!(key in refJson)) {
        pushIssue(errors, 'softbook_ref_required_key_missing', {
          path: ref.path,
          key,
        });
      }
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

function validateUpstreamAlignment(errors, warnings) {
  const workspace = readJson('spec/workspace-contract.json');
  const recorded = workspace.upstream_alignment_policy?.known_group_alignment_issues || [];
  const recordedByKey = new Map(recorded.map(issue => [issueKey(issue), issue]));
  const knowledgeGroups = listLibraryGroups(readJson('../softbook_cet/spec/knowledge-map.json'));
  const catalogGroups = listLibraryGroups(readJson('../softbook_cet/spec/box-catalog.json'));
  const keys = new Set([...knowledgeGroups.keys(), ...catalogGroups.keys()]);
  const actualIssues = [];

  for (const key of [...keys].sort()) {
    const knowledge = knowledgeGroups.get(key);
    const catalog = catalogGroups.get(key);
    if (!knowledge || !catalog || knowledge.group !== catalog.group || knowledge.library !== catalog.library) {
      const [library_id, group_id] = key.split('.');
      actualIssues.push({
        library_id,
        group_id,
        knowledge_map_group: knowledge?.group || null,
        box_catalog_group: catalog?.group || null,
      });
    }
  }

  const actualByKey = new Map(actualIssues.map(issue => [issueKey(issue), issue]));
  for (const issue of actualIssues) {
    const known = recordedByKey.get(issueKey(issue));
    if (!known) {
      pushIssue(errors, 'unrecorded_upstream_group_alignment_issue', issue);
      continue;
    }
    if (
      known.status !== 'recorded_risk' ||
      known.knowledge_map_group !== issue.knowledge_map_group ||
      known.box_catalog_group !== issue.box_catalog_group
    ) {
      pushIssue(errors, 'upstream_group_alignment_record_drift', {
        actual: issue,
        recorded: known,
      });
    } else {
      pushIssue(warnings, 'recorded_upstream_group_alignment_issue', issue);
    }
  }

  for (const known of recorded) {
    if (!actualByKey.has(issueKey(known))) {
      pushIssue(errors, 'stale_upstream_group_alignment_record', known);
    }
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
  const rootRequired = schema.required || [];
  if (!rootRequired.includes('interaction_id')) {
    pushIssue(errors, 'metadata_root_interaction_id_not_required', {});
  }
  const interactionEnum = schema.properties?.interaction_id?.enum || [];
  for (const interactionId of CORE_INTERACTION_IDS) {
    if (!interactionEnum.includes(interactionId)) {
      pushIssue(errors, 'metadata_core_interaction_missing', { interactionId });
    }
  }
  if (interactionEnum.includes('hint_layer')) {
    pushIssue(errors, 'metadata_allows_hint_layer_as_standalone_interaction', {});
  }

  const required = schema.properties?.quality_metadata?.required || [];
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!required.includes(field)) {
      pushIssue(errors, 'metadata_required_field_missing', { field });
    }
  }
  if ((schema.properties?.quality_metadata?.properties?.review_status?.enum || []).includes('user_approved')) {
    pushIssue(errors, 'metadata_review_status_allows_user_approved', {});
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
  for (const field of REQUIRED_SAMPLE_GATE_FIELDS) {
    if (!(workflow.sample_quality_gate?.required_before_user_confirmation || []).includes(field)) {
      pushIssue(errors, 'sample_quality_gate_field_missing', { field });
    }
  }
  for (const field of ['explicit_user_confirmation', 'linked_agent_self_review_record', 'harness_validation', 'card_validation']) {
    if (!(workflow.sample_quality_gate?.approval_requires || []).includes(field)) {
      pushIssue(errors, 'sample_quality_gate_approval_requirement_missing', { field });
    }
  }
  if (workflow.sample_quality_gate?.quality_metadata_schema !== 'spec/card-metadata.schema.json') {
    pushIssue(errors, 'sample_quality_gate_schema_drift', {});
  }
  for (const forbidden of [
    'declare_final_formal_usability',
    'batch_generate_before_user_confirms_sample',
    'delete_cards_without_user_confirmation',
    'auto_merge_harness_or_formal_content_PRs',
    'auto_merge_without_user_authorization',
    'force_push_main_or_shared_base_branches',
    'mix_harness_changes_with_bulk_card_content_changes',
  ]) {
    if (!(workflow.agent_permissions?.must_not || []).includes(forbidden)) {
      pushIssue(errors, 'agent_forbidden_permission_missing', { forbidden });
    }
  }
  for (const allowed of [
    'manage_git_lifecycle_for_agent_authored_tracked_changes',
    'open_or_update_draft_PRs',
  ]) {
    if (!(workflow.agent_permissions?.may || []).includes(allowed)) {
      pushIssue(errors, 'agent_git_permission_missing', { allowed });
    }
  }
  if (workflow.git_policy?.contract !== 'spec/git-workflow.json') {
    pushIssue(errors, 'git_policy_contract_missing', {});
  }
  if (workflow.git_policy?.pre_edit_status_check !== 'required') {
    pushIssue(errors, 'git_pre_edit_status_check_not_required', {});
  }
  if (workflow.git_policy?.PR_merge !== 'manual_user_confirmation_required') {
    pushIssue(errors, 'git_PR_merge_policy_drift', {});
  }
}

function validateReviewDirs(errors) {
  for (const dir of [
    'reviews/agent_self_review',
    'reviews/approved_batches',
    'reviews/drafts',
    'reviews/git_handoffs',
  ]) {
    const full = resolveWorkspacePath(dir);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      pushIssue(errors, 'review_dir_missing', { dir });
    }
  }
}

function listReviewRecordFiles(dir) {
  const full = resolveWorkspacePath(dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(file => file.endsWith('.json') && file !== 'TEMPLATE.json')
    .sort()
    .map(file => `${dir}/${file}`);
}

function validateBlockerScan(scan, errors, source, { template }) {
  if (!scan || typeof scan !== 'object') {
    pushIssue(errors, 'review_record_missing_blocker_scan', { source });
    return;
  }
  for (const blocker of REQUIRED_BLOCKERS) {
    if (!hasOwn(scan, blocker)) {
      pushIssue(errors, 'review_record_blocker_scan_missing_blocker', { source, blocker });
    } else if (typeof scan[blocker] !== 'boolean') {
      pushIssue(errors, 'review_record_blocker_scan_not_boolean', { source, blocker });
    }
  }
}

function validateSelfReviewCard(card, errors, source, { template }) {
  for (const field of ['card_id', 'interaction_id', 'knowledge_ref', 'status', 'quality_metadata', 'blocker_scan']) {
    if (!hasOwn(card, field)) {
      pushIssue(errors, 'self_review_card_field_missing', { source, card_id: card.card_id, field });
    }
  }

  if (!template && card.interaction_id === 'hint_layer') {
    pushIssue(errors, 'self_review_card_hint_layer_standalone', { source, card_id: card.card_id });
  }
  if (!template && !CORE_INTERACTION_IDS.includes(card.interaction_id)) {
    pushIssue(errors, 'self_review_card_unknown_interaction', {
      source,
      card_id: card.card_id,
      interaction_id: card.interaction_id,
    });
  }
  if (!['pass', 'revise', 'block'].includes(card.status)) {
    pushIssue(errors, 'self_review_card_status_invalid', { source, card_id: card.card_id, status: card.status });
  }

  const metadata = card.quality_metadata || {};
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!hasOwn(metadata, field)) {
      pushIssue(errors, 'self_review_card_quality_metadata_missing', {
        source,
        card_id: card.card_id,
        field,
      });
    }
  }
  if (metadata.review_status === 'user_approved') {
    pushIssue(errors, 'self_review_card_claims_user_approval', { source, card_id: card.card_id });
  }
  validateBlockerScan(card.blocker_scan, errors, `${source}:${card.card_id || 'template-card'}`, { template });

  if (!template) {
    const quality = readJson('spec/content-quality-contract.json');
    const allowedWeakTags = new Set(quality.default_user_model?.weak_point_tags || []);
    const allowedDifficulties = new Set(quality.difficulty_policy?.tiers || []);
    const allowedPrototypes = new Set(quality.allowed_card_prototypes || []);
    const allowedSourceTypes = new Set(quality.source_policy?.allowed_text_source_types || []);
    const allowedProgressionRoles = new Set(['recognition', 'application', 'transfer', 'mixed']);

    if (!hasText(card.card_id)) pushIssue(errors, 'self_review_card_id_empty', { source });
    if (!hasText(metadata.main_training_goal)) {
      pushIssue(errors, 'self_review_card_main_goal_empty', { source, card_id: card.card_id });
    }
    if (!Array.isArray(metadata.weak_point_tags) || metadata.weak_point_tags.length === 0) {
      pushIssue(errors, 'self_review_card_weak_tags_empty', { source, card_id: card.card_id });
    }
    if (!hasText(metadata.exam_value)) {
      pushIssue(errors, 'self_review_card_exam_value_empty', { source, card_id: card.card_id });
    }
    for (const tag of metadata.weak_point_tags || []) {
      if (!allowedWeakTags.has(tag)) {
        pushIssue(errors, 'self_review_card_unknown_weak_point_tag', { source, card_id: card.card_id, tag });
      }
    }
    if (!allowedDifficulties.has(metadata.difficulty?.primary)) {
      pushIssue(errors, 'self_review_card_unknown_difficulty', {
        source,
        card_id: card.card_id,
        difficulty: metadata.difficulty?.primary,
      });
    }
    for (const difficulty of metadata.difficulty?.secondary || []) {
      if (!allowedDifficulties.has(difficulty)) {
        pushIssue(errors, 'self_review_card_unknown_secondary_difficulty', { source, card_id: card.card_id, difficulty });
      }
    }
    if (!allowedPrototypes.has(metadata.card_prototype)) {
      pushIssue(errors, 'self_review_card_unknown_prototype', { source, card_id: card.card_id, prototype: metadata.card_prototype });
    }
    if (!allowedSourceTypes.has(metadata.material?.text_source_type)) {
      pushIssue(errors, 'self_review_card_unknown_source_type', {
        source,
        card_id: card.card_id,
        sourceType: metadata.material?.text_source_type,
      });
    }
    if (!allowedProgressionRoles.has(metadata.box_progression_role)) {
      pushIssue(errors, 'self_review_card_unknown_progression_role', {
        source,
        card_id: card.card_id,
        role: metadata.box_progression_role,
      });
    }
    const hasBlocker = Object.values(card.blocker_scan || {}).some(Boolean);
    if (card.status === 'pass' && hasBlocker) {
      pushIssue(errors, 'self_review_pass_card_has_blocker', { source, card_id: card.card_id });
    }
  }
}

function validateSelfReviewRecord(record, errors, source, { template = false } = {}) {
  if (record.sample_policy?.is_three_card_sample_per_box !== true) {
    pushIssue(errors, 'self_review_sample_policy_not_three_card', { source });
  }
  if (record.sample_policy?.batch_generation_requires_user_confirmation !== true) {
    pushIssue(errors, 'self_review_sample_policy_user_confirmation_missing', { source });
  }

  const cards = record.cards || [];
  if (!Array.isArray(cards) || cards.length === 0) {
    pushIssue(errors, 'self_review_cards_missing', { source });
    return;
  }

  for (const card of cards) validateSelfReviewCard(card, errors, source, { template });

  if (!template) {
    const boxPrefixes = record.scope?.box_prefixes || [];
    const scopeCardIds = record.scope?.card_ids || [];
    const expectedCards = Math.max(1, boxPrefixes.length) * 3;
    for (const field of ['library', 'group', 'box']) {
      if (!hasText(record.scope?.[field])) {
        pushIssue(errors, 'self_review_scope_field_missing', { source, field });
      }
    }
    if (!Array.isArray(boxPrefixes) || boxPrefixes.length === 0) {
      pushIssue(errors, 'self_review_scope_box_prefixes_missing', { source });
    }
    if (!Array.isArray(scopeCardIds) || scopeCardIds.length === 0) {
      pushIssue(errors, 'self_review_scope_card_ids_missing', { source });
    } else if (!setsEqual(scopeCardIds, cards.map(card => card.card_id))) {
      pushIssue(errors, 'self_review_scope_card_ids_mismatch', {
        source,
        scopeCardIds,
        actualCardIds: cards.map(card => card.card_id),
      });
    }
    if (cards.length !== expectedCards) {
      pushIssue(errors, 'self_review_sample_card_count_not_three_per_box', {
        source,
        expectedCards,
        actualCards: cards.length,
      });
    }
    if (!Array.isArray(record.specs_read) || record.specs_read.length === 0) {
      pushIssue(errors, 'self_review_specs_read_missing', { source });
    }
    if (!record.batch_review || !['recommend_user_confirmation', 'revise_before_user_review', 'blocked'].includes(record.batch_review.status)) {
      pushIssue(errors, 'self_review_batch_status_invalid', { source, status: record.batch_review?.status });
    }
    if (record.batch_review?.status === 'recommend_user_confirmation') {
      const anyBlocked = cards.some(card => card.status !== 'pass' || Object.values(card.blocker_scan || {}).some(Boolean));
      if (anyBlocked) pushIssue(errors, 'self_review_recommends_confirmation_with_blocked_card', { source });
    }
  }
}

function validateApprovalRecord(record, errors, source, { template = false } = {}) {
  if (record.approved_by_user !== true) {
    pushIssue(errors, 'approval_record_not_user_approved', { source });
  }
  for (const field of ['approved_at', 'scope', 'summary', 'representative_cards', 'validation']) {
    if (!hasOwn(record, field)) {
      pushIssue(errors, 'approval_record_field_missing', { source, field });
    }
  }
  if (!Array.isArray(record.approval_limits) || record.approval_limits.length < 3) {
    pushIssue(errors, 'approval_record_limits_missing', { source });
  }
  if (!template) {
    for (const field of ['library', 'group', 'box']) {
      if (!hasText(record.scope?.[field])) {
        pushIssue(errors, 'approval_record_scope_field_missing', { source, field });
      }
    }
    if (!Array.isArray(record.scope?.box_prefixes) || record.scope.box_prefixes.length === 0) {
      pushIssue(errors, 'approval_record_scope_box_prefixes_missing', { source });
    }
    if (!Array.isArray(record.scope?.card_ids) || record.scope.card_ids.length === 0) {
      pushIssue(errors, 'approval_record_scope_card_ids_missing', { source });
    }
    const linkedReview = record.validation?.agent_self_review;
    let selfReview = null;
    if (!hasText(linkedReview)) {
      pushIssue(errors, 'approval_record_missing_agent_self_review', { source });
    } else if (!exists(linkedReview)) {
      pushIssue(errors, 'approval_record_agent_self_review_missing_on_disk', { source, linkedReview });
    } else {
      selfReview = readJson(linkedReview);
      const selfReviewErrors = [];
      validateSelfReviewRecord(selfReview, selfReviewErrors, linkedReview);
      if (selfReviewErrors.length > 0) {
        pushIssue(errors, 'approval_record_linked_self_review_invalid', {
          source,
          linkedReview,
          linkedErrors: selfReviewErrors.map(issue => issue.code),
        });
      }
    }
    if (!hasText(record.validation?.harness)) {
      pushIssue(errors, 'approval_record_harness_validation_missing', { source });
    }
    if (!hasText(record.validation?.cards)) {
      pushIssue(errors, 'approval_record_card_validation_missing', { source });
    }
    if (selfReview) {
      if (selfReview.batch_review?.status !== 'recommend_user_confirmation') {
        pushIssue(errors, 'approval_record_self_review_not_recommended', {
          source,
          linkedReview,
          status: selfReview.batch_review?.status,
        });
      }
      for (const field of ['library', 'group', 'box']) {
        if (record.scope?.[field] !== selfReview.scope?.[field]) {
          pushIssue(errors, 'approval_record_scope_mismatch', {
            source,
            linkedReview,
            field,
            approval: record.scope?.[field],
            selfReview: selfReview.scope?.[field],
          });
        }
      }
      for (const field of ['box_prefixes', 'card_ids']) {
        if (!setsEqual(record.scope?.[field], selfReview.scope?.[field])) {
          pushIssue(errors, 'approval_record_scope_mismatch', {
            source,
            linkedReview,
            field,
            approval: record.scope?.[field] || [],
            selfReview: selfReview.scope?.[field] || [],
          });
        }
      }
    }
    if (!isSubset(record.representative_cards, record.scope?.card_ids)) {
      pushIssue(errors, 'approval_record_representative_cards_outside_scope', { source });
    }
  }
}

function validateReviewTemplatesAndRecords(errors) {
  validateSelfReviewRecord(readJson('reviews/agent_self_review/TEMPLATE.json'), errors, 'reviews/agent_self_review/TEMPLATE.json', {
    template: true,
  });
  validateApprovalRecord(readJson('reviews/approved_batches/TEMPLATE.json'), errors, 'reviews/approved_batches/TEMPLATE.json', {
    template: true,
  });

  for (const file of listReviewRecordFiles('reviews/agent_self_review')) {
    validateSelfReviewRecord(readJson(file), errors, file);
  }
  for (const file of listReviewRecordFiles('reviews/approved_batches')) {
    validateApprovalRecord(readJson(file), errors, file);
  }
}

function validateInteractionPolicy(errors) {
  const cardSystem = readJson('../softbook_cet/spec/card-system.json');
  const interactions = readJson('../softbook_cet/spec/interactions.json');
  const hintLayer = (interactions.interactions || []).find(interaction => interaction.id === 'hint_layer');
  if (hintLayer?.kind !== 'enhancement') {
    pushIssue(errors, 'hint_layer_not_marked_enhancement', { kind: hintLayer?.kind });
  }
  if (!(cardSystem.forbidden || []).includes('hint_as_standalone_card_type')) {
    pushIssue(errors, 'card_system_does_not_forbid_standalone_hint_layer', {});
  }

  const structuralValidator = readText('scripts/validate_cards.mjs');
  if (!structuralValidator.includes('hint_layer_as_standalone_interaction')) {
    pushIssue(errors, 'card_validator_missing_hint_layer_standalone_guard', {});
  }
  if (/CORE_INTERACTIONS\s*=\s*new Set\(\[[^\]]*hint_layer/.test(structuralValidator)) {
    pushIssue(errors, 'card_validator_core_interactions_include_hint_layer', {});
  }
}

function validateGitWorkflow(errors) {
  const gitWorkflow = readJson('spec/git-workflow.json');
  const agentEntry = readText('AGENTS.md');
  const handoffTemplate = readJson('reviews/git_handoffs/TEMPLATE.json');

  if (gitWorkflow.status !== 'active') {
    pushIssue(errors, 'git_workflow_not_active', { status: gitWorkflow.status });
  }
  if (!agentEntry.includes('## Agent-Managed Git')) {
    pushIssue(errors, 'agent_entry_missing_git_section', {});
  }
  if (!agentEntry.includes('commit, push, and open or update a draft PR')) {
    pushIssue(errors, 'agent_entry_missing_git_completion_rule', {});
  }

  for (const owned of ['pre_edit_git_status_check', 'commit', 'push', 'open_or_update_draft_PR', 'publish_handoff']) {
    if (!(gitWorkflow.authority_boundary?.agent_owns || []).includes(owned)) {
      pushIssue(errors, 'git_agent_owned_step_missing', { owned });
    }
  }
  for (const reserved of ['formal_content_approval', 'harness_or_formal_content_PR_merge_unless_explicitly_delegated']) {
    if (!(gitWorkflow.authority_boundary?.user_reserves || []).includes(reserved)) {
      pushIssue(errors, 'git_user_reserved_authority_missing', { reserved });
    }
  }

  if (gitWorkflow.pre_edit_check?.required !== true) {
    pushIssue(errors, 'git_pre_edit_check_not_required', {});
  }
  if (!(gitWorkflow.pre_edit_check?.commands || []).includes('git status --short --branch')) {
    pushIssue(errors, 'git_pre_edit_status_command_missing', {});
  }

  for (const prefix of ['harness/', 'content/', 'fix/', 'tooling/']) {
    if (!(gitWorkflow.branch_policy?.preferred_prefixes || []).includes(prefix)) {
      pushIssue(errors, 'git_branch_prefix_missing', { prefix });
    }
  }
  if (gitWorkflow.branch_policy?.force_push_shared_base_branches !== 'forbidden') {
    pushIssue(errors, 'git_force_push_shared_base_not_forbidden', {});
  }
  if (gitWorkflow.branch_policy?.stacked_PRs_allowed !== true) {
    pushIssue(errors, 'git_stacked_PRs_not_allowed', {});
  }

  for (const condition of ['same_requirement_domain', 'same_base_branch', 'same_review_unit']) {
    if (!(gitWorkflow.existing_PR_policy?.update_existing_when || []).includes(condition)) {
      pushIssue(errors, 'git_existing_PR_update_condition_missing', { condition });
    }
  }
  for (const condition of ['new_requirement_domain', 'different_base_branch', 'existing_PR_scope_would_blur']) {
    if (!(gitWorkflow.existing_PR_policy?.create_new_when || []).includes(condition)) {
      pushIssue(errors, 'git_new_PR_condition_missing', { condition });
    }
  }

  const validationCommands = (gitWorkflow.validation_policy?.before_commit || []).map(entry => entry.command);
  for (const command of ['node scripts/validate_harness.mjs', 'node scripts/validate_cards.mjs --write-report', 'git diff --check']) {
    if (!validationCommands.includes(command)) {
      pushIssue(errors, 'git_validation_command_missing', { command });
    }
  }
  if (gitWorkflow.completion_policy?.agent_authored_tracked_changes_default !== 'validated_commit_push_draft_PR') {
    pushIssue(errors, 'git_completion_default_drift', {});
  }
  for (const exception of ['small_samples_for_user_review', 'read_only_audits', 'explicit_user_local_only_request']) {
    if (!(gitWorkflow.completion_policy?.local_only_exceptions || []).includes(exception)) {
      pushIssue(errors, 'git_local_only_exception_missing', { exception });
    }
  }
  if (gitWorkflow.merge_policy?.default !== 'manual_user_confirmation_required') {
    pushIssue(errors, 'git_merge_default_drift', {});
  }
  for (const condition of ['formal_content_not_user_approved', 'validator_failing', 'PR_scope_mixes_harness_and_bulk_content']) {
    if (!(gitWorkflow.merge_policy?.never_merge_when || []).includes(condition)) {
      pushIssue(errors, 'git_never_merge_condition_missing', { condition });
    }
  }

  if (gitWorkflow.handoff_policy?.directory !== 'reviews/git_handoffs/') {
    pushIssue(errors, 'git_handoff_directory_drift', {});
  }
  for (const field of REQUIRED_GIT_HANDOFF_FIELDS) {
    if (!(gitWorkflow.handoff_policy?.required_fields || []).includes(field)) {
      pushIssue(errors, 'git_handoff_required_field_missing', { field });
    }
    if (!(field in handoffTemplate)) {
      pushIssue(errors, 'git_handoff_template_field_missing', { field });
    }
  }
  if (handoffTemplate.merge_authority !== 'manual_user_confirmation_required') {
    pushIssue(errors, 'git_handoff_template_merge_authority_drift', {});
  }
}

function validateEvalsAndPerturbation(errors) {
  const evals = readJson('spec/evals.json');
  const tasks = new Set((evals.golden_tasks || []).map(task => task.id));
  for (const id of REQUIRED_GOLDEN_TASKS) {
    if (!tasks.has(id)) {
      pushIssue(errors, 'golden_task_missing', { id });
    }
  }
  if (evals.fixture_suite !== 'spec/eval-fixtures.json') {
    pushIssue(errors, 'eval_fixture_suite_missing', {});
  }

  const perturbation = readJson('spec/perturbation-audit.json');
  const guards = new Set((perturbation.anti_drift_guards || []).map(guard => guard.id));
  for (const id of ['PA-CARD-001', 'PA-CARD-002', 'PA-CARD-003', 'PA-CARD-004', 'PA-CARD-005', 'PA-CARD-006', 'PA-CARD-007', 'PA-CARD-008']) {
    if (!guards.has(id)) {
      pushIssue(errors, 'anti_drift_guard_missing', { id });
    }
  }
}

function validateEvalFixtures(errors) {
  const fixtures = readJson('spec/eval-fixtures.json');
  if (fixtures.status !== 'active') {
    pushIssue(errors, 'eval_fixtures_not_active', { status: fixtures.status });
  }

  const quality = readJson('spec/content-quality-contract.json');
  const allowedWeakTags = new Set(quality.default_user_model?.weak_point_tags || []);
  const allowedDifficulties = new Set(quality.difficulty_policy?.tiers || []);
  const allowedPrototypes = new Set(quality.allowed_card_prototypes || []);
  const allowedSourceTypes = new Set(quality.source_policy?.allowed_text_source_types || []);
  const blockers = new Set((quality.blockers || []).map(blocker => blocker.id));
  const cases = fixtures.fixture_cases || [];
  const caseTasks = new Set(cases.map(testCase => testCase.golden_task_id));

  for (const id of REQUIRED_GOLDEN_TASKS) {
    if (!caseTasks.has(id)) {
      pushIssue(errors, 'golden_task_fixture_missing', { id });
    }
  }

  for (const testCase of cases) {
    const cards = testCase.cards || [];
    const expected = testCase.expected_outcome || {};
    if (expected.formal_use_claimed !== false) {
      pushIssue(errors, 'fixture_claims_formal_use', { fixture: testCase.id });
    }

    if (testCase.type === 'approval_record') {
      if (testCase.golden_task_id !== 'GT-CARD-004') {
        pushIssue(errors, 'approval_fixture_wrong_golden_task', { fixture: testCase.id });
      }
      if (expected.approval_status !== 'block') {
        pushIssue(errors, 'sample_gate_fixture_not_blocking_approval', { fixture: testCase.id });
      }
      const gateErrors = [];
      validateApprovalRecord(testCase.approval_record || {}, gateErrors, `${testCase.id}.approval_record`);
      const actualGateCodes = new Set(gateErrors.map(issue => issue.code));
      for (const expectedGateError of expected.expected_gate_errors || []) {
        if (!actualGateCodes.has(expectedGateError)) {
          pushIssue(errors, 'sample_gate_fixture_expected_error_not_triggered', {
            fixture: testCase.id,
            expectedGateError,
            actualGateErrors: [...actualGateCodes],
          });
        }
      }
      for (const actualGateCode of actualGateCodes) {
        if (!(expected.expected_gate_errors || []).includes(actualGateCode)) {
          pushIssue(errors, 'sample_gate_fixture_unexpected_gate_error', {
            fixture: testCase.id,
            actualGateCode,
          });
        }
      }
      continue;
    }

    if (testCase.type === 'sample_batch') {
      if (cards.length !== 3) {
        pushIssue(errors, 'sample_fixture_not_three_cards', { fixture: testCase.id, count: cards.length });
      }
      const roles = cards.map(card => card.quality_metadata?.box_progression_role);
      for (const role of expected.box_progression || []) {
        if (!roles.includes(role)) {
          pushIssue(errors, 'sample_fixture_missing_progression_role', { fixture: testCase.id, role });
        }
      }
      const targetPrefix = testCase.target?.box_prefix;
      for (const card of cards) {
        if (card.knowledge_ref?.box_prefix !== targetPrefix) {
          pushIssue(errors, 'sample_fixture_card_outside_target_box', {
            fixture: testCase.id,
            card_id: card.card_id,
            targetPrefix,
            actualPrefix: card.knowledge_ref?.box_prefix,
          });
        }
      }
    }

    const expectedBlockers = expected.expected_blockers || [];
    for (const blocker of expectedBlockers) {
      if (!blockers.has(blocker)) {
        pushIssue(errors, 'fixture_unknown_expected_blocker', { fixture: testCase.id, blocker });
      }
      if (expected.blocker_scan?.[blocker] !== true) {
        pushIssue(errors, 'fixture_expected_blocker_not_marked', { fixture: testCase.id, blocker });
      }
    }

    if (testCase.golden_task_id === 'GT-CARD-002') {
      const material = cards[0]?.quality_metadata?.material || {};
      if (material.audio_generation_method !== 'TTS_AI_generated') {
        pushIssue(errors, 'tts_fixture_missing_tts_generation_method', { fixture: testCase.id });
      }
      if (testCase.fixture_flags?.conflates_tts_with_source_authenticity !== true) {
        pushIssue(errors, 'tts_fixture_missing_source_conflation_flag', { fixture: testCase.id });
      }
      if (!expectedBlockers.includes('fake_source_claim')) {
        pushIssue(errors, 'tts_fixture_missing_fake_source_claim_blocker', { fixture: testCase.id });
      }
    }

    if (testCase.golden_task_id === 'GT-CARD-003') {
      if (testCase.fixture_flags?.front_stands_alone !== false) {
        pushIssue(errors, 'reverse_front_fixture_missing_independence_flag', { fixture: testCase.id });
      }
      if (!expectedBlockers.includes('reverse_engineered_front')) {
        pushIssue(errors, 'reverse_front_fixture_missing_blocker', { fixture: testCase.id });
      }
    }

    for (const card of cards) {
      hasRequiredFixtureMetadata(card, errors, testCase.id);
      const metadata = card.quality_metadata || {};
      for (const tag of metadata.weak_point_tags || []) {
        if (!allowedWeakTags.has(tag)) {
          pushIssue(errors, 'fixture_card_unknown_weak_point_tag', {
            fixture: testCase.id,
            card_id: card.card_id,
            tag,
          });
        }
      }
      if (!allowedDifficulties.has(metadata.difficulty?.primary)) {
        pushIssue(errors, 'fixture_card_unknown_difficulty', {
          fixture: testCase.id,
          card_id: card.card_id,
          difficulty: metadata.difficulty?.primary,
        });
      }
      for (const difficulty of metadata.difficulty?.secondary || []) {
        if (!allowedDifficulties.has(difficulty)) {
          pushIssue(errors, 'fixture_card_unknown_secondary_difficulty', {
            fixture: testCase.id,
            card_id: card.card_id,
            difficulty,
          });
        }
      }
      if (!allowedPrototypes.has(metadata.card_prototype)) {
        pushIssue(errors, 'fixture_card_unknown_prototype', {
          fixture: testCase.id,
          card_id: card.card_id,
          prototype: metadata.card_prototype,
        });
      }
      if (!allowedSourceTypes.has(metadata.material?.text_source_type)) {
        pushIssue(errors, 'fixture_card_unknown_source_type', {
          fixture: testCase.id,
          card_id: card.card_id,
          sourceType: metadata.material?.text_source_type,
        });
      }
      if (metadata.review_status === 'user_approved') {
        pushIssue(errors, 'fixture_card_claims_user_approval', {
          fixture: testCase.id,
          card_id: card.card_id,
        });
      }
    }
  }
}

const errors = [];
const warnings = [];

validateManifest(errors);
validateAuthorityMap(errors);
validateSoftbookRefs(errors, warnings);
validateUpstreamAlignment(errors, warnings);
validateContentQuality(errors);
validateMetadataSchema(errors);
validateWorkflow(errors);
validateReviewDirs(errors);
validateReviewTemplatesAndRecords(errors);
validateInteractionPolicy(errors);
validateGitWorkflow(errors);
validateEvalsAndPerturbation(errors);
validateEvalFixtures(errors);

const result = {
  ok: errors.length === 0,
  errors,
  warnings,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
