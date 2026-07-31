#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKLIST_SCHEMA = 'audio-perceptual-worklist.v1';
const TECHNICAL_AUDIT_SCHEMA = 'audio-technical-audit.v1';
const SHA256_RE = /^[0-9a-f]{64}$/;
const REVIEW_STATUSES = new Set(['pending', 'in_progress', 'passed', 'failed']);
const CHECK_STATES = new Set(['pending', 'pass', 'fail']);
export const PERCEPTUAL_CHECKS = Object.freeze([
  'audio_matches_text',
  'target_signal_audible',
  'accurate_pronunciation',
  'suitable_speed',
  'natural_rhythm',
  'stress_and_pauses_do_not_mislead',
  'no_unwanted_noise_or_clipping',
]);
const FAILURE_CODE_BY_CHECK = Object.freeze({
  audio_matches_text: 'audio_text_mismatch',
  target_signal_audible: 'target_signal_missing_or_misleading',
  accurate_pronunciation: 'pronunciation_error',
  suitable_speed: 'speed_unsuitable',
  natural_rhythm: 'rhythm_unnatural',
  stress_and_pauses_do_not_mislead: 'stress_or_pause_misleading',
  no_unwanted_noise_or_clipping: 'noise_or_clipping',
});

export function buildAudioPerceptualWorklist({
  allowReviewedReset = false,
  clock = () => new Date(),
  existing = null,
  root = ROOT,
  technicalAudit,
  technicalAuditPath,
  track = 'cet4',
} = {}) {
  requireTrack(track);
  const contexts = collectAudioCardContexts(root, track);
  const auditFile = technicalAuditPath
    ? requireRegularFile(technicalAuditPath, root)
    : null;
  const audit = technicalAudit ?? readJson(auditFile);
  const auditPath = auditFile
    ? relativeToRoot(auditFile, root)
    : 'in-memory-technical-audit.json';
  const auditBytes = auditFile
    ? fs.readFileSync(auditFile)
    : Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  const auditErrors = validateTechnicalAudit(audit, contexts, root, track);
  if (auditErrors.length > 0) {
    throw new Error(`Technical audio audit is invalid: ${auditErrors.join('; ')}`);
  }

  const auditByCard = new Map(audit.assets.map(asset => [String(asset.card_id), asset]));
  const existingByCard = new Map(
    Array.isArray(existing?.entries)
      ? existing.entries.map(entry => [String(entry.card_id), entry])
      : [],
  );
  let preservedReviews = 0;
  let resetReviews = 0;
  const entries = contexts.map((context, index) => {
    const auditAsset = auditByCard.get(context.card_id);
    const identity = {
      card_id: context.card_id,
      card_source_file: context.card_source_file,
      knowledge_ref: context.knowledge_ref,
      training_context: context.training_context,
      audio: {
        asset_path: auditAsset.asset_path,
        file_sha256: auditAsset.file_sha256,
        size_bytes: auditAsset.size_bytes,
        declared_duration_ms: auditAsset.declared_duration_ms,
        probed_duration_ms: auditAsset.technical.duration_ms,
        transcript: context.transcript,
        transcript_sha256: auditAsset.transcript_sha256,
      },
    };
    const entryIdentity = sha256(canonicalStringify(identity));
    const prior = existingByCard.get(context.card_id);
    let checks = pendingChecks();
    let review = pendingReview();
    if (
      prior &&
      prior.entry_identity_sha256 === entryIdentity &&
      prior.review?.status !== 'pending'
    ) {
      checks = structuredClone(prior.checks);
      review = structuredClone(prior.review);
      preservedReviews += 1;
    } else if (prior?.review?.status && prior.review.status !== 'pending') {
      if (!allowReviewedReset) {
        throw new Error(
          `Reviewed audio identity changed for ${context.card_id}; rerun with --allow-reviewed-reset only after human acknowledgement.`,
        );
      }
      resetReviews += 1;
    }
    return {
      sequence: index + 1,
      ...identity,
      entry_identity_sha256: entryIdentity,
      checks,
      review,
    };
  });

  const now = asIso(clock());
  const worklist = {
    schema_version: WORKLIST_SCHEMA,
    worklist_id: `${track}-current-audio-perceptual-qc`,
    generated_at: now,
    track,
    authority_boundary:
      'operational human-listening queue only; pending or completed entries do not approve card content, prove text source authenticity, or replace reviews/audio_qc formal evidence',
    review_policy: {
      review_mode: 'human_perceptual_qc',
      agent_may_mark_passed: false,
      one_card_per_review_action: true,
      full_asset_listening_attestation_required: true,
      all_checks_required_before_terminal_status: true,
      failed_audio_requires_replacement: true,
      terminal_review_immutable: true,
      passing_worklist_is_not_formal_audio_qc: true,
    },
    source_technical_audit: {
      path: auditPath,
      schema_version: audit.schema_version,
      file_sha256: sha256(auditBytes),
      generated_at: audit.generated_at,
      assets_fingerprint: sha256(canonicalStringify(audit.assets)),
    },
    corpus_fingerprint: sha256(
      canonicalStringify(entries.map(entry => entry.entry_identity_sha256)),
    ),
    context_quality: summarizeContextQuality(entries),
    progress: summarizeEntries(entries),
    entries,
  };
  const errors = validateAudioPerceptualWorklist(worklist, {
    root,
    technicalAudit: audit,
  });
  if (errors.length > 0) {
    throw new Error(`Generated perceptual worklist is invalid: ${errors.join('; ')}`);
  }
  return {worklist, preserved_reviews: preservedReviews, reset_reviews: resetReviews};
}

export function reviewAudioPerceptualEntry({
  cardId,
  checkUpdates,
  clock = () => new Date(),
  listenedToEntireAsset = false,
  notes = null,
  reviewer,
  worklist,
} = {}) {
  if (!isHumanReviewer(reviewer)) {
    throw new Error('Reviewer must identify a human github, team, or external reviewer.');
  }
  if (listenedToEntireAsset !== true) {
    throw new Error('Review requires explicit full-asset listening attestation.');
  }
  if (!Array.isArray(checkUpdates) || checkUpdates.length === 0) {
    throw new Error('At least one --check name=pass|fail update is required.');
  }
  const entry = worklist?.entries?.find(candidate => candidate.card_id === String(cardId));
  if (!entry) throw new Error(`Audio worklist card ${String(cardId)} does not exist.`);
  if (['passed', 'failed'].includes(entry.review.status)) {
    throw new Error('Terminal audio review entries cannot be overwritten.');
  }
  if (entry.review.reviewer && entry.review.reviewer !== reviewer) {
    throw new Error('An in-progress audio review must be continued by the same reviewer.');
  }
  const updated = structuredClone(worklist);
  const target = updated.entries.find(candidate => candidate.card_id === String(cardId));
  for (const update of checkUpdates) {
    if (!PERCEPTUAL_CHECKS.includes(update.name) || !['pass', 'fail'].includes(update.value)) {
      throw new Error(`Invalid perceptual check update ${update.name}=${update.value}.`);
    }
    target.checks[update.name] = update.value;
  }
  const now = asIso(clock());
  target.review.reviewer = reviewer;
  target.review.listening_attestation =
    'listened_to_entire_asset_with_transcript_and_target_context';
  target.review.started_at ??= now;
  if (notes !== null) target.review.notes = String(notes).trim();
  const states = Object.values(target.checks);
  const complete = states.every(state => state === 'pass' || state === 'fail');
  if (!complete) {
    target.review.status = 'in_progress';
    target.review.completed_at = null;
    target.review.failure_codes = failedChecks(target.checks).map(
      check => FAILURE_CODE_BY_CHECK[check],
    );
    target.review.replacement_required = null;
  } else if (states.includes('fail')) {
    if (!target.review.notes) throw new Error('Failed audio review requires notes.');
    target.review.status = 'failed';
    target.review.completed_at = now;
    target.review.failure_codes = failedChecks(target.checks).map(
      check => FAILURE_CODE_BY_CHECK[check],
    );
    target.review.replacement_required = true;
  } else {
    target.review.status = 'passed';
    target.review.completed_at = now;
    target.review.failure_codes = [];
    target.review.replacement_required = false;
  }
  updated.progress = summarizeEntries(updated.entries);
  return updated;
}

export function validateAudioPerceptualWorklist(
  worklist,
  {requireComplete = false, root = ROOT, technicalAudit = null} = {},
) {
  const errors = [];
  exactKeys(
    worklist,
    [
      'schema_version',
      'worklist_id',
      'generated_at',
      'track',
      'authority_boundary',
      'review_policy',
      'source_technical_audit',
      'corpus_fingerprint',
      'context_quality',
      'progress',
      'entries',
    ],
    'worklist',
    errors,
  );
  if (worklist?.schema_version !== WORKLIST_SCHEMA) errors.push('schema_version is invalid');
  try {
    requireTrack(worklist?.track);
  } catch (error) {
    errors.push(error.message);
  }
  if (!isIso(worklist?.generated_at)) errors.push('generated_at is invalid');
  if (worklist?.worklist_id !== `${worklist?.track}-current-audio-perceptual-qc`) {
    errors.push('worklist_id is invalid');
  }
  if (
    typeof worklist?.authority_boundary !== 'string' ||
    !worklist.authority_boundary.includes('do not approve card content')
  ) {
    errors.push('authority_boundary is missing');
  }
  validateReviewPolicy(worklist?.review_policy, errors);
  validateTechnicalAuditReference(worklist?.source_technical_audit, errors);

  if (!Array.isArray(worklist?.entries) || worklist.entries.length === 0) {
    errors.push('entries must be a non-empty array');
  } else {
    const seenCards = new Set();
    const seenAssets = new Set();
    for (let index = 0; index < worklist.entries.length; index += 1) {
      validateEntry(worklist.entries[index], index, seenCards, seenAssets, root, errors);
    }
    const expectedCorpusFingerprint = sha256(
      canonicalStringify(worklist.entries.map(entry => entry.entry_identity_sha256)),
    );
    if (worklist.corpus_fingerprint !== expectedCorpusFingerprint) {
      errors.push('corpus_fingerprint does not match entries');
    }
    const expectedProgress = summarizeEntries(worklist.entries);
    if (canonicalStringify(worklist.progress) !== canonicalStringify(expectedProgress)) {
      errors.push('progress does not match entries');
    }
    if (requireComplete && expectedProgress.complete !== true) {
      errors.push('worklist is not complete');
    }
    const expectedContextQuality = summarizeContextQuality(worklist.entries);
    if (
      canonicalStringify(worklist.context_quality) !==
      canonicalStringify(expectedContextQuality)
    ) {
      errors.push('context_quality does not match entries');
    }
  }

  if (technicalAudit) {
    const contexts = collectAudioCardContexts(root, worklist.track);
    for (const error of validateTechnicalAudit(technicalAudit, contexts, root, worklist.track)) {
      errors.push(`technical audit: ${error}`);
    }
    if (
      worklist.source_technical_audit?.assets_fingerprint !==
      sha256(canonicalStringify(technicalAudit.assets))
    ) {
      errors.push('technical audit assets_fingerprint does not match');
    }
    const auditByCard = new Map(
      technicalAudit.assets.map(asset => [String(asset.card_id), asset]),
    );
    if (worklist.entries.length !== contexts.length) {
      errors.push('worklist entry count does not match current audio cards');
    }
    for (const context of contexts) {
      const entry = worklist.entries.find(candidate => candidate.card_id === context.card_id);
      const asset = auditByCard.get(context.card_id);
      if (!entry || !asset) continue;
      const expectedIdentity = entryIdentityFrom(context, asset);
      if (entry.entry_identity_sha256 !== sha256(canonicalStringify(expectedIdentity))) {
        errors.push(`entry ${context.card_id} does not match current corpus and audit`);
      }
    }
  }
  return errors;
}

export function collectAudioCardContexts(root = ROOT, track = 'cet4') {
  requireTrack(track);
  const directory = path.join(root, 'card_boxes_json');
  const contexts = [];
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const relativeFile = `card_boxes_json/${filename}`;
    const document = readJson(path.join(root, relativeFile));
    if (document.track !== track) continue;
    for (const card of document.cards || []) {
      const assetPath = card.audio?.path || card.audio?.url;
      if (!assetPath) continue;
      const transcript = typeof card.audio?.transcript === 'string' ? card.audio.transcript.trim() : '';
      contexts.push({
        card_id: String(card.card_id),
        card_source_file: relativeFile,
        asset_path: assetPath,
        transcript,
        transcript_sha256: sha256(transcript),
        knowledge_ref: {
          library_id: String(card.knowledge_ref?.library_id ?? card.library ?? ''),
          library_name: String(card.knowledge_ref?.library_name ?? ''),
          group_id: String(card.knowledge_ref?.group_id ?? card.group ?? ''),
          group_name: String(card.knowledge_ref?.group_name ?? card.card_group_name ?? ''),
          box_id: String(card.knowledge_ref?.box_id ?? card.box ?? ''),
          box_name: String(card.knowledge_ref?.box_name ?? card.card_box_name ?? ''),
          box_prefix: String(card.knowledge_ref?.box_prefix ?? card.card_box_code ?? ''),
        },
        training_context: {
          main_training_goal: textOrNull(card.quality_metadata?.main_training_goal),
          box_progression_role: textOrNull(card.quality_metadata?.box_progression_role),
        },
      });
    }
  }
  return contexts.sort((left, right) => left.card_id.localeCompare(right.card_id));
}

function entryIdentityFrom(context, auditAsset) {
  return {
    card_id: context.card_id,
    card_source_file: context.card_source_file,
    knowledge_ref: context.knowledge_ref,
    training_context: context.training_context,
    audio: {
      asset_path: auditAsset.asset_path,
      file_sha256: auditAsset.file_sha256,
      size_bytes: auditAsset.size_bytes,
      declared_duration_ms: auditAsset.declared_duration_ms,
      probed_duration_ms: auditAsset.technical.duration_ms,
      transcript: context.transcript,
      transcript_sha256: auditAsset.transcript_sha256,
    },
  };
}

function validateTechnicalAudit(audit, contexts, root, track) {
  const errors = [];
  if (audit?.schema_version !== TECHNICAL_AUDIT_SCHEMA) errors.push('schema_version is invalid');
  if (audit?.track !== track) errors.push('track does not match');
  if (audit?.ok !== true || audit?.summary?.errors !== 0) errors.push('audit must pass with zero errors');
  if (!Array.isArray(audit?.assets)) errors.push('assets must be an array');
  if (errors.length > 0) return errors;
  if (audit.assets.length !== contexts.length) errors.push('asset count does not match audio cards');
  const contextByCard = new Map(contexts.map(context => [context.card_id, context]));
  const seenCards = new Set();
  const seenAssets = new Set();
  for (const asset of audit.assets) {
    const cardId = String(asset.card_id);
    const context = contextByCard.get(cardId);
    if (!context) {
      errors.push(`unknown audit card ${cardId}`);
      continue;
    }
    if (seenCards.has(cardId)) errors.push(`duplicate audit card ${cardId}`);
    if (seenAssets.has(asset.asset_path)) errors.push(`duplicate audit asset ${asset.asset_path}`);
    seenCards.add(cardId);
    seenAssets.add(asset.asset_path);
    if (asset.asset_path !== context.asset_path) errors.push(`asset path mismatch for ${cardId}`);
    if (asset.transcript_sha256 !== context.transcript_sha256) {
      errors.push(`transcript hash mismatch for ${cardId}`);
    }
    const absoluteAsset = path.resolve(root, String(asset.asset_path || ''));
    if (!absoluteAsset.startsWith(`${path.resolve(root)}${path.sep}`)) {
      errors.push(`asset path escapes root for ${cardId}`);
      continue;
    }
    if (!fs.existsSync(absoluteAsset) || !fs.lstatSync(absoluteAsset).isFile()) {
      errors.push(`asset file is missing for ${cardId}`);
      continue;
    }
    const bytes = fs.readFileSync(absoluteAsset);
    if (bytes.byteLength !== asset.size_bytes || sha256(bytes) !== asset.file_sha256) {
      errors.push(`asset bytes mismatch for ${cardId}`);
    }
  }
  return errors;
}

function validateEntry(entry, index, seenCards, seenAssets, root, errors) {
  const label = `entries[${index}]`;
  exactKeys(
    entry,
    [
      'sequence',
      'card_id',
      'card_source_file',
      'knowledge_ref',
      'training_context',
      'audio',
      'entry_identity_sha256',
      'checks',
      'review',
    ],
    label,
    errors,
  );
  if (entry?.sequence !== index + 1) errors.push(`${label}.sequence is invalid`);
  if (!/^[0-9]{6}$/.test(String(entry?.card_id || ''))) errors.push(`${label}.card_id is invalid`);
  if (seenCards.has(entry?.card_id)) errors.push(`${label}.card_id is duplicated`);
  seenCards.add(entry?.card_id);
  if (!String(entry?.card_source_file || '').startsWith('card_boxes_json/')) {
    errors.push(`${label}.card_source_file is invalid`);
  }
  exactKeys(
    entry?.knowledge_ref,
    ['library_id', 'library_name', 'group_id', 'group_name', 'box_id', 'box_name', 'box_prefix'],
    `${label}.knowledge_ref`,
    errors,
  );
  exactKeys(
    entry?.training_context,
    ['main_training_goal', 'box_progression_role'],
    `${label}.training_context`,
    errors,
  );
  exactKeys(
    entry?.audio,
    [
      'asset_path',
      'file_sha256',
      'size_bytes',
      'declared_duration_ms',
      'probed_duration_ms',
      'transcript',
      'transcript_sha256',
    ],
    `${label}.audio`,
    errors,
  );
  if (!String(entry?.audio?.asset_path || '').startsWith('ai_tts/')) {
    errors.push(`${label}.audio.asset_path is invalid`);
  }
  if (seenAssets.has(entry?.audio?.asset_path)) errors.push(`${label}.audio.asset_path is duplicated`);
  seenAssets.add(entry?.audio?.asset_path);
  if (!SHA256_RE.test(String(entry?.audio?.file_sha256 || ''))) errors.push(`${label}.audio.file_sha256 is invalid`);
  if (!SHA256_RE.test(String(entry?.audio?.transcript_sha256 || ''))) errors.push(`${label}.audio.transcript_sha256 is invalid`);
  if (sha256(String(entry?.audio?.transcript || '').trim()) !== entry?.audio?.transcript_sha256) {
    errors.push(`${label}.audio transcript hash is invalid`);
  }
  if (!Number.isInteger(entry?.audio?.size_bytes) || entry.audio.size_bytes <= 0) errors.push(`${label}.audio.size_bytes is invalid`);
  if (!Number.isInteger(entry?.audio?.declared_duration_ms) || entry.audio.declared_duration_ms <= 0) errors.push(`${label}.audio.declared_duration_ms is invalid`);
  if (!Number.isInteger(entry?.audio?.probed_duration_ms) || entry.audio.probed_duration_ms <= 0) errors.push(`${label}.audio.probed_duration_ms is invalid`);
  const identity = {
    card_id: entry?.card_id,
    card_source_file: entry?.card_source_file,
    knowledge_ref: entry?.knowledge_ref,
    training_context: entry?.training_context,
    audio: entry?.audio,
  };
  if (entry?.entry_identity_sha256 !== sha256(canonicalStringify(identity))) {
    errors.push(`${label}.entry_identity_sha256 is invalid`);
  }
  validateChecks(entry?.checks, label, errors);
  validateReview(entry?.review, entry?.checks, label, errors);
}

function validateChecks(checks, label, errors) {
  exactKeys(checks, PERCEPTUAL_CHECKS, `${label}.checks`, errors);
  for (const check of PERCEPTUAL_CHECKS) {
    if (!CHECK_STATES.has(checks?.[check])) errors.push(`${label}.checks.${check} is invalid`);
  }
}

function validateReview(review, checks, label, errors) {
  exactKeys(
    review,
    [
      'status',
      'reviewer',
      'listening_attestation',
      'started_at',
      'completed_at',
      'notes',
      'failure_codes',
      'replacement_required',
    ],
    `${label}.review`,
    errors,
  );
  if (!REVIEW_STATUSES.has(review?.status)) errors.push(`${label}.review.status is invalid`);
  const states = PERCEPTUAL_CHECKS.map(check => checks?.[check]);
  if (review?.status === 'pending') {
    if (!states.every(state => state === 'pending')) errors.push(`${label} pending review contains resolved checks`);
    if (
      review.reviewer !== null ||
      review.listening_attestation !== null ||
      review.started_at !== null ||
      review.completed_at !== null
    ) errors.push(`${label} pending review has reviewer timestamps or attestation`);
    if (review.replacement_required !== null || review.failure_codes?.length) errors.push(`${label} pending review has outcome data`);
  } else {
    if (!isHumanReviewer(review?.reviewer)) errors.push(`${label}.review.reviewer is not human`);
    if (
      review?.listening_attestation !==
      'listened_to_entire_asset_with_transcript_and_target_context'
    ) errors.push(`${label}.review listening attestation is invalid`);
    if (!isIso(review?.started_at)) errors.push(`${label}.review.started_at is invalid`);
  }
  if (review?.status === 'in_progress') {
    if (review.completed_at !== null) errors.push(`${label} in-progress review is completed`);
    if (!states.includes('pending') || states.every(state => state === 'pending')) errors.push(`${label} in-progress review check state is invalid`);
    if (review.replacement_required !== null) errors.push(`${label} in-progress review has replacement outcome`);
  }
  if (review?.status === 'passed') {
    if (!states.every(state => state === 'pass')) errors.push(`${label} passed review has non-pass checks`);
    if (!isIso(review.completed_at)) errors.push(`${label}.review.completed_at is invalid`);
    if (review.replacement_required !== false || review.failure_codes?.length) errors.push(`${label} passed review has failure outcome`);
  }
  if (review?.status === 'failed') {
    if (states.includes('pending') || !states.includes('fail')) errors.push(`${label} failed review check state is invalid`);
    if (!isIso(review.completed_at)) errors.push(`${label}.review.completed_at is invalid`);
    if (review.replacement_required !== true || !review.failure_codes?.length) errors.push(`${label} failed review outcome is invalid`);
    if (typeof review.notes !== 'string' || !review.notes.trim()) errors.push(`${label} failed review requires notes`);
  }
  if (
    isIso(review?.started_at) &&
    isIso(review?.completed_at) &&
    Date.parse(review.completed_at) < Date.parse(review.started_at)
  ) {
    errors.push(`${label}.review completed_at predates started_at`);
  }
  const expectedCodes = failedChecks(checks || {}).map(check => FAILURE_CODE_BY_CHECK[check]);
  if (canonicalStringify(review?.failure_codes || []) !== canonicalStringify(expectedCodes)) {
    errors.push(`${label}.review.failure_codes do not match checks`);
  }
}

function validateReviewPolicy(policy, errors) {
  exactKeys(
    policy,
    [
      'review_mode',
      'agent_may_mark_passed',
      'one_card_per_review_action',
      'full_asset_listening_attestation_required',
      'all_checks_required_before_terminal_status',
      'failed_audio_requires_replacement',
      'terminal_review_immutable',
      'passing_worklist_is_not_formal_audio_qc',
    ],
    'review_policy',
    errors,
  );
  if (
    policy?.review_mode !== 'human_perceptual_qc' ||
    policy?.agent_may_mark_passed !== false ||
    policy?.one_card_per_review_action !== true ||
    policy?.full_asset_listening_attestation_required !== true ||
    policy?.all_checks_required_before_terminal_status !== true ||
    policy?.failed_audio_requires_replacement !== true ||
    policy?.terminal_review_immutable !== true ||
    policy?.passing_worklist_is_not_formal_audio_qc !== true
  ) {
    errors.push('review_policy is invalid');
  }
}

function validateTechnicalAuditReference(reference, errors) {
  exactKeys(
    reference,
    ['path', 'schema_version', 'file_sha256', 'generated_at', 'assets_fingerprint'],
    'source_technical_audit',
    errors,
  );
  if (reference?.schema_version !== TECHNICAL_AUDIT_SCHEMA) errors.push('technical audit schema is invalid');
  if (!SHA256_RE.test(String(reference?.file_sha256 || ''))) errors.push('technical audit file_sha256 is invalid');
  if (!SHA256_RE.test(String(reference?.assets_fingerprint || ''))) errors.push('technical audit assets_fingerprint is invalid');
  if (!isIso(reference?.generated_at)) errors.push('technical audit generated_at is invalid');
}

function summarizeEntries(entries) {
  const progress = {total: entries.length, pending: 0, in_progress: 0, passed: 0, failed: 0, complete: false};
  for (const entry of entries) {
    if (entry?.review?.status in progress) progress[entry.review.status] += 1;
  }
  progress.complete = progress.total > 0 && progress.pending === 0 && progress.in_progress === 0;
  return progress;
}

function summarizeContextQuality(entries) {
  const missingMainTrainingGoal = entries.filter(
    entry => !entry?.training_context?.main_training_goal,
  ).length;
  const missingBoxProgressionRole = entries.filter(
    entry => !entry?.training_context?.box_progression_role,
  ).length;
  return {
    entries_with_complete_training_context: entries.filter(
      entry =>
        entry?.training_context?.main_training_goal &&
        entry?.training_context?.box_progression_role,
    ).length,
    missing_main_training_goal: missingMainTrainingGoal,
    missing_box_progression_role: missingBoxProgressionRole,
    formal_content_context_ready:
      missingMainTrainingGoal === 0 && missingBoxProgressionRole === 0,
  };
}

function pendingChecks() {
  return Object.fromEntries(PERCEPTUAL_CHECKS.map(check => [check, 'pending']));
}

function pendingReview() {
  return {
    status: 'pending',
    reviewer: null,
    listening_attestation: null,
    started_at: null,
    completed_at: null,
    notes: '',
    failure_codes: [],
    replacement_required: null,
  };
}

function failedChecks(checks) {
  return PERCEPTUAL_CHECKS.filter(check => checks?.[check] === 'fail');
}

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    errors.push(`${label} keys are not exact`);
  }
}

function requireTrack(track) {
  if (!['cet4', 'cet6'].includes(track)) throw new Error('track must be cet4 or cet6');
  return track;
}

function isHumanReviewer(value) {
  return (
    typeof value === 'string' &&
    /^(?:github|team|external):[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/.test(value) &&
    !/(?:^|[:._@-])(?:agent|bot|codex|automation|ci)(?:$|[:._@-])/i.test(value)
  );
}

function isIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock is invalid');
  return date.toISOString();
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireRegularFile(file, root) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('file path is required');
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('file path escapes workspace');
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile()) throw new Error('file must be a regular file');
  return absolute;
}

function requireWorklistOutput(file, root) {
  const absolute = path.resolve(root, file);
  const allowed = [
    path.resolve(root, 'exports'),
    path.resolve(root, 'reviews/audio_perceptual_worklists'),
  ];
  if (
    !absolute.endsWith('.json') ||
    !allowed.some(directory => absolute.startsWith(`${directory}${path.sep}`))
  ) {
    throw new Error('worklist path must be JSON below exports/ or reviews/audio_perceptual_worklists/');
  }
  return absolute;
}

function relativeToRoot(file, root) {
  return path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o644});
  fs.renameSync(temporary, file);
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['build', 'next', 'review', 'validate'].includes(command)) {
    throw new Error('command must be build, next, review, or validate');
  }
  const options = {
    allowReviewedReset: false,
    apply: false,
    attestListened: false,
    cardId: null,
    checkUpdates: [],
    command,
    existingPath: null,
    notes: null,
    outputPath: null,
    requireComplete: false,
    reviewer: null,
    technicalAuditPath: null,
    track: 'cet4',
    worklistPath: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--attest-listened') options.attestListened = true;
    else if (argument === '--allow-reviewed-reset') options.allowReviewedReset = true;
    else if (argument === '--require-complete') options.requireComplete = true;
    else if (['--track', '--technical-audit', '--output', '--existing', '--file', '--card-id', '--reviewer', '--notes', '--check'].includes(argument)) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--track') options.track = value;
      if (argument === '--technical-audit') options.technicalAuditPath = value;
      if (argument === '--output') options.outputPath = value;
      if (argument === '--existing') options.existingPath = value;
      if (argument === '--file') options.worklistPath = value;
      if (argument === '--card-id') options.cardId = value;
      if (argument === '--reviewer') options.reviewer = value;
      if (argument === '--notes') options.notes = value;
      if (argument === '--check') {
        const match = value.match(/^([a-z_]+)=(pass|fail)$/);
        if (!match) throw new Error('--check must be name=pass|fail');
        options.checkUpdates.push({name: match[1], value: match[2]});
      }
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (command === 'build' && (!options.technicalAuditPath || !options.outputPath)) {
    throw new Error('build requires --technical-audit and --output');
  }
  if (['next', 'review', 'validate'].includes(command) && !options.worklistPath) {
    throw new Error(`${command} requires --file`);
  }
  if (command === 'review' && (!options.cardId || !options.reviewer || options.checkUpdates.length === 0)) {
    throw new Error('review requires --card-id, --reviewer, and at least one --check');
  }
  if (command === 'review' && options.attestListened !== true) {
    throw new Error('review requires --attest-listened');
  }
  if (new Set(options.checkUpdates.map(update => update.name)).size !== options.checkUpdates.length) {
    throw new Error('duplicate --check updates are not allowed');
  }
  if (command !== 'review' && options.apply) throw new Error('--apply is valid only for review');
  if (command !== 'review' && options.attestListened) {
    throw new Error('--attest-listened is valid only for review');
  }
  if (command !== 'build' && options.allowReviewedReset) {
    throw new Error('--allow-reviewed-reset is valid only for build');
  }
  if (command !== 'validate' && options.requireComplete) {
    throw new Error('--require-complete is valid only for validate');
  }
  return options;
}

function loadWorklistAndAudit(options, root) {
  const worklistFile = requireRegularFile(
    requireWorklistOutput(options.worklistPath, root),
    root,
  );
  const worklist = readJson(worklistFile);
  const auditFile = requireRegularFile(worklist.source_technical_audit?.path, root);
  const audit = readJson(auditFile);
  const auditSha = sha256(fs.readFileSync(auditFile));
  if (auditSha !== worklist.source_technical_audit?.file_sha256) {
    throw new Error('technical audit file hash no longer matches worklist');
  }
  return {audit, worklist, worklistFile};
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.command === 'build') {
      const auditFile = requireRegularFile(options.technicalAuditPath, ROOT);
      const existing = options.existingPath
        ? readJson(requireRegularFile(options.existingPath, ROOT))
        : null;
      const result = buildAudioPerceptualWorklist({
        allowReviewedReset: options.allowReviewedReset,
        existing,
        root: ROOT,
        technicalAudit: readJson(auditFile),
        technicalAuditPath: auditFile,
        track: options.track,
      });
      const output = requireWorklistOutput(options.outputPath, ROOT);
      if (fs.existsSync(output)) {
        if (!options.existingPath) {
          throw new Error('output exists; pass --existing to preserve prior reviews');
        }
        const existingFile = requireRegularFile(options.existingPath, ROOT);
        if (existingFile !== output) {
          throw new Error('existing worklist must be the same file as an overwritten output');
        }
      }
      writeJsonAtomic(output, result.worklist);
      console.log(
        JSON.stringify({
          ok: true,
          output: relativeToRoot(output, ROOT),
          progress: result.worklist.progress,
          preserved_reviews: result.preserved_reviews,
          reset_reviews: result.reset_reviews,
        }),
      );
      return;
    }
    const loaded = loadWorklistAndAudit(options, ROOT);
    const errors = validateAudioPerceptualWorklist(loaded.worklist, {
      requireComplete: options.requireComplete,
      root: ROOT,
      technicalAudit: loaded.audit,
    });
    if (errors.length > 0) throw new Error(`worklist is invalid: ${errors.join('; ')}`);
    if (options.command === 'validate') {
      console.log(JSON.stringify({ok: true, progress: loaded.worklist.progress}));
      return;
    }
    if (options.command === 'next') {
      const entry = loaded.worklist.entries.find(
        candidate => candidate.review.status === 'in_progress',
      ) ?? loaded.worklist.entries.find(candidate => candidate.review.status === 'pending');
      console.log(JSON.stringify({ok: true, complete: !entry, entry: entry ?? null}, null, 2));
      return;
    }
    const updated = reviewAudioPerceptualEntry({
      cardId: options.cardId,
      checkUpdates: options.checkUpdates,
      listenedToEntireAsset: options.attestListened,
      notes: options.notes,
      reviewer: options.reviewer,
      worklist: loaded.worklist,
    });
    const updatedErrors = validateAudioPerceptualWorklist(updated, {
      root: ROOT,
      technicalAudit: loaded.audit,
    });
    if (updatedErrors.length > 0) throw new Error(`updated worklist is invalid: ${updatedErrors.join('; ')}`);
    if (options.apply) writeJsonAtomic(loaded.worklistFile, updated);
    console.log(
      JSON.stringify({
        ok: true,
        applied: options.apply,
        card_id: options.cardId,
        review: updated.entries.find(entry => entry.card_id === options.cardId).review,
        progress: updated.progress,
      }),
    );
  } catch (error) {
    console.error(`[audio-perceptual-worklist] ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
