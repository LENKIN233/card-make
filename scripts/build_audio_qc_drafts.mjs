#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  canonicalStringify,
  PERCEPTUAL_CHECKS,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';
import {
  validateIndependentModelAcceptances,
  validateModelAcceptance,
} from './lib/model_acceptance.mjs';
import {
  computeCardCorpusFingerprint,
  validateCurrentApprovalRecordReference,
} from './lib/card_integrity.mjs';
import {verifyTrustedMediaEvidence} from './lib/trusted_media_reference.mjs';
import {validateAudioAcceptanceInput} from './validate_audio_qc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWED_WORKLIST_DIR = 'reviews/audio_perceptual_worklists';
const AUDIO_QC_DIR = 'reviews/audio_qc';
const REQUIRED_ATTESTATIONS = Object.freeze([
  'no_autoplay_assumption',
  'front_side_no_required_subtitles',
  'tts_audio_not_used_as_source_authenticity',
]);

export function buildAudioQcDrafts({
  attestationBundlePath,
  attestations = {},
  clock = () => new Date(),
  contentAuthorizationPath,
  execFile = execFileSync,
  root = ROOT,
  typeSpecificVerifier,
  trustedReceiptPath,
  worklistPath,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const linkedWorklist = requireReviewedWorklistPath(worklistPath, normalizedRoot);
  const sourceBytes = fs.readFileSync(linkedWorklist);
  requireTrackedHeadBytes(linkedWorklist, sourceBytes, normalizedRoot);
  const sourceWorklist = JSON.parse(sourceBytes.toString('utf8'));
  const technicalAuditFile = requireRegularWorkspaceFile(
    sourceWorklist.source_technical_audit?.path,
    normalizedRoot,
  );
  const technicalAuditBytes = fs.readFileSync(technicalAuditFile);
  if (sha256(technicalAuditBytes) !== sourceWorklist.source_technical_audit?.file_sha256) {
    throw new Error('Technical audit file hash no longer matches the reviewed worklist.');
  }
  const technicalAudit = JSON.parse(technicalAuditBytes.toString('utf8'));
  const errors = validateAudioPerceptualWorklist(sourceWorklist, {
    requireComplete: true,
    root: normalizedRoot,
    technicalAudit,
  });
  if (errors.length > 0) {
    throw new Error(`Reviewed perceptual worklist is invalid: ${errors.join('; ')}`);
  }
  if (
    sourceWorklist.progress?.passed !== sourceWorklist.entries.length ||
    sourceWorklist.entries.some(entry =>
      entry.review?.status !== 'passed' ||
      PERCEPTUAL_CHECKS.some(check => entry.checks?.[check] !== 'pass'))
  ) {
    throw new Error('Every scoped audio entry must have a terminal model pass for all perceptual checks.');
  }
  for (const attestation of REQUIRED_ATTESTATIONS) {
    if (attestations[attestation] !== true) {
      throw new Error(`Explicit ${attestation} attestation is required.`);
    }
  }
  const contentAuthorization = requireCurrentContentAuthorization({
    contentAuthorizationPath,
    root: normalizedRoot,
    scopedCardIds: sourceWorklist.entries.map(entry => entry.card_id),
  });
  const trustedMedia = requireTrustedMediaReceipt({
    attestationBundlePath,
    authorization: contentAuthorization,
    execFile,
    root: normalizedRoot,
    typeSpecificVerifier,
    trustedReceiptPath,
    worklistBytes: sourceBytes,
    worklistPath: relativeToRoot(linkedWorklist, normalizedRoot),
  });
  const grouped = groupByBox(sourceWorklist.entries);
  const createdAt = asIso(clock());
  const worklistRelativePath = relativeToRoot(linkedWorklist, normalizedRoot);
  const worklistSha256 = sha256(sourceBytes);
  const records = [];
  const acceptanceInputs = {};
  for (const entries of grouped.values()) {
    const boxPrefix = entries[0]?.knowledge_ref?.box_prefix;
    const record = buildBoxRecord({
      attestations,
      contentAuthorizationPath: contentAuthorization.relativePath,
      createdAt,
      entries,
      root: normalizedRoot,
      sourceWorklist,
      trustedMedia,
      worklistRelativePath,
      worklistSha256,
    });
    const identity = validateAudioAcceptanceInput(record, {root: normalizedRoot});
    if (identity.issues.length > 0) {
      throw new Error(`Box ${boxPrefix} audio identity is invalid: ${identity.issues.map(issue => issue.code).join(', ')}`);
    }
    acceptanceInputs[boxPrefix] = identity.input_sha256;
    record.model_acceptances = buildAggregateModelAcceptances({
      boxPrefix,
      entries,
      inputSha256: identity.input_sha256,
    });
    const acceptanceIssues = validateIndependentModelAcceptances(
      record.model_acceptances,
      {requiredCapabilities: ['audio_perceptual_review']},
    );
    if (acceptanceIssues.length > 0) {
      throw new Error(`Box ${boxPrefix} model acceptance is invalid: ${acceptanceIssues.map(issue => issue.code).join(', ')}`);
    }
    if (record.model_acceptances.some(
      acceptance => acceptance.evidence.input_sha256 !== identity.input_sha256,
    )) {
      throw new Error(`Box ${boxPrefix} model acceptance does not bind the exact audio QC input.`);
    }
    records.push(record);
  }
  return {
    records,
    summary: {
      card_count: sourceWorklist.entries.length,
      formal_content_approval_created: false,
      linked_content_authorization: contentAuthorization.relativePath,
      linked_content_authorization_sha256: contentAuthorization.sha256,
      trusted_media_receipt: trustedMedia.receiptPath,
      trusted_media_receipt_sha256: trustedMedia.receiptSha256,
      acceptance_inputs: acceptanceInputs,
      record_count: records.length,
      model_run_ids: [...new Set(records.flatMap(record =>
        (record.model_acceptances || []).map(acceptance => acceptance.actor.run_id)))].sort(),
      worklist: worklistRelativePath,
      worklist_sha256: worklistSha256,
    },
  };
}

function buildBoxRecord({
  attestations,
  contentAuthorizationPath,
  createdAt,
  entries,
  root,
  sourceWorklist,
  trustedMedia,
  worklistRelativePath,
  worklistSha256,
}) {
  const first = entries[0];
  const knowledge = first.knowledge_ref;
  const cardIds = entries.map(entry => entry.card_id);
  const cards = entries.map(entry => readBoundCard(entry, root));
  const selfReviews = findCurrentSelfReviews(cardIds, root);
  for (const card of cards) {
    if (
      card.quality_metadata?.material?.tts_text_reviewed !== true &&
      !selfReviews.some(reviewPath =>
        currentModelOwnedTextReviewCoversCard(reviewPath, card.card_id, root))
    ) {
      throw new Error(`Card ${card.card_id} does not have a passed TTS text review gate or current model-owned semantic review.`);
    }
    if (card.quality_metadata?.material?.audio_generation_method !== 'TTS_AI_generated') {
      throw new Error(`Card ${card.card_id} is not a legacy TTS candidate asset.`);
    }
  }
  const completedAt = entries
    .map(entry => entry.review.completed_at)
    .sort()
    .at(-1);
  const date = createdAt.slice(0, 10).replaceAll('-', '');
  return {
    schema_version: 'model-owned-audio-qc.v2',
    audio_qc_id: `${date}-${sourceWorklist.track}-${knowledge.box_prefix}-audio-qc`,
    created_at: createdAt,
    model_acceptances: [],
    scope: {
      library: knowledge.library_name,
      group: knowledge.group_name,
      box: knowledge.box_name,
      box_prefixes: [knowledge.box_prefix],
      card_ids: cardIds,
    },
    source_records: {
      card_files: [...new Set(entries.map(entry => entry.card_source_file))],
      linked_agent_self_reviews: selfReviews,
      linked_approved_batch: contentAuthorizationPath,
      linked_perceptual_worklist: worklistRelativePath,
      perceptual_worklist_sha256: worklistSha256,
      trusted_media_receipt: trustedMedia.receiptPath,
      trusted_media_receipt_sha256: trustedMedia.receiptSha256,
      trusted_media_attestation_bundle: trustedMedia.bundlePath,
      trusted_media_attestation_bundle_sha256: trustedMedia.bundleSha256,
      trusted_media_source_commit: trustedMedia.sourceCommit,
      trusted_media_model_id: trustedMedia.modelId,
      trusted_media_model_revision: trustedMedia.modelRevision,
    },
    text_gate: {
      tts_text_reviewed: true,
      text_source_type: uniqueValue(
        cards.map(card => card.quality_metadata.material.text_source_type),
        'text source type',
      ),
      transcripts: entries.map(entry => ({
        card_id: entry.card_id,
        transcript: entry.audio.transcript,
        target_signal: entry.training_context.main_training_goal,
        pronunciation_notes: pronunciationNotes(entry),
        text_review_result: 'passed_before_perceptual_review',
      })),
    },
    generation_plan: {
      method: 'TTS_AI_generated',
      provider: 'legacy_unknown',
      voice_or_speaker: 'legacy_unknown',
      speed: 'legacy_unknown',
      style_notes: 'Pre-existing candidate assets; unavailable generation details are not reconstructed.',
      output_dir: 'ai_tts/',
      overwrite_existing_assets: false,
      replacement_reason: '',
    },
    legacy_adoption: {
      enabled: true,
      reviewed_at: completedAt,
      reproducibility_status: 'non_reproducible',
    },
    generated_assets: entries.map(entry => ({
      card_id: entry.card_id,
      path: entry.audio.asset_path,
      transcript_sha256: entry.audio.transcript_sha256,
      generated_at: 'legacy_unknown',
      generator_version: 'legacy_unknown',
      file_sha256: entry.audio.file_sha256,
      provenance_note: 'Pre-existing TTS candidate asset with unknown provider, voice and generator version; adopted only through bound technical identity and model perceptual review.',
    })),
    qa_checks: {
      ...Object.fromEntries(PERCEPTUAL_CHECKS.map(check => [check, true])),
      no_autoplay_assumption: attestations.no_autoplay_assumption,
      front_side_no_required_subtitles: attestations.front_side_no_required_subtitles,
      tts_audio_not_used_as_source_authenticity:
        attestations.tts_audio_not_used_as_source_authenticity,
    },
    per_card_qc: entries.map(entry => ({
      card_id: entry.card_id,
      asset_path: entry.audio.asset_path,
      complete_asset_consumed: entry.review.complete_asset_consumed,
      matches_text: entry.checks.audio_matches_text === 'pass',
      target_signal: entry.checks.target_signal_audible === 'pass',
      pronunciation: entry.checks.accurate_pronunciation === 'pass',
      speed: entry.checks.suitable_speed === 'pass',
      rhythm: entry.checks.natural_rhythm === 'pass',
      stress_pauses:
        entry.checks.stress_and_pauses_do_not_mislead === 'pass',
      no_noise: entry.checks.no_unwanted_noise_or_clipping === 'pass',
      notes: `Model perceptual pass at ${entry.review.completed_at}; ${sourceWorklist.worklist_id}.`,
    })),
    verdict: {
      candidate_audio_ok: true,
      formal_audio_ready: true,
      requires_regeneration: false,
      reason: 'All bound assets passed complete per-card model perceptual QC and the three product-semantics boundaries were explicitly attested.',
    },
    approval_boundary: {
      tts_audio_is_not_source_authenticity_evidence: true,
      current_model_owned_content_authorization_required: true,
      external_facts_must_not_be_inferred: true,
    },
    validation: {
      audio_qc: 'node scripts/validate_audio_qc.mjs',
      harness: 'node scripts/validate_harness.mjs',
    },
  };
}

function requireTrustedMediaReceipt({
  attestationBundlePath,
  authorization,
  execFile,
  root,
  typeSpecificVerifier,
  trustedReceiptPath,
  worklistBytes,
  worklistPath,
}) {
  return verifyTrustedMediaEvidence({
    attestationBundlePath,
    authorizationPath: authorization.relativePath,
    execFile,
    root,
    typeSpecificVerifier,
    trustedReceiptPath,
    worklistPath,
    worklistSha256: sha256(worklistBytes),
  });
}

function buildAggregateModelAcceptances({boxPrefix, entries, inputSha256}) {
  return [0, 1].map(lane => {
    const sourceAcceptances = entries.map(entry => {
      const acceptance = entry.review?.model_acceptances?.[lane];
      const issues = validateModelAcceptance(acceptance, {
        requireAccepted: true,
        requiredCapabilities: ['audio_perceptual_review'],
      });
      if (issues.length > 0) {
        throw new Error(
          `Card ${entry.card_id} lane ${lane + 1} audio evidence is invalid: ${issues.map(issue => issue.code).join(', ')}`,
        );
      }
      return {
        card_id: entry.card_id,
        input_sha256: acceptance.evidence.input_sha256,
        model: acceptance.actor.model,
        reviewed_at: acceptance.evidence.reviewed_at,
        run_id: acceptance.actor.run_id,
      };
    });
    if (new Set(sourceAcceptances.map(item => item.run_id)).size !== sourceAcceptances.length) {
      throw new Error(`Box ${boxPrefix} lane ${lane + 1} reuses a per-card run ID.`);
    }
    const evidenceSha256 = sha256(
      Buffer.from(canonicalStringify(sourceAcceptances), 'utf8'),
    );
    const models = [...new Set(sourceAcceptances.map(item => item.model))];
    return {
      schema_version: 'model-acceptance.v2',
      actor: {
        kind: 'model_harness',
        agent: `agent:audio-evidence-aggregate-lane-${lane + 1}`,
        model: models.length === 1 ? models[0] : 'multi-model-audio-evidence',
        run_id: `audio-evidence:${boxPrefix}:lane-${lane + 1}:${evidenceSha256.slice(0, 16)}`,
      },
      evidence: {
        reviewed_at: sourceAcceptances.map(item => item.reviewed_at).sort().at(-1),
        input_sha256: inputSha256,
        capabilities: ['audio_perceptual_review'],
        summary: `Deterministic lane ${lane + 1} aggregation of ${sourceAcceptances.length} exact per-card audio-capable acceptances; source evidence sha256:${evidenceSha256}. No new media, provider, deployment, or device fact is inferred.`,
        findings: [],
      },
      decision: 'accepted',
    };
  });
}

function requireCurrentContentAuthorization({
  contentAuthorizationPath,
  root,
  scopedCardIds,
}) {
  const absolute = requireRegularWorkspaceFile(contentAuthorizationPath, root);
  const relativePath = relativeToRoot(absolute, root);
  if (
    !relativePath.startsWith('reviews/approved_batches/') ||
    path.posix.dirname(relativePath) !== 'reviews/approved_batches' ||
    !relativePath.endsWith('.json') ||
    relativePath.endsWith('/TEMPLATE.json')
  ) {
    throw new Error('Current content authorization must be a direct non-template JSON record.');
  }
  const bytes = fs.readFileSync(absolute);
  requireTrackedHeadBytes(absolute, bytes, root);
  const currentFingerprint = computeCardCorpusFingerprint(root);
  const validation = validateCurrentApprovalRecordReference({
    root,
    approvalPath: relativePath,
    currentFingerprint,
  });
  if (!validation.ok) {
    throw new Error(
      `Current model-owned content authorization failed canonical replay: ${validation.issues
        .map(issue => issue.code)
        .join(', ')}`,
    );
  }
  const record = validation.approval;
  const authorizedCards = new Set((record.scope?.card_ids || []).map(String));
  const currentTrackCardCount = countTrackCards(root, 'cet4');
  if (
    record.schema_version !== 'model-owned-content-authorization.v2' ||
    record.authorization_mode !== 'full_track' ||
    record.scope?.track !== 'cet4' ||
    record.scope?.purpose !== 'formal_content' ||
    scopedCardIds.some(cardId => !authorizedCards.has(String(cardId))) ||
    authorizedCards.size !== currentTrackCardCount
  ) {
    throw new Error('Current model-owned content authorization is invalid or does not cover the audio scope.');
  }
  return {record, relativePath, sha256: sha256(bytes)};
}

function readBoundCard(entry, root) {
  const file = requireRegularWorkspaceFile(entry.card_source_file, root);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const matches = (document.cards || []).filter(card => String(card.card_id) === entry.card_id);
  if (matches.length !== 1) throw new Error(`Card ${entry.card_id} does not resolve uniquely.`);
  const card = matches[0];
  if (
    card.audio?.transcript?.trim() !== entry.audio.transcript ||
    (card.audio?.path || card.audio?.url) !== entry.audio.asset_path
  ) {
    throw new Error(`Card ${entry.card_id} no longer matches the reviewed audio identity.`);
  }
  return card;
}

function countTrackCards(root, track) {
  let count = 0;
  const directory = path.join(root, 'card_boxes_json');
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const document = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    if (document.track === track && Array.isArray(document.cards)) count += document.cards.length;
  }
  return count;
}

function findCurrentSelfReviews(cardIds, root) {
  const target = new Set(cardIds);
  const directory = path.join(root, 'reviews/agent_self_review');
  const candidates = [];
  for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const relative = `reviews/agent_self_review/${filename}`;
    const record = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    const scoped = Array.isArray(record.scope?.card_ids)
      ? record.scope.card_ids.map(String).filter(cardId => target.has(cardId))
      : [];
    if (scoped.length === 0) continue;
    candidates.push({created_at: String(record.created_at || ''), path: relative, scoped});
  }
  const chosen = new Map();
  for (const cardId of cardIds) {
    const matching = candidates
      .filter(candidate => candidate.scoped.includes(cardId))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    if (matching.length === 0) throw new Error(`Card ${cardId} has no linked agent self-review.`);
    const currentModelReview = matching.find(candidate =>
      currentModelOwnedTextReviewCoversCard(candidate.path, cardId, root));
    const selected = currentModelReview ?? matching[0];
    chosen.set(selected.path, selected);
  }
  return [...chosen.keys()].sort();
}

function currentModelOwnedTextReviewCoversCard(relativePath, cardId, root) {
  const absolute = requireRegularWorkspaceFile(relativePath, root);
  const record = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!Array.isArray(record.scope?.card_ids) || !record.scope.card_ids.map(String).includes(String(cardId))) {
    return false;
  }
  let acceptanceIssues;
  if (record.schema_version === 'model-owned-full-track-review.v2') {
    acceptanceIssues = validateIndependentModelAcceptances(record.model_acceptances, {
      requiredCapabilities: ['card_semantic_review', 'source_provenance_review'],
    });
    if (
      record.batch_review?.status !== 'ready_for_model_authorization' ||
      !Array.isArray(record.batch_review?.remaining_risks) ||
      record.batch_review.remaining_risks.length !== 0
    ) return false;
  } else if (record.schema_version === 'model-owned-card-review.v2') {
    acceptanceIssues = validateModelAcceptance(record.model_acceptance, {
      requireAccepted: true,
      requiredCapabilities: ['card_semantic_review', 'source_provenance_review'],
    });
    if (record.batch_review?.status !== 'model_accepted') return false;
  } else {
    return false;
  }
  if (acceptanceIssues.length > 0) return false;
  const audit = record.quality_audit;
  if (
    audit?.scope_has_no_hard_blockers !== true ||
    !Array.isArray(audit.scope_summary?.card_ids) ||
    !audit.scope_summary.card_ids.map(String).includes(String(cardId)) ||
    audit.scope_summary?.by_severity?.hard_blocker !== 0 ||
    audit.scope_summary?.by_severity?.content_risk !== 0 ||
    audit.scope_summary?.by_severity?.review_gap !== 0
  ) return false;
  let auditFile;
  try {
    auditFile = requireRegularWorkspaceFile(audit.report, root);
  } catch {
    return false;
  }
  return `sha256:${sha256(fs.readFileSync(auditFile))}` === audit.report_sha256;
}

function pronunciationNotes(entry) {
  return entry.knowledge_ref.group_name === '语音现象'
    ? `Evaluate the audible pronunciation phenomenon named by this target: ${entry.training_context.main_training_goal}`
    : 'No dedicated pronunciation phenomenon; verify clear standard pronunciation across the complete transcript.';
}

function groupByBox(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = [
      entry.knowledge_ref.library_id,
      entry.knowledge_ref.group_id,
      entry.knowledge_ref.box_id,
      entry.knowledge_ref.box_prefix,
    ].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function uniqueValue(values, label) {
  const unique = [...new Set(values)];
  if (unique.length !== 1 || typeof unique[0] !== 'string' || !unique[0].trim()) {
    throw new Error(`Scoped cards must have one non-empty ${label}.`);
  }
  return unique[0];
}

function requireReviewedWorklistPath(file, root) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('worklist path is required');
  const absolute = requireRegularWorkspaceFile(file, root);
  const directory = path.join(root, REVIEWED_WORKLIST_DIR);
  if (!absolute.startsWith(`${directory}${path.sep}`) || !absolute.endsWith('.json')) {
    throw new Error(`Formal QC drafts require a tracked JSON worklist below ${REVIEWED_WORKLIST_DIR}/.`);
  }
  return absolute;
}

function requireTrackedHeadBytes(file, bytes, root) {
  const relative = relativeToRoot(file, root);
  let mode;
  let headBytes;
  try {
    const treeEntry = execFileSync(
      'git',
      ['--literal-pathspecs', 'ls-tree', 'HEAD', '--', relative],
      {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
    ).trim();
    const match = treeEntry.match(/^([0-9]{6}) blob [0-9a-f]{40}\t(.+)$/);
    if (!match || match[2] !== relative) {
      throw new Error('worklist is absent from HEAD');
    }
    mode = match[1];
    headBytes = execFileSync(
      'git',
      ['--literal-pathspecs', 'show', `HEAD:${relative}`],
      {cwd: root, encoding: null, stdio: ['ignore', 'pipe', 'pipe']},
    );
  } catch {
    throw new Error('Formal QC drafts require the reviewed worklist to be a direct tracked file in HEAD.');
  }
  if (mode !== '100644') {
    throw new Error('Reviewed worklist must be a non-executable regular 100644 file in HEAD.');
  }
  if (!Buffer.from(bytes).equals(Buffer.from(headBytes))) {
    throw new Error('Reviewed worklist bytes must exactly match the tracked HEAD artifact.');
  }
}

function requireRegularWorkspaceFile(file, root) {
  const absolute = path.resolve(root, String(file || ''));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('path escapes workspace');
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
    throw new Error(`required regular file is missing: ${String(file)}`);
  }
  return absolute;
}

function outputPathFor(record, outputDirectory) {
  return path.join(outputDirectory, `${record.audio_qc_id}.json`);
}

function relativeToRoot(file, root) {
  return path.relative(root, file).split(path.sep).join('/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('clock returned an invalid date');
  return date.toISOString();
}

function parseArguments(argv) {
  const options = {
    apply: false,
    attestations: {},
    attestationBundlePath: null,
    contentAuthorizationPath: null,
    outputDirectory: AUDIO_QC_DIR,
    trustedReceiptPath: null,
    worklistPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--attest-no-autoplay') {
      options.attestations.no_autoplay_assumption = true;
    } else if (argument === '--attest-front-no-required-subtitles') {
      options.attestations.front_side_no_required_subtitles = true;
    } else if (argument === '--attest-tts-not-source-authenticity') {
      options.attestations.tts_audio_not_used_as_source_authenticity = true;
    } else if ([
      '--worklist',
      '--authorization',
      '--trusted-receipt',
      '--attestation-bundle',
      '--output-dir',
    ].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--worklist') options.worklistPath = value;
      if (argument === '--authorization') options.contentAuthorizationPath = value;
      if (argument === '--trusted-receipt') options.trustedReceiptPath = value;
      if (argument === '--attestation-bundle') options.attestationBundlePath = value;
      if (argument === '--output-dir') options.outputDirectory = value;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (
    !options.worklistPath ||
    !options.contentAuthorizationPath ||
    !options.trustedReceiptPath ||
    !options.attestationBundlePath
  ) {
    throw new Error('--worklist, --authorization, --trusted-receipt and --attestation-bundle are required');
  }
  return options;
}

function requireOutputDirectory(value, root) {
  const absolute = path.resolve(root, value);
  const allowed = path.join(root, AUDIO_QC_DIR);
  if (absolute !== allowed) throw new Error(`output directory must be ${AUDIO_QC_DIR}`);
  return absolute;
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = buildAudioQcDrafts({
      attestationBundlePath: options.attestationBundlePath,
      attestations: options.attestations,
      contentAuthorizationPath: options.contentAuthorizationPath,
      root: ROOT,
      trustedReceiptPath: options.trustedReceiptPath,
      worklistPath: options.worklistPath,
    });
    const outputDirectory = requireOutputDirectory(options.outputDirectory, ROOT);
    const outputs = result.records.map(record => outputPathFor(record, outputDirectory));
    if (options.apply) {
      for (const output of outputs) {
        if (fs.existsSync(output)) throw new Error(`refusing to replace existing audio QC record: ${relativeToRoot(output, ROOT)}`);
      }
      fs.mkdirSync(outputDirectory, {recursive: true});
      for (let index = 0; index < outputs.length; index += 1) {
        fs.writeFileSync(outputs[index], `${JSON.stringify(result.records[index], null, 2)}\n`, {
          flag: 'wx',
          mode: 0o644,
        });
      }
    }
    console.log(JSON.stringify({
      ok: true,
      applied: options.apply,
      outputs: outputs.map(output => relativeToRoot(output, ROOT)),
      ...result.summary,
    }, null, 2));
  } catch (error) {
    console.error(`[audio-qc-drafts] ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
