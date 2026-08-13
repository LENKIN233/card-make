#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PERCEPTUAL_CHECKS,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWED_WORKLIST_DIR = 'reviews/audio_perceptual_worklists';
const AUDIO_QC_DIR = 'reviews/audio_qc';
const REQUIRED_ATTESTATIONS = Object.freeze([
  'no_autoplay_assumption',
  'front_side_no_required_subtitles',
  'tts_audio_not_used_as_source_authenticity',
]);

export function buildAudioQcDrafts({
  attestations = {},
  clock = () => new Date(),
  root = ROOT,
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
    throw new Error('Every scoped audio entry must have a terminal human pass for all perceptual checks.');
  }
  for (const attestation of REQUIRED_ATTESTATIONS) {
    if (attestations[attestation] !== true) {
      throw new Error(`Explicit ${attestation} attestation is required.`);
    }
  }
  const grouped = groupByBox(sourceWorklist.entries);
  const createdAt = asIso(clock());
  const worklistRelativePath = relativeToRoot(linkedWorklist, normalizedRoot);
  const worklistSha256 = sha256(sourceBytes);
  const records = [];
  for (const entries of grouped.values()) {
    const reviewers = new Set(entries.map(entry => entry.review.reviewer));
    if (reviewers.size !== 1) {
      throw new Error('One box QC record may only aggregate entries completed by the same human reviewer.');
    }
    const [reviewer] = reviewers;
    records.push(buildBoxRecord({
      attestations,
      createdAt,
      entries,
      reviewer,
      root: normalizedRoot,
      sourceWorklist,
      worklistRelativePath,
      worklistSha256,
    }));
  }
  return {
    records,
    summary: {
      card_count: sourceWorklist.entries.length,
      formal_content_approval_created: false,
      record_count: records.length,
      reviewers: [...new Set(records.map(record => record.legacy_adoption.reviewer))].sort(),
      worklist: worklistRelativePath,
      worklist_sha256: worklistSha256,
    },
  };
}

function buildBoxRecord({
  attestations,
  createdAt,
  entries,
  reviewer,
  root,
  sourceWorklist,
  worklistRelativePath,
  worklistSha256,
}) {
  const first = entries[0];
  const knowledge = first.knowledge_ref;
  const cardIds = entries.map(entry => entry.card_id);
  const cards = entries.map(entry => readBoundCard(entry, root));
  for (const card of cards) {
    if (card.quality_metadata?.material?.tts_text_reviewed !== true) {
      throw new Error(`Card ${card.card_id} does not have a passed TTS text review gate.`);
    }
    if (card.quality_metadata?.material?.audio_generation_method !== 'TTS_AI_generated') {
      throw new Error(`Card ${card.card_id} is not a legacy TTS candidate asset.`);
    }
  }
  const selfReviews = findCurrentSelfReviews(cardIds, root);
  const completedAt = entries
    .map(entry => entry.review.completed_at)
    .sort()
    .at(-1);
  const date = createdAt.slice(0, 10).replaceAll('-', '');
  return {
    audio_qc_id: `${date}-${sourceWorklist.track}-${knowledge.box_prefix}-audio-qc`,
    created_at: createdAt,
    agent: 'codex',
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
      linked_approved_batch: '',
      linked_perceptual_worklist: worklistRelativePath,
      perceptual_worklist_sha256: worklistSha256,
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
      reviewer,
      reproducibility_status: 'non_reproducible',
    },
    generated_assets: entries.map(entry => ({
      card_id: entry.card_id,
      path: entry.audio.asset_path,
      transcript_sha256: entry.audio.transcript_sha256,
      generated_at: 'legacy_unknown',
      generator_version: 'legacy_unknown',
      file_sha256: entry.audio.file_sha256,
      provenance_note: 'Pre-existing TTS candidate asset with unknown provider, voice and generator version; adopted only through bound technical identity and human perceptual review.',
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
      audio_matches_text: true,
      target_signal_audible: true,
      notes: `Human perceptual pass by ${entry.review.reviewer} at ${entry.review.completed_at}; ${sourceWorklist.worklist_id}.`,
    })),
    verdict: {
      candidate_audio_ok: true,
      formal_audio_ready: true,
      requires_regeneration: false,
      reason: 'All bound assets passed complete per-card human perceptual QC and the three product-semantics boundaries were explicitly attested.',
    },
    approval_boundary: {
      tts_audio_is_not_source_authenticity_evidence: true,
      formal_content_approval_still_requires_user: true,
      content_approval_record_required_for_formal_use: true,
    },
    validation: {
      audio_qc: 'node scripts/validate_audio_qc.mjs',
      harness: 'node scripts/validate_harness.mjs',
    },
  };
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
    chosen.set(matching[0].path, matching[0]);
  }
  return [...chosen.keys()].sort();
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
    outputDirectory: AUDIO_QC_DIR,
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
    } else if (['--worklist', '--output-dir'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--worklist') options.worklistPath = value;
      if (argument === '--output-dir') options.outputDirectory = value;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.worklistPath) throw new Error('--worklist is required');
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
      attestations: options.attestations,
      root: ROOT,
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
