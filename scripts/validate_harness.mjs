import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {
  isHumanReviewerIdentity,
  loadIntegrityPolicy,
  validateChangedCardSelfReviewParity,
} from './lib/card_integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');
const SCOPED_AUDIT_REPORT_DIR = 'reviews/audit_scopes/';
const PRE_CUTOVER_REPORT_INDEX = 'reports/pre-cutover-report-index.json';

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
const ANALYSIS_REFERENCE_CHECK_FIELDS = [
  'answer_matches_card',
  'choice_or_bank_references_match_source',
  'distractor_labels_match_explanations',
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
const REQUIRED_GOLDEN_TASKS = ['GT-CARD-001', 'GT-CARD-002', 'GT-CARD-003', 'GT-CARD-004', 'GT-CARD-005', 'GT-CARD-006'];
const REQUIRED_AUDIO_QC_CHECKS = [
  'audio_matches_text',
  'target_signal_audible',
  'accurate_pronunciation',
  'suitable_speed',
  'natural_rhythm',
  'stress_and_pauses_do_not_mislead',
  'no_unwanted_noise_or_clipping',
  'no_autoplay_assumption',
  'front_side_no_required_subtitles',
  'tts_audio_not_used_as_source_authenticity',
];
const REQUIRED_QUALITY_AUDIT_RULES = [
  'multiple_choice_no_options',
  'multiple_choice_answer_not_in_options',
  'front_leaks_correct_answer',
  'front_leaks_analysis_conclusion',
  'front_missing_or_too_short',
  'analysis_missing_or_too_short',
  'generic_front_pattern',
  'template_analysis_pattern',
  'exact_repeated_front',
  'exact_repeated_analysis',
  'missing_quality_metadata',
  'unverified_source',
  'synthetic_source',
];
const REQUIRED_SAMPLE_GATE_FIELDS = [
  'quality_metadata_per_card',
  'changed_candidate_card_integrity',
  'agent_self_review_record',
  'self_review_quality_metadata_matches_current_card_corpus',
  'blocker_scan_per_card',
  'analysis_reference_consistency_attestation',
  'card_quality_audit_no_hard_blockers',
  'scoped_card_quality_audit_report',
  'box_progression_roles',
  'TTS_audio_QC_plan_when_audio_exists',
  'no_standalone_hint_layer_interaction',
];
const REVIEW_RECORD_TEMPLATE_PATHS = new Set([
  'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
  'reviews/agent_self_review/TEMPLATE.json',
  'reviews/approved_batches/FULL_TRACK_TEMPLATE.json',
  'reviews/approved_batches/TEMPLATE.json',
  'reviews/sample_confirmations/TEMPLATE.json',
]);
const REQUIRED_GIT_HANDOFF_FIELDS = [
  'handoff_id',
  'created_at',
  'agent',
  'branch',
  'base_branch',
  'commit_sha',
  'push_ref',
  'PR_url',
  'PR_state',
  'is_draft',
  'scope',
  'validation',
  'local_status',
  'remaining_risks',
  'merge_authority',
];
const GIT_HANDOFF_TEMPLATE_PATH = 'reviews/git_handoffs/TEMPLATE.json';
const SEMANTIC_GIT_ENVIRONMENT = [
  'start from an empty child environment',
  'inherit only PATH, Path, PATHEXT, SystemRoot, SYSTEMROOT, WINDIR, COMSPEC, ComSpec, TMPDIR, TMP, and TEMP when present',
  'GIT_ATTR_NOSYSTEM=1',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=<canonical_null_device>',
  'GIT_CONFIG_SYSTEM=<canonical_null_device>',
  'GIT_GRAFT_FILE=<canonical_null_device>',
  'GIT_NO_REPLACE_OBJECTS=1',
  'LC_ALL=C',
  'LANG=C',
];
const V2_CANONICAL_ENVIRONMENT = [
  'start from an empty child environment',
  'inherit only PATH, Path, PATHEXT, SystemRoot, SYSTEMROOT, WINDIR, COMSPEC, ComSpec, TMPDIR, TMP, and TEMP when present',
  'do not inherit any other ambient variable, including GIT_* injection variables',
  'GIT_ATTR_NOSYSTEM=1',
  'GIT_ATTR_SOURCE=<commit_sha>',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=<canonical_null_device>',
  'GIT_CONFIG_SYSTEM=<canonical_null_device>',
  'GIT_GRAFT_FILE=<canonical_null_device>',
  'GIT_NO_REPLACE_OBJECTS=1',
  'LC_ALL=C',
  'LANG=C',
];
const V2_CANONICAL_GIT_CONFIG = [
  'color.ui=false',
  'core.bigFileThreshold=512m',
  'core.quotePath=true',
  'core.attributesFile=<canonical_null_device>',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
  'diff.algorithm=myers',
  'diff.compactionHeuristic=false',
  'diff.indentHeuristic=false',
  'diff.context=3',
  'diff.interHunkContext=0',
  'diff.suppressBlankEmpty=false',
  'diff.orderFile=<canonical_null_device>',
];
const V2_CANONICAL_DIFF_OPTIONS = [
  '--literal-pathspecs',
  'diff',
  '--binary',
  '--full-index',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--line-prefix=',
  '--unified=3',
  '--diff-algorithm=myers',
  '--no-indent-heuristic',
  '--inter-hunk-context=0',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
  '--output-indicator-new=+',
  '--output-indicator-old=-',
  '--output-indicator-context= ',
];
const REQUIRED_APPROVAL_FIELDS = [
  'approved_by_user',
  'approved_at',
  'scope',
  'summary',
  'card_quality_audit',
  'representative_cards',
  'validation',
];
const REQUIRED_QUALITY_AUDIT_RECORD_FIELDS = [
  'report',
  'corpus_fingerprint',
  'scope_has_no_hard_blockers',
  'scope_summary',
];
const REQUIRED_QUALITY_AUDIT_SCOPE_SUMMARY_FIELDS = [
  'card_ids',
  'card_count',
  'issue_count',
  'by_severity',
  'by_rule',
];
const QUALITY_AUDIT_SEVERITIES = ['hard_blocker', 'content_risk', 'review_gap', 'source_risk'];
const SELF_REVIEW_SCOPE_TYPES = ['three_card_sample_per_box', 'confirmed_box_expansion', 'residual_blocker_closure', 'full_track_remediation'];
const STANDARD_SELF_REVIEW_BATCH_STATUSES = ['recommend_user_confirmation', 'revise_before_user_review', 'blocked'];
const RESIDUAL_BLOCKER_CLOSURE_STATUS = 'documented_residual_closure';
const CONFIRMED_BOX_EXPANSION_STATUS = 'reviewed_confirmed_box_expansion';
const FULL_TRACK_READY_STATUS = 'ready_for_full_track_user_approval';
const PR_SCOPE_VALIDATION_COMMAND = 'node scripts/validate_pr_scope.mjs --base origin/fix/review-findings-card-contract --head HEAD';
const SCOPED_AUDIT_VALIDATION_COMMAND = 'node scripts/audit_card_quality.mjs --scope-card-ids <card_ids> --write-scope-report reviews/audit_scopes/<review_id>-scope-audit.json';
const CARD_INTEGRITY_TEST_COMMAND = 'node --test scripts/test_card_integrity.mjs';
const PR_SCOPE_TEST_COMMAND = 'node --test scripts/test_validate_pr_scope.mjs';
const DELIVERY_RECORD_TEST_COMMAND = 'node --test scripts/test_validate_delivery_record.mjs';

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

function isGlobalQualityAuditReport(reportPath) {
  return reportPath === 'reports/card_quality_audit_report.json';
}

function isScopedQualityAuditReport(reportPath) {
  return typeof reportPath === 'string' &&
    reportPath.startsWith(SCOPED_AUDIT_REPORT_DIR) &&
    reportPath.endsWith('.json') &&
    !reportPath.slice(SCOPED_AUDIT_REPORT_DIR.length).includes('/');
}

function listCardFiles() {
  return fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();
}

function countCards(files) {
  let count = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(CARD_DIR, file), 'utf8'));
    if (Array.isArray(data.cards)) count += data.cards.length;
  }
  return count;
}

function computeCardCorpusFingerprint() {
  const files = listCardFiles();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(CARD_DIR, file)));
    hash.update('\0');
  }
  return {
    algorithm: 'sha256',
    card_dir: path.relative(ROOT, CARD_DIR),
    file_count: files.length,
    card_count: countCards(files),
    digest: hash.digest('hex'),
  };
}

let cachedCurrentFingerprint = null;
let cachedCurrentScopedAuditFiles = null;
let cachedCurrentCardsById = null;
let cachedIntegrityPolicy = null;
const cachedCurrentTrackScopes = new Map();

function currentIntegrityPolicy() {
  if (!cachedIntegrityPolicy) cachedIntegrityPolicy = loadIntegrityPolicy(ROOT);
  return cachedIntegrityPolicy;
}

function currentCardsById() {
  if (cachedCurrentCardsById) return cachedCurrentCardsById;
  const cardsById = new Map();
  for (const file of listCardFiles()) {
    const data = JSON.parse(fs.readFileSync(path.join(CARD_DIR, file), 'utf8'));
    for (const card of data.cards || []) {
      if (!hasText(card?.card_id)) continue;
      const matches = cardsById.get(card.card_id) || [];
      matches.push({card, file});
      cardsById.set(card.card_id, matches);
    }
  }
  cachedCurrentCardsById = cardsById;
  return cachedCurrentCardsById;
}

function currentTrackCorpusScope(track) {
  if (cachedCurrentTrackScopes.has(track)) {
    return cachedCurrentTrackScopes.get(track);
  }

  const cardIds = [];
  const boxPrefixes = [];
  const cardsMissingId = [];
  const cardsMissingBoxPrefix = [];
  for (const file of listCardFiles()) {
    const data = JSON.parse(fs.readFileSync(path.join(CARD_DIR, file), 'utf8'));
    for (const card of data.cards || []) {
      if (card?.track !== track) continue;
      if (hasText(card.card_id)) cardIds.push(card.card_id);
      else cardsMissingId.push(file);
      if (hasText(card.knowledge_ref?.box_prefix)) {
        boxPrefixes.push(card.knowledge_ref.box_prefix);
      } else {
        cardsMissingBoxPrefix.push(card.card_id || file);
      }
    }
  }

  const result = {
    cardIds,
    boxPrefixes: [...new Set(boxPrefixes)].sort(),
    duplicateCardIds: cardIds.filter((cardId, index) => cardIds.indexOf(cardId) !== index),
    cardsMissingId,
    cardsMissingBoxPrefix,
  };
  cachedCurrentTrackScopes.set(track, result);
  return result;
}

function currentCardCorpusFingerprint() {
  if (!cachedCurrentFingerprint) cachedCurrentFingerprint = computeCardCorpusFingerprint();
  return cachedCurrentFingerprint;
}

function buildEphemeralCardQualityAudit(errors) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-quality-audit-'));
  const reportPath = path.join(tempDir, 'card_quality_audit_report.json');
  try {
    execFileSync(process.execPath, ['scripts/audit_card_quality.mjs', '--report-path', reportPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    pushIssue(errors, 'card_quality_audit_ephemeral_report_failed', {
      message: error.message,
      output: String(error.stdout || error.stderr || '').slice(0, 1000),
    });
    return null;
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
}

function listScopedAuditReportFiles() {
  const full = resolveWorkspacePath(SCOPED_AUDIT_REPORT_DIR);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
  return fs.readdirSync(full)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => `${SCOPED_AUDIT_REPORT_DIR}${file}`);
}

function currentScopedAuditReportFiles() {
  if (cachedCurrentScopedAuditFiles) return cachedCurrentScopedAuditFiles;

  const currentDigest = currentCardCorpusFingerprint().digest;
  cachedCurrentScopedAuditFiles = listScopedAuditReportFiles().filter(file => {
    try {
      const report = readJson(file);
      return report.report_type === 'scoped_card_quality_audit' &&
        report.corpus_fingerprint?.digest === currentDigest &&
        Array.isArray(report.scope?.card_ids) &&
        report.scope.card_ids.length > 0 &&
        report.scoped_card_issue_index &&
        typeof report.scoped_card_issue_index === 'object';
    } catch {
      return false;
    }
  });
  return cachedCurrentScopedAuditFiles;
}

function allowsStaleGlobalAuditReportForScopedCandidate() {
  return currentScopedAuditReportFiles().length > 0;
}

function pushIssue(list, code, details) {
  list.push({ code, ...details });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

let cachedPreCutoverReportIndex = null;
let cachedPreCutoverIntroduction = undefined;
const cachedPreCutoverRecords = new Map();

function canonicalJsonSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bytesSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitOutput(args, {encoding = 'utf8'} = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function preCutoverIntroduction() {
  if (cachedPreCutoverIntroduction !== undefined) {
    return cachedPreCutoverIntroduction;
  }
  try {
    const commits = gitOutput([
      'log',
      '--format=%H',
      '--diff-filter=A',
      '--',
      PRE_CUTOVER_REPORT_INDEX,
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (commits.length !== 1) {
      cachedPreCutoverIntroduction = {commit: null, commits};
      return cachedPreCutoverIntroduction;
    }
    const commit = commits[0];
    const indexBytes = gitOutput(
      ['show', `${commit}:${PRE_CUTOVER_REPORT_INDEX}`],
      {encoding: 'buffer'},
    );
    cachedPreCutoverIntroduction = {
      commit,
      commits,
      indexBytes,
      index: JSON.parse(indexBytes.toString('utf8')),
    };
  } catch (error) {
    cachedPreCutoverIntroduction = {
      commit: null,
      commits: [],
      error: error.message,
    };
  }
  return cachedPreCutoverIntroduction;
}

function preCutoverRecord(recordPath) {
  if (cachedPreCutoverRecords.has(recordPath)) {
    return cachedPreCutoverRecords.get(recordPath);
  }
  const introduction = preCutoverIntroduction();
  if (!introduction.commit) return null;
  try {
    const bytes = gitOutput(
      ['show', `${introduction.commit}:${recordPath}`],
      {encoding: 'buffer'},
    );
    const result = {
      bytes,
      record: JSON.parse(bytes.toString('utf8')),
    };
    cachedPreCutoverRecords.set(recordPath, result);
    return result;
  } catch {
    cachedPreCutoverRecords.set(recordPath, null);
    return null;
  }
}

function preCutoverReportIndex() {
  if (!cachedPreCutoverReportIndex && exists(PRE_CUTOVER_REPORT_INDEX)) {
    cachedPreCutoverReportIndex = readJson(PRE_CUTOVER_REPORT_INDEX);
  }
  return cachedPreCutoverReportIndex;
}

function isImmutablePreCutoverRecord(source, record) {
  const index = preCutoverReportIndex();
  const reference = (index?.legacy_references || []).find(entry => entry.record === source);
  const cutoverRecord = reference ? preCutoverRecord(source) : null;
  return Boolean(
    reference &&
    cutoverRecord &&
    isDeepStrictEqual(record, cutoverRecord.record),
  );
}

function validatePreCutoverReportIndex(errors) {
  const index = preCutoverReportIndex();
  if (!index) {
    pushIssue(errors, 'pre_cutover_report_index_missing', {path: PRE_CUTOVER_REPORT_INDEX});
    return;
  }
  if (index.schema_version !== 'pre-cutover-report-index.v1') {
    pushIssue(errors, 'pre_cutover_report_index_schema_invalid', {schema_version: index.schema_version});
  }
  if (!/^[0-9a-f]{40}$/.test(String(index.source_commit || ''))) {
    pushIssue(errors, 'pre_cutover_report_index_source_commit_invalid', {});
  }
  if (!/^[0-9a-f]{64}$/.test(String(index.archive?.sha256 || '')) || !Number.isInteger(index.archive?.size_bytes)) {
    pushIssue(errors, 'pre_cutover_report_index_archive_invalid', {});
  }
  const introduction = preCutoverIntroduction();
  if (!introduction.commit) {
    pushIssue(errors, 'pre_cutover_report_index_introduction_unprovable', {
      commits: introduction.commits,
      error: introduction.error,
    });
  } else {
    const currentIndexBytes = fs.readFileSync(resolveWorkspacePath(PRE_CUTOVER_REPORT_INDEX));
    if (bytesSha256(currentIndexBytes) !== bytesSha256(introduction.indexBytes)) {
      pushIssue(errors, 'pre_cutover_report_index_not_immutable', {
        path: PRE_CUTOVER_REPORT_INDEX,
        introduction_commit: introduction.commit,
      });
    }
  }
  const reports = Array.isArray(index.reports) ? index.reports : [];
  for (const reportPath of ['reports/card_quality_audit_report.json', 'reports/card_validation_report.json']) {
    const report = reports.find(entry => entry.path === reportPath);
    if (!report || !/^[0-9a-f]{64}$/.test(String(report.sha256 || '')) || !Number.isInteger(report.size_bytes)) {
      pushIssue(errors, 'pre_cutover_report_entry_invalid', {report: reportPath});
    }
    if (exists(reportPath)) pushIssue(errors, 'pre_cutover_global_report_still_tracked', {report: reportPath});
  }
  const references = Array.isArray(index.legacy_references) ? index.legacy_references : [];
  for (const reference of references) {
    if (!exists(reference.record)) {
      pushIssue(errors, 'pre_cutover_report_reference_record_missing', {record: reference.record});
      continue;
    }
    const record = readJson(reference.record);
    const auditRecord = record.quality_audit || record.card_quality_audit;
    if (reference.report !== auditRecord?.report || reference.corpus_fingerprint !== auditRecord?.corpus_fingerprint) {
      pushIssue(errors, 'pre_cutover_report_reference_drift', {record: reference.record});
    }
    if (reference.audit_record_sha256 !== canonicalJsonSha256(auditRecord)) {
      pushIssue(errors, 'pre_cutover_report_reference_hash_mismatch', {record: reference.record});
    }
    const cutoverRecord = preCutoverRecord(reference.record);
    if (!cutoverRecord) {
      pushIssue(errors, 'pre_cutover_report_reference_cutover_record_missing', {
        record: reference.record,
        introduction_commit: introduction.commit,
      });
      continue;
    }
    const cutoverAuditRecord =
      cutoverRecord.record.quality_audit || cutoverRecord.record.card_quality_audit;
    if (
      reference.report !== cutoverAuditRecord?.report ||
      reference.corpus_fingerprint !== cutoverAuditRecord?.corpus_fingerprint ||
      reference.audit_record_sha256 !== canonicalJsonSha256(cutoverAuditRecord)
    ) {
      pushIssue(errors, 'pre_cutover_report_reference_not_proven_at_cutover', {
        record: reference.record,
        introduction_commit: introduction.commit,
      });
    }
    const currentRecordBytes = fs.readFileSync(resolveWorkspacePath(reference.record));
    if (bytesSha256(currentRecordBytes) !== bytesSha256(cutoverRecord.bytes)) {
      pushIssue(errors, 'pre_cutover_report_reference_record_not_immutable', {
        record: reference.record,
        introduction_commit: introduction.commit,
      });
    }
  }
}

function validateArchivedGlobalAuditReference(auditRecord, errors, source) {
  const index = preCutoverReportIndex();
  if (!index) return false;
  const reference = (index.legacy_references || []).find(entry => entry.record === source && entry.report === auditRecord.report);
  if (!reference) {
    pushIssue(errors, 'quality_audit_archived_reference_missing', {source, report: auditRecord.report});
    return true;
  }
  if (reference.corpus_fingerprint !== auditRecord.corpus_fingerprint) {
    pushIssue(errors, 'quality_audit_archived_fingerprint_mismatch', {source});
  }
  if (reference.audit_record_sha256 !== canonicalJsonSha256(auditRecord)) {
    pushIssue(errors, 'quality_audit_archived_record_hash_mismatch', {source});
  }
  return true;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyTextArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(hasText);
}

function hasUniqueNonEmptyTextArray(value) {
  return hasNonEmptyTextArray(value) && new Set(value).size === value.length;
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

function sortedStrings(values) {
  return [...stringSet(values)].sort();
}

function numericCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function emptySeverityCounts() {
  return Object.fromEntries(QUALITY_AUDIT_SEVERITIES.map(severity => [severity, 0]));
}

function buildScopedAuditSummary(report, scopeCardIds) {
  const ids = sortedStrings(scopeCardIds);
  const summary = {
    card_ids: ids,
    card_count: ids.length,
    issue_count: 0,
    by_severity: emptySeverityCounts(),
    by_rule: Object.fromEntries(REQUIRED_QUALITY_AUDIT_RULES.map(ruleId => [ruleId, 0])),
  };
  const missingCardIds = [];
  const index = report.card_issue_index || {};

  for (const cardId of ids) {
    const record = index[cardId];
    if (!record) {
      missingCardIds.push(cardId);
      continue;
    }
    summary.issue_count += numericCount(record.issue_count);
    for (const severity of QUALITY_AUDIT_SEVERITIES) {
      summary.by_severity[severity] += numericCount(record.by_severity?.[severity]);
    }
    for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
      summary.by_rule[ruleId] += numericCount(record.by_rule?.[ruleId]);
    }
  }

  return { summary, missingCardIds };
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

  const maxAuthority = workspace.content_boundary?.agent_max_authority || [];
  if (!maxAuthority.includes('auto_merge_validated_harness_or_tooling_PRs_under_standing_user_delegation')) {
    pushIssue(errors, 'workspace_auto_merge_authority_missing', {});
  }

  const forbiddenAuthority = workspace.content_boundary?.agent_forbidden_authority || [];
  if (forbiddenAuthority.includes('auto_merge_harness_or_formal_content')) {
    pushIssue(errors, 'workspace_legacy_auto_merge_forbidden_authority_present', {});
  }
  for (const forbidden of [
    'auto_merge_without_standing_or_explicit_user_authorization',
    'auto_merge_formal_content_without_user_confirmed_sample_and_scope_delegation',
  ]) {
    if (!forbiddenAuthority.includes(forbidden)) {
      pushIssue(errors, 'workspace_auto_merge_forbidden_authority_missing', { forbidden });
    }
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
  if (quality.tts_policy?.audio_generation_contract !== 'spec/audio-generation-contract.json') {
    pushIssue(errors, 'tts_audio_generation_contract_missing', {});
  }
  if (quality.tts_policy?.audio_source_type_is_separate_from_text_source_type !== true) {
    pushIssue(errors, 'tts_text_audio_separation_missing', {});
  }
  if (quality.tts_policy?.formal_audio_use_requires_audio_qc_record !== true) {
    pushIssue(errors, 'tts_formal_audio_qc_policy_missing', {});
  }
  for (const check of ['audio_matches_text', 'target_signal_audible_when_card_trains_pronunciation_or_listening_signal']) {
    if (!(quality.tts_policy?.tts_audio_quality_checks || []).includes(check)) {
      pushIssue(errors, 'tts_audio_quality_check_missing', { check });
    }
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

  const integrity = quality.candidate_integrity_policy || {};
  if (!String(integrity.legacy_metadata_compatibility || '').includes('Untouched legacy cards')) {
    pushIssue(errors, 'candidate_integrity_legacy_boundary_missing', {});
  }
  if (!String(integrity.changed_candidate_detection || '').includes('merge-base-to-head')) {
    pushIssue(errors, 'candidate_integrity_diff_discovery_missing', {});
  }
  if (
    !String(integrity.governed_review_path_detection || '').includes('without') ||
    !String(integrity.governed_review_path_detection || '').includes('four-digit box prefix') ||
    !String(integrity.governed_review_path_detection || '').includes('five exact repository-declared templates') ||
    !String(integrity.governed_review_path_detection || '').includes('reviews/approved_batches') ||
    !String(integrity.governed_review_path_detection || '').includes('reviews/sample_confirmations') ||
    !String(integrity.governed_review_path_detection || '').includes('approval records') ||
    !String(integrity.governed_review_path_detection || '').includes('unknown filenames')
  ) {
    pushIssue(errors, 'candidate_integrity_unprefixed_review_path_boundary_missing', {});
  }
  if (
    !String(integrity.current_scoped_audit_snapshot || '').includes('complete card_boxes_json tree') ||
    !String(integrity.current_scoped_audit_snapshot || '').includes('immutable HEAD commit')
  ) {
    pushIssue(errors, 'candidate_integrity_head_audit_snapshot_missing', {});
  }
  if (integrity.self_review_parity?.changed_self_review_required !== true) {
    pushIssue(errors, 'candidate_integrity_changed_self_review_not_required', {});
  }
  if (integrity.self_review_parity?.exactly_one_review_coverage_per_changed_card !== true) {
    pushIssue(errors, 'candidate_integrity_unique_review_coverage_not_required', {});
  }
  if (integrity.self_review_parity?.standard_review_snapshot_required !== true) {
    pushIssue(errors, 'candidate_integrity_standard_snapshot_not_required', {});
  }
  if (integrity.self_review_parity?.every_changed_self_review_entry_checked_against_head !== true) {
    pushIssue(errors, 'candidate_integrity_review_only_parity_not_required', {});
  }
  if (integrity.self_review_parity?.scope_omission_cannot_bypass_validation !== true) {
    pushIssue(errors, 'candidate_integrity_scope_bypass_not_forbidden', {});
  }
  const fullTrackBoundary = String(integrity.self_review_parity?.full_track_aggregate_boundary || '');
  if (
    !fullTrackBoundary.includes('coverage.reviewed_card_ids') ||
    !fullTrackBoundary.includes('exactly-one review coverage') ||
    !fullTrackBoundary.includes('without a cards property') ||
    !fullTrackBoundary.includes('complete declared track') ||
    !fullTrackBoundary.includes('merge-base and HEAD card ID sets')
  ) {
    pushIssue(errors, 'candidate_integrity_full_track_aggregate_boundary_missing', {});
  }
  const parityDescription = String(integrity.self_review_parity?.quality_metadata_comparison || '');
  const statusSemantics = String(integrity.self_review_parity?.review_status_semantics || '');
  if (!parityDescription.includes('every quality_metadata field except review_status')) {
    pushIssue(errors, 'candidate_integrity_metadata_parity_incomplete', {});
  }
  if (!statusSemantics.includes('only parity exclusion')) {
    pushIssue(errors, 'candidate_integrity_review_status_exception_unbounded', {});
  }
  if (integrity.elimination_integrity?.canonical_items_field !== 'elimination_items') {
    pushIssue(errors, 'candidate_integrity_elimination_canonical_field_drift', {});
  }
  if (integrity.elimination_integrity?.legacy_preview_mirror_field !== 'eliminable_items') {
    pushIssue(errors, 'candidate_integrity_elimination_mirror_field_drift', {});
  }
  if (integrity.elimination_integrity?.legacy_preview_mirror_required_while_reader_depends_on_it !== true) {
    pushIssue(errors, 'candidate_integrity_elimination_mirror_not_required', {});
  }
  if (!String(integrity.elimination_integrity?.canonical_item_shape || '').includes('{id,text}')) {
    pushIssue(errors, 'candidate_integrity_elimination_runtime_id_shape_missing', {});
  }
  if (!String(integrity.elimination_integrity?.answer_truth || '').includes('runtime IDs')) {
    pushIssue(errors, 'candidate_integrity_elimination_id_answer_truth_missing', {});
  }
  if (!String(integrity.elimination_integrity?.untouched_legacy_compatibility || '').includes('global read-only validation')) {
    pushIssue(errors, 'candidate_integrity_elimination_legacy_boundary_missing', {});
  }
  if (integrity.elimination_integrity?.duplicate_item_identity !== 'forbidden') {
    pushIssue(errors, 'candidate_integrity_elimination_duplicate_identity_not_forbidden', {});
  }
}

function validateAudioGenerationContract(errors) {
  const manifest = readJson('spec/doc-manifest.json');
  const activePaths = new Set((manifest.active_docs || []).map(doc => doc.path));
  for (const path of [
    'spec/audio-generation-contract.json',
    'spec/audio-perceptual-worklist.schema.json',
    'scripts/manage_audio_perceptual_worklist.mjs',
    'scripts/validate_audio_qc.mjs',
    'reviews/audio_qc/README.md',
    'reviews/audio_qc/TEMPLATE.json',
    'reviews/audio_perceptual_worklists/README.md',
  ]) {
    if (!activePaths.has(path)) {
      pushIssue(errors, 'audio_generation_manifest_entry_missing', { path });
    }
  }

  const authorityMap = readJson('spec/authority-map.json');
  if (authorityMap.owners?.audio_generation_and_qc !== 'spec/audio-generation-contract.json') {
    pushIssue(errors, 'audio_generation_owner_drift', {
      owner: authorityMap.owners?.audio_generation_and_qc,
    });
  }
  if (authorityMap.owners?.audio_qc_records !== 'reviews/audio_qc/TEMPLATE.json') {
    pushIssue(errors, 'audio_qc_records_owner_drift', {
      owner: authorityMap.owners?.audio_qc_records,
    });
  }
  if (
    authorityMap.owners?.audio_perceptual_worklists !==
    'spec/audio-perceptual-worklist.schema.json'
  ) {
    pushIssue(errors, 'audio_perceptual_worklist_owner_drift', {
      owner: authorityMap.owners?.audio_perceptual_worklists,
    });
  }
  const worklistSchema = readJson('spec/audio-perceptual-worklist.schema.json');
  if (worklistSchema.schema_version !== 'audio-perceptual-worklist.v2') {
    pushIssue(errors, 'audio_perceptual_worklist_schema_version_drift', {
      schema_version: worklistSchema.schema_version,
    });
  }
  for (const field of [
    'full_track_technical_audit_remains_required_for_scoped_worklists',
    'scoped_card_ids_must_be_non_empty_unique_current_audio_cards',
    'scope_card_order_is_canonical_corpus_order',
    'scope_expected_entry_count_required',
    'full_track_audio_card_count_required',
    'scope_card_ids_fingerprint_required',
    'worklist_entries_must_exactly_equal_declared_scope',
  ]) {
    if (worklistSchema.scope_requirements?.[field] !== true) {
      pushIssue(errors, 'audio_perceptual_worklist_scope_guard_missing', {field});
    }
  }
  if (worklistSchema.scope_requirements?.legacy_v1_scope !== 'full_track_only') {
    pushIssue(errors, 'audio_perceptual_worklist_legacy_scope_drift', {});
  }

  const contract = readJson('spec/audio-generation-contract.json');
  if (contract.status !== 'active') {
    pushIssue(errors, 'audio_generation_contract_not_active', { status: contract.status });
  }
  if (contract.asset_policy?.asset_dir !== 'ai_tts/') {
    pushIssue(errors, 'audio_asset_dir_drift', { asset_dir: contract.asset_policy?.asset_dir });
  }
  for (const field of [
    'audio_is_content_medium_not_interaction_family',
    'tts_audio_never_proves_source_authenticity',
    'no_autoplay',
    'front_side_subtitles_not_required',
  ]) {
    if (contract.asset_policy?.[field] !== true) {
      pushIssue(errors, 'audio_asset_policy_flag_missing', { field });
    }
  }
  for (const field of [
    'existing_tts_assets_allowed_for_candidate_samples',
    'must_mark_sample_only_when_audio_unreviewed',
    'must_not_claim_formal_audio_quality',
    'candidate_metadata_must_keep_text_source_type_separate_from_audio_generation_method',
  ]) {
    if (contract.candidate_policy?.[field] !== true) {
      pushIssue(errors, 'audio_candidate_policy_flag_missing', { field });
    }
  }
  if (contract.text_gate_before_generation?.required !== true) {
    pushIssue(errors, 'audio_text_gate_not_required', {});
  }
  for (const check of readJson('spec/content-quality-contract.json').tts_policy?.tts_text_quality_checks || []) {
    if (!(contract.text_gate_before_generation?.required_checks || []).includes(check)) {
      pushIssue(errors, 'audio_text_gate_check_missing', { check });
    }
  }
  for (const field of [
    'card_id',
    'transcript',
    'target_signal',
    'pronunciation_notes',
    'method',
    'voice_or_speaker',
    'speed',
    'style_notes',
    'output_path',
    'provenance_note',
  ]) {
    if (!(contract.generation_plan_required_fields || []).includes(field)) {
      pushIssue(errors, 'audio_generation_plan_field_missing', { field });
    }
  }
  for (const method of ['TTS_AI_generated', 'human_recorded', 'none']) {
    if (!(contract.allowed_generation_methods || []).includes(method)) {
      pushIssue(errors, 'audio_generation_method_missing', { method });
    }
  }
  if (!(contract.legacy_generation_method_aliases || []).includes('tts')) {
    pushIssue(errors, 'audio_legacy_tts_alias_missing', {});
  }
  if (contract.legacy_asset_adoption_policy?.same_quality_gate_as_new_audio !== true) {
    pushIssue(errors, 'audio_legacy_adoption_quality_gate_missing', {});
  }
  for (const forbidden of ['invent_provider_or_voice', 'claim_reproducibility', 'skip_transcript_or_perceptual_review']) {
    if (!(contract.legacy_asset_adoption_policy?.must_not || []).includes(forbidden)) {
      pushIssue(errors, 'audio_legacy_adoption_forbidden_rule_missing', { forbidden });
    }
  }
  if (contract.pronunciation_target_policy?.required_for_listening_pronunciation_boxes !== true) {
    pushIssue(errors, 'audio_pronunciation_target_policy_missing', {});
  }
  if (contract.pronunciation_target_policy?.target_signal_must_be_audible_in_generated_audio !== true) {
    pushIssue(errors, 'audio_target_signal_policy_missing', {});
  }
  if (contract.formal_audio_qc?.record_dir !== 'reviews/audio_qc/') {
    pushIssue(errors, 'audio_qc_record_dir_drift', { record_dir: contract.formal_audio_qc?.record_dir });
  }
  if (contract.formal_audio_qc?.template !== 'reviews/audio_qc/TEMPLATE.json') {
    pushIssue(errors, 'audio_qc_template_path_drift', { template: contract.formal_audio_qc?.template });
  }
  if (contract.formal_audio_qc?.validator !== 'scripts/validate_audio_qc.mjs') {
    pushIssue(errors, 'audio_qc_validator_path_drift', { validator: contract.formal_audio_qc?.validator });
  }
  if (contract.formal_audio_qc?.required_before_formal_audio_use !== true) {
    pushIssue(errors, 'formal_audio_qc_not_required', {});
  }
  const worklist = contract.perceptual_review_worklist || {};
  if (
    worklist.schema !== 'spec/audio-perceptual-worklist.schema.json' ||
    worklist.manager !== 'scripts/manage_audio_perceptual_worklist.mjs' ||
    worklist.reviewed_worklist_dir !== 'reviews/audio_perceptual_worklists/'
  ) {
    pushIssue(errors, 'audio_perceptual_worklist_paths_drift', {});
  }
  for (const field of [
    'source_requires_passing_technical_audit',
    'scoped_worklist_requires_complete_track_technical_audit',
    'scoped_worklist_requires_exact_non_empty_card_ids_and_fingerprint',
    'legacy_v1_is_full_track_only',
    'one_card_per_review_action',
    'human_reviewer_required',
    'full_asset_listening_attestation_required',
    'reviewed_identity_change_fails_closed',
    'passing_worklist_is_not_formal_audio_qc',
    'formal_audio_qc_record_still_required',
  ]) {
    if (worklist[field] !== true) {
      pushIssue(errors, 'audio_perceptual_worklist_guard_missing', {field});
    }
  }
  if (worklist.agent_may_mark_passed !== false) {
    pushIssue(errors, 'audio_perceptual_worklist_agent_pass_boundary_missing', {});
  }
  if (!exists('scripts/manage_audio_perceptual_worklist.mjs')) {
    pushIssue(errors, 'audio_perceptual_worklist_manager_missing', {});
  } else {
    const manager = readText('scripts/manage_audio_perceptual_worklist.mjs');
    for (const token of [
      'audio-perceptual-worklist.v1',
      'audio-perceptual-worklist.v2',
      '--scope-card-ids',
      'full_track_audio_card_count',
      'card_ids_fingerprint',
      'agent_may_mark_passed',
      'one_card_per_review_action',
      'Reviewed audio identity changed',
      'Terminal audio review entries cannot be overwritten',
      '--allow-reviewed-reset',
      '--attest-listened',
      '--require-complete',
    ]) {
      if (!manager.includes(token)) {
        pushIssue(errors, 'audio_perceptual_worklist_manager_guard_missing', {token});
      }
    }
  }
  for (const check of REQUIRED_AUDIO_QC_CHECKS) {
    if (!(contract.formal_audio_qc?.required_checks || []).includes(check)) {
      pushIssue(errors, 'audio_qc_required_check_missing', { check });
    }
  }
  for (const failure of [
    'target_signal_missing_or_misleading',
    'source_authenticity_claim_from_tts',
    'formal_audio_ready_without_user_content_approval_boundary',
  ]) {
    if (!(contract.formal_audio_qc?.blocking_failures || []).includes(failure)) {
      pushIssue(errors, 'audio_qc_blocking_failure_missing', { failure });
    }
  }
  for (const field of [
    'do_not_replace_audio_in_content_sample_PRs',
    'audio_asset_changes_belong_in_audio_or_tooling_branch',
    'replacement_requires_audio_qc_record',
    'bulk_generation_requires_user_confirmed_sample_scope',
  ]) {
    if (contract.asset_change_policy?.[field] !== true) {
      pushIssue(errors, 'audio_asset_change_policy_missing', { field });
    }
  }
  for (const command of ['node scripts/validate_audio_qc.mjs', 'node scripts/validate_harness.mjs']) {
    if (!(contract.validation_commands || []).includes(command)) {
      pushIssue(errors, 'audio_validation_command_missing', { command });
    }
  }

  if (!exists('reviews/audio_qc/TEMPLATE.json')) {
    pushIssue(errors, 'audio_qc_template_missing', {});
  } else {
    const template = readJson('reviews/audio_qc/TEMPLATE.json');
    for (const field of [
      'audio_qc_id',
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
    ]) {
      if (!hasOwn(template, field)) {
        pushIssue(errors, 'audio_qc_template_field_missing', { field });
      }
    }
    for (const check of REQUIRED_AUDIO_QC_CHECKS) {
      if (typeof template.qa_checks?.[check] !== 'boolean') {
        pushIssue(errors, 'audio_qc_template_check_missing', { check });
      }
    }
    if (template.approval_boundary?.tts_audio_is_not_source_authenticity_evidence !== true) {
      pushIssue(errors, 'audio_qc_template_tts_boundary_missing', {});
    }
    if (template.approval_boundary?.formal_content_approval_still_requires_user !== true) {
      pushIssue(errors, 'audio_qc_template_user_approval_boundary_missing', {});
    }
  }

  if (!exists('scripts/validate_audio_qc.mjs')) {
    pushIssue(errors, 'audio_qc_validator_missing', {});
  } else {
    const script = readText('scripts/validate_audio_qc.mjs');
    for (const token of [
      'audio_qc_formal_ready_with_failed_check',
      'audio_qc_source_authenticity_boundary_missing',
      'audio_qc_legacy_asset_hash_missing',
      'audio_qc_legacy_provider_must_be_unknown',
      'target_signal_audible',
      'ai_tts/',
    ]) {
      if (!script.includes(token)) {
        pushIssue(errors, 'audio_qc_validator_guard_missing', { token });
      }
    }
    try {
      const output = execFileSync(process.execPath, ['scripts/validate_audio_qc.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const validation = JSON.parse(output);
      if (validation.ok !== true) {
        pushIssue(errors, 'audio_qc_validator_failed', { output: validation });
      }
    } catch (error) {
      pushIssue(errors, 'audio_qc_validator_failed', {
        message: error.message,
        output: String(error.stdout || error.stderr || '').slice(0, 1000),
      });
    }
  }
}

function validateCardQualityAudit(errors, warnings) {
  validatePreCutoverReportIndex(errors);
  const manifest = readJson('spec/doc-manifest.json');
  const activePaths = new Set((manifest.active_docs || []).map(doc => doc.path));
  for (const path of ['spec/card-quality-audit.json', 'scripts/audit_card_quality.mjs']) {
    if (!activePaths.has(path)) {
      pushIssue(errors, 'card_quality_audit_manifest_entry_missing', { path });
    }
  }

  const authorityMap = readJson('spec/authority-map.json');
  if (authorityMap.owners?.card_quality_audit_rules !== 'spec/card-quality-audit.json') {
    pushIssue(errors, 'card_quality_audit_rules_owner_drift', {});
  }
  if (authorityMap.owners?.card_quality_audit_tool !== 'scripts/audit_card_quality.mjs') {
    pushIssue(errors, 'card_quality_audit_tool_owner_drift', {});
  }

  const audit = readJson('spec/card-quality-audit.json');
  if (audit.status !== 'active') {
    pushIssue(errors, 'card_quality_audit_not_active', { status: audit.status });
  }
  if (audit.mode !== 'read_only_non_blocking_for_legacy_corpus') {
    pushIssue(errors, 'card_quality_audit_mode_drift', { mode: audit.mode });
  }
  if (audit.report_path !== 'reports/card_quality_audit_report.json') {
    pushIssue(errors, 'card_quality_audit_report_path_drift', { report_path: audit.report_path });
  }
  if (audit.scoped_report_dir !== SCOPED_AUDIT_REPORT_DIR) {
    pushIssue(errors, 'card_quality_audit_scoped_report_dir_drift', {
      scoped_report_dir: audit.scoped_report_dir,
    });
  }
  if (audit.scoped_report_contract?.report_type !== 'scoped_card_quality_audit') {
    pushIssue(errors, 'card_quality_audit_scoped_report_contract_missing', {});
  }
  for (const field of ['ok', 'audit_version', 'mode', 'report_type', 'corpus_fingerprint', 'scope', 'scope_summary', 'scoped_card_issue_index', 'scoped_hard_blocker_issues']) {
    if (!(audit.scoped_report_contract?.must_include || []).includes(field)) {
      pushIssue(errors, 'card_quality_audit_scoped_report_field_missing', { field });
    }
  }
  if (!String(audit.scoped_report_contract?.ok_semantics || '').includes('scoped_hard_blocker_issues is empty')) {
    pushIssue(errors, 'card_quality_audit_scoped_report_ok_semantics_missing', {});
  }
  if (audit.script_path !== 'scripts/audit_card_quality.mjs') {
    pushIssue(errors, 'card_quality_audit_script_path_drift', { script_path: audit.script_path });
  }

  const severities = new Set((audit.severity_levels || []).map(level => level.id));
  for (const severity of ['hard_blocker', 'content_risk', 'review_gap', 'source_risk']) {
    if (!severities.has(severity)) {
      pushIssue(errors, 'card_quality_audit_severity_missing', { severity });
    }
  }

  const rules = new Map((audit.rules || []).map(rule => [rule.id, rule]));
  const expectedRuleSeverity = {
    multiple_choice_no_options: 'hard_blocker',
    multiple_choice_answer_not_in_options: 'hard_blocker',
    front_leaks_correct_answer: 'hard_blocker',
    front_leaks_analysis_conclusion: 'hard_blocker',
    front_missing_or_too_short: 'content_risk',
    analysis_missing_or_too_short: 'content_risk',
    generic_front_pattern: 'content_risk',
    template_analysis_pattern: 'content_risk',
    exact_repeated_front: 'content_risk',
    exact_repeated_analysis: 'content_risk',
    missing_quality_metadata: 'review_gap',
    unverified_source: 'source_risk',
    synthetic_source: 'source_risk',
  };
  for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
    const rule = rules.get(ruleId);
    if (!rule) {
      pushIssue(errors, 'card_quality_audit_rule_missing', { ruleId });
      continue;
    }
    if (rule.severity !== expectedRuleSeverity[ruleId]) {
      pushIssue(errors, 'card_quality_audit_rule_severity_drift', {
        ruleId,
        expected: expectedRuleSeverity[ruleId],
        actual: rule.severity,
      });
    }
  }

  const candidatePolicy = [
    ...(audit.candidate_scope_policy?.before_user_sample_review || []),
    ...(audit.candidate_scope_policy?.formal_batch_scope || []),
  ];
  for (const requirement of [
    'scoped_report_must_match_current_card_corpus_fingerprint',
    'agent_self_review_must_link_current_scoped_quality_audit_report',
    'agent_self_review_must_include_scoped_quality_audit_summary',
    'scope_must_have_no_hard_blocker_issues',
    'no_hard_blocker_issues',
    'approval_record_must_link_current_scoped_quality_audit_report',
    'linked_current_quality_audit_report',
    'explicit_user_confirmation',
  ]) {
    if (!candidatePolicy.includes(requirement)) {
      pushIssue(errors, 'card_quality_audit_candidate_policy_missing', { requirement });
    }
  }
  if (audit.pre_cutover_report_archive?.new_or_changed_review_records_must_use_current_scoped_report !== true) {
    pushIssue(errors, 'pre_cutover_new_review_scoped_audit_policy_missing', {});
  }
  if (
    !String(audit.pre_cutover_report_archive?.active_repository_immutability_proof || '')
      .includes('index bytes') ||
    !String(audit.pre_cutover_report_archive?.active_repository_immutability_proof || '')
      .includes('review-record byte sequence')
  ) {
    pushIssue(errors, 'pre_cutover_record_immutability_policy_missing', {});
  }
  if (audit.report_freshness_policy?.fingerprint_algorithm !== 'sha256') {
    pushIssue(errors, 'card_quality_audit_fingerprint_algorithm_drift', {
      algorithm: audit.report_freshness_policy?.fingerprint_algorithm,
    });
  }
  if (audit.report_freshness_policy?.validator_must_recompute_fingerprint !== true) {
    pushIssue(errors, 'card_quality_audit_recompute_policy_missing', {});
  }
  if (audit.report_freshness_policy?.stale_report_is_harness_error !== true) {
    pushIssue(errors, 'card_quality_audit_stale_report_policy_missing', {});
  }
  const scopedCandidateException = audit.report_freshness_policy?.candidate_scoped_evidence_exception || '';
  if (!scopedCandidateException.includes('current scoped audit report') || !scopedCandidateException.includes('validate_pr_scope')) {
    pushIssue(errors, 'card_quality_audit_scoped_candidate_exception_missing', {});
  }

  const script = readText('scripts/audit_card_quality.mjs');
  for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
    if (!script.includes(ruleId)) {
      pushIssue(errors, 'card_quality_audit_script_rule_missing', { ruleId });
    }
  }
  if (!script.includes('reports/card_quality_audit_report.json') && !script.includes('card_quality_audit_report.json')) {
    pushIssue(errors, 'card_quality_audit_script_report_path_missing', {});
  }
  if (!script.includes('--write-scope-report') || !script.includes('scoped_card_quality_audit')) {
    pushIssue(errors, 'card_quality_audit_script_scoped_report_missing', {});
  }
  if (!script.includes('--self-test') || !script.includes('visible_option_list_only_is_not_leak') || !script.includes('visible_task_schema_guide_is_audited') || !script.includes('visible_option_example_guide_leak_is_audited') || !script.includes('semantic_answer_gloss_guide_leak_is_audited') || !script.includes('strong_evidence_gloss_guide_leak_is_audited') || !script.includes('practical_gloss_guide_leak_is_audited') || !script.includes('research_account_gloss_guide_leak_is_audited') || !script.includes('preposition_semantic_role_gloss_guide_leak_is_audited') || !script.includes('short_preposition_answer_text_is_audited') || !script.includes('analysis_conclusion_guide_leak_is_audited') || !script.includes('quoted_clue_key_guide_leak_is_audited') || !script.includes('correct_option_hindsight_guide_leak_is_audited') || !script.includes('answer_candidate_side_guide_leak_is_audited') || !script.includes('which_option_hits_guide_leak_is_audited') || !script.includes('generic_choose_correct_answer_instruction_is_not_leak') || !script.includes('long_correct_option_phrase_guide_leak_is_audited') || !script.includes('long_correct_option_summary_token_guide_leak_is_audited') || !script.includes('long_correct_option_driver_token_guide_leak_is_audited') || !script.includes('long_correct_option_causal_guide_leak_is_audited') || !script.includes('structural_causal_guide_without_answer_content_is_not_leak') || !script.includes('result_side_hindsight_guide_leak_is_audited') || !script.includes('long_option_shared_topic_context_is_not_leak')) {
    pushIssue(errors, 'card_quality_audit_self_test_missing', {});
  } else {
    try {
      const output = execFileSync(process.execPath, ['scripts/audit_card_quality.mjs', '--self-test'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const selfTest = JSON.parse(output);
      if (selfTest.ok !== true) {
        pushIssue(errors, 'card_quality_audit_self_test_failed', { output: selfTest });
      }
    } catch (error) {
      pushIssue(errors, 'card_quality_audit_self_test_failed', {
        message: error.message,
        output: String(error.stdout || error.stderr || '').slice(0, 1000),
      });
    }
  }

  const report = buildEphemeralCardQualityAudit(errors);
  if (!report) return;
  if (report.audit_version !== audit.version) {
    pushIssue(errors, 'card_quality_audit_report_version_drift', {
      expected: audit.version,
      actual: report.audit_version,
    });
  }
  if (report.mode !== audit.mode) {
    pushIssue(errors, 'card_quality_audit_report_mode_drift', {
      expected: audit.mode,
      actual: report.mode,
    });
  }
  if (!(report.summary?.total_cards > 0)) {
    pushIssue(errors, 'card_quality_audit_report_empty_scope', {});
  }
  const expectedFingerprint = currentCardCorpusFingerprint();
  const actualFingerprint = report.corpus_fingerprint || {};
  const allowStaleGlobalReport = allowsStaleGlobalAuditReportForScopedCandidate();
  for (const field of ['algorithm', 'card_dir', 'file_count', 'card_count', 'digest']) {
    if (actualFingerprint[field] !== expectedFingerprint[field]) {
      const details = {
        field,
        expected: expectedFingerprint[field],
        actual: actualFingerprint[field],
      };
      if (allowStaleGlobalReport) {
        pushIssue(warnings, 'card_quality_audit_global_report_stale_allowed_by_scoped_evidence', {
          ...details,
          scoped_reports: currentScopedAuditReportFiles(),
        });
      } else {
        pushIssue(errors, 'card_quality_audit_report_stale_or_mismatched', details);
      }
    }
  }
  if (!Array.isArray(report.hard_blocker_issues)) {
    pushIssue(errors, 'card_quality_audit_hard_blocker_index_missing', {});
  }
  if (!report.card_issue_index || typeof report.card_issue_index !== 'object') {
    pushIssue(errors, 'card_quality_audit_card_issue_index_missing', {});
  } else if (Object.keys(report.card_issue_index).length !== report.summary?.total_cards) {
    pushIssue(errors, 'card_quality_audit_card_issue_index_count_mismatch', {
      expected: report.summary?.total_cards,
      actual: Object.keys(report.card_issue_index).length,
    });
  }
  for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
    if (!report.summary?.by_rule?.[ruleId]) {
      pushIssue(errors, 'card_quality_audit_report_rule_missing', { ruleId });
    }
  }
  validateTrackedScopedAuditReports(report, errors);
}

function validateScopedAuditReportStructure(scopedReport, errors, source) {
  if (!scopedReport || typeof scopedReport !== 'object' || Array.isArray(scopedReport)) {
    pushIssue(errors, 'scoped_audit_report_not_object', {source});
    return false;
  }
  if (scopedReport.report_type !== 'scoped_card_quality_audit') {
    pushIssue(errors, 'scoped_audit_report_type_invalid', {
      source,
      actual: scopedReport.report_type,
    });
  }
  const auditPolicy = readJson('spec/card-quality-audit.json');
  if (scopedReport.audit_version !== auditPolicy.version) {
    pushIssue(errors, 'scoped_audit_report_version_invalid', {
      source,
      expected: auditPolicy.version,
      actual: scopedReport.audit_version,
    });
  }
  if (scopedReport.mode !== auditPolicy.mode) {
    pushIssue(errors, 'scoped_audit_report_mode_invalid', {
      source,
      expected: auditPolicy.mode,
      actual: scopedReport.mode,
    });
  }
  if (typeof scopedReport.ok !== 'boolean') {
    pushIssue(errors, 'scoped_audit_report_ok_not_boolean', {source});
  }
  const fingerprint = scopedReport.corpus_fingerprint;
  if (
    fingerprint?.algorithm !== 'sha256' ||
    fingerprint?.card_dir !== 'card_boxes_json' ||
    !Number.isInteger(fingerprint?.file_count) ||
    fingerprint.file_count < 0 ||
    !Number.isInteger(fingerprint?.card_count) ||
    fingerprint.card_count < 0 ||
    !/^[0-9a-f]{64}$/.test(String(fingerprint?.digest || ''))
  ) {
    pushIssue(errors, 'scoped_audit_report_fingerprint_invalid', {
      source,
      actual: fingerprint,
    });
  }

  const scopeCardIds = Array.isArray(scopedReport.scope?.card_ids)
    ? scopedReport.scope.card_ids
    : [];
  if (
    scopeCardIds.length === 0 ||
    !scopeCardIds.every(hasText) ||
    new Set(scopeCardIds).size !== scopeCardIds.length
  ) {
    pushIssue(errors, 'scoped_audit_report_scope_card_ids_invalid', {
      source,
      card_ids: scopeCardIds,
    });
    return false;
  }
  if (!isDeepStrictEqual(scopeCardIds, [...scopeCardIds].sort())) {
    pushIssue(errors, 'scoped_audit_report_scope_card_ids_unsorted', {source});
  }
  if (scopedReport.scope?.card_dir !== 'card_boxes_json') {
    pushIssue(errors, 'scoped_audit_report_card_dir_invalid', {
      source,
      actual: scopedReport.scope?.card_dir,
    });
  }
  const missingCardIds = scopedReport.scope?.missing_card_ids;
  if (
    !Array.isArray(missingCardIds) ||
    !missingCardIds.every(hasText) ||
    new Set(missingCardIds).size !== missingCardIds.length ||
    !missingCardIds.every(cardId => scopeCardIds.includes(cardId))
  ) {
    pushIssue(errors, 'scoped_audit_report_missing_card_ids_invalid', {
      source,
      missing_card_ids: missingCardIds,
    });
  }

  const summary = scopedReport.scope_summary;
  if (
    !summary ||
    typeof summary !== 'object' ||
    Array.isArray(summary) ||
    !setsEqual(summary.card_ids, scopeCardIds) ||
    summary.card_count !== scopeCardIds.length ||
    !Number.isInteger(summary.issue_count) ||
    summary.issue_count < 0
  ) {
    pushIssue(errors, 'scoped_audit_report_summary_invalid', {source});
  }
  let severityTotal = 0;
  for (const severity of QUALITY_AUDIT_SEVERITIES) {
    const count = summary?.by_severity?.[severity];
    if (!Number.isInteger(count) || count < 0) {
      pushIssue(errors, 'scoped_audit_report_summary_severity_invalid', {
        source,
        severity,
        actual: count,
      });
    } else {
      severityTotal += count;
    }
  }
  if (Number.isInteger(summary?.issue_count) && severityTotal !== summary.issue_count) {
    pushIssue(errors, 'scoped_audit_report_summary_severity_total_mismatch', {
      source,
      expected: severityTotal,
      actual: summary.issue_count,
    });
  }
  if (
    !summary?.by_rule ||
    typeof summary.by_rule !== 'object' ||
    Array.isArray(summary.by_rule) ||
    !Object.values(summary.by_rule).every(count => Number.isInteger(count) && count >= 0)
  ) {
    pushIssue(errors, 'scoped_audit_report_summary_rules_invalid', {source});
  }

  const issueIndex = scopedReport.scoped_card_issue_index;
  const expectedIndexIds = scopeCardIds.filter(cardId => !missingCardIds?.includes(cardId));
  if (
    !issueIndex ||
    typeof issueIndex !== 'object' ||
    Array.isArray(issueIndex) ||
    !setsEqual(Object.keys(issueIndex), expectedIndexIds)
  ) {
    pushIssue(errors, 'scoped_audit_report_issue_index_invalid', {
      source,
      expected_card_ids: expectedIndexIds,
      actual_card_ids: Object.keys(issueIndex || {}),
    });
  }
  const recomputedIssueCount = Object.values(issueIndex || {})
    .reduce((total, entry) => total + numericCount(entry?.issue_count), 0);
  if (Number.isInteger(summary?.issue_count) && recomputedIssueCount !== summary.issue_count) {
    pushIssue(errors, 'scoped_audit_report_issue_index_count_mismatch', {
      source,
      expected: recomputedIssueCount,
      actual: summary.issue_count,
    });
  }
  for (const [cardId, entry] of Object.entries(issueIndex || {})) {
    if (entry?.card_id !== cardId) {
      pushIssue(errors, 'scoped_audit_report_issue_index_card_id_mismatch', {
        source,
        card_id: cardId,
        actual: entry?.card_id,
      });
    }
  }

  const hardBlockers = scopedReport.scoped_hard_blocker_issues;
  if (
    !Array.isArray(hardBlockers) ||
    !hardBlockers.every(issue =>
      issue?.severity === 'hard_blocker' && scopeCardIds.includes(issue?.card_id)
    )
  ) {
    pushIssue(errors, 'scoped_audit_report_hard_blockers_invalid', {source});
  }
  if (
    Number.isInteger(summary?.by_severity?.hard_blocker) &&
    Array.isArray(hardBlockers) &&
    summary.by_severity.hard_blocker !== hardBlockers.length
  ) {
    pushIssue(errors, 'scoped_audit_report_hard_blocker_count_mismatch', {
      source,
      expected: hardBlockers.length,
      actual: summary.by_severity.hard_blocker,
    });
  }
  const expectedOk =
    Array.isArray(missingCardIds) &&
    missingCardIds.length === 0 &&
    Array.isArray(hardBlockers) &&
    hardBlockers.length === 0;
  if (scopedReport.ok !== expectedOk) {
    pushIssue(errors, 'scoped_audit_report_ok_semantics_mismatch', {
      source,
      expected: expectedOk,
      actual: scopedReport.ok,
    });
  }
  return true;
}

function validateCurrentScopedAuditReport(scopedReport, currentReport, errors, source) {
  if (!isDeepStrictEqual(scopedReport.corpus_fingerprint, currentReport.corpus_fingerprint)) {
    pushIssue(errors, 'scoped_audit_report_fingerprint_mismatch', {
      source,
      expected: currentReport.corpus_fingerprint,
      actual: scopedReport.corpus_fingerprint,
    });
  }
  const scopeCardIds = scopedReport.scope.card_ids;
  const {summary: expectedSummary, missingCardIds} =
    buildScopedAuditSummary(currentReport, scopeCardIds);
  if (!isDeepStrictEqual(scopedReport.scope?.missing_card_ids, missingCardIds)) {
    pushIssue(errors, 'scoped_audit_report_missing_card_ids_mismatch', {
      source,
      expected: missingCardIds,
      actual: scopedReport.scope?.missing_card_ids,
    });
  }
  if (!isDeepStrictEqual(scopedReport.scope_summary, expectedSummary)) {
    pushIssue(errors, 'scoped_audit_report_summary_mismatch', {
      source,
      expected: expectedSummary,
      actual: scopedReport.scope_summary,
    });
  }

  const expectedIssueIndex = {};
  for (const cardId of scopeCardIds) {
    if (currentReport.card_issue_index?.[cardId]) {
      expectedIssueIndex[cardId] = currentReport.card_issue_index[cardId];
    }
  }
  if (!isDeepStrictEqual(scopedReport.scoped_card_issue_index, expectedIssueIndex)) {
    pushIssue(errors, 'scoped_audit_report_issue_index_mismatch', {source});
  }
  const scopedIds = new Set(scopeCardIds);
  const expectedHardBlockers = (currentReport.hard_blocker_issues || [])
    .filter(issue => scopedIds.has(issue.card_id));
  if (!isDeepStrictEqual(scopedReport.scoped_hard_blocker_issues, expectedHardBlockers)) {
    pushIssue(errors, 'scoped_audit_report_hard_blockers_mismatch', {source});
  }
}

function validateTrackedScopedAuditReports(currentReport, errors) {
  const auditPolicy = readJson('spec/card-quality-audit.json');
  const legacyReports = new Map(
    (auditPolicy.legacy_scoped_report_archive?.reports || [])
      .map(entry => [entry.path, entry]),
  );
  for (const [legacyPath, legacyEntry] of legacyReports) {
    if (
      !isScopedQualityAuditReport(legacyPath) ||
      !/^[0-9a-f]{64}$/.test(String(legacyEntry.sha256 || '')) ||
      !exists(legacyPath)
    ) {
      pushIssue(errors, 'legacy_scoped_audit_archive_entry_invalid', {
        source: legacyPath,
      });
    }
    const cutoverArtifact = preCutoverRecord(legacyPath);
    if (
      !cutoverArtifact ||
      bytesSha256(cutoverArtifact.bytes) !== legacyEntry.sha256
    ) {
      pushIssue(errors, 'legacy_scoped_audit_archive_not_proven_at_cutover', {
        source: legacyPath,
        introduction_commit: preCutoverIntroduction().commit,
      });
    }
  }
  for (const file of listReviewRecordFiles('reviews/audit_scopes')) {
    if (!isCanonicalReviewRecordPath(file, 'reviews/audit_scopes')) {
      pushIssue(errors, 'scoped_audit_report_path_noncanonical', {source: file});
      continue;
    }
    if (hasUnsafeReviewPathCharacters(file)) {
      pushIssue(errors, 'scoped_audit_report_path_characters_invalid', {source: file});
      continue;
    }
    const fullPath = resolveWorkspacePath(file);
    if (!fs.lstatSync(fullPath).isFile()) {
      pushIssue(errors, 'scoped_audit_report_not_regular_file', {source: file});
      continue;
    }
    const legacyEntry = legacyReports.get(file);
    if (legacyEntry) {
      const actualSha256 = bytesSha256(fs.readFileSync(fullPath));
      if (actualSha256 !== legacyEntry.sha256) {
        pushIssue(errors, 'legacy_scoped_audit_archive_hash_mismatch', {
          source: file,
          expected: legacyEntry.sha256,
          actual: actualSha256,
        });
      }
      continue;
    }
    let scopedReport;
    try {
      scopedReport = readJson(file);
    } catch (error) {
      pushIssue(errors, 'scoped_audit_report_unreadable', {
        source: file,
        message: error.message,
      });
      continue;
    }
    if (!validateScopedAuditReportStructure(scopedReport, errors, file)) continue;
    if (
      scopedReport.corpus_fingerprint?.digest ===
      currentReport.corpus_fingerprint?.digest
    ) {
      validateCurrentScopedAuditReport(scopedReport, currentReport, errors, file);
    }
  }
}

function validateMetadataSchema(errors) {
  const schema = readJson('spec/card-metadata.schema.json');
  const quality = readJson('spec/content-quality-contract.json');
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

  const metadataProperties = schema.properties?.quality_metadata?.properties || {};
  const exactEnum = (actual, expected) => {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    const sortedActual = [...actual].sort();
    const sortedExpected = [...expected].sort();
    return sortedActual.every((value, index) => value === sortedExpected[index]);
  };
  const enumBindings = [
    {
      name: 'weak_point_tags',
      actual: metadataProperties.weak_point_tags?.items?.enum,
      expected: quality.default_user_model?.weak_point_tags,
    },
    {
      name: 'difficulty.primary',
      actual: metadataProperties.difficulty?.properties?.primary?.enum,
      expected: quality.difficulty_policy?.tiers,
    },
    {
      name: 'difficulty.secondary',
      actual: metadataProperties.difficulty?.properties?.secondary?.items?.enum,
      expected: quality.difficulty_policy?.tiers,
    },
    {
      name: 'card_prototype',
      actual: metadataProperties.card_prototype?.enum,
      expected: quality.allowed_card_prototypes,
    },
    {
      name: 'material.text_source_type',
      actual: metadataProperties.material?.properties?.text_source_type?.enum,
      expected: quality.source_policy?.allowed_text_source_types,
    },
  ];
  for (const binding of enumBindings) {
    if (!exactEnum(binding.actual, binding.expected)) {
      pushIssue(errors, 'metadata_schema_content_quality_enum_drift', {
        field: binding.name,
        schema_values: binding.actual || [],
        quality_values: binding.expected || [],
      });
    }
  }
}

function validateWorkflow(errors) {
  const workflow = readJson('spec/review-workflow.json');
  if (workflow.sample_policy?.default_size !== '3 cards per box') {
    pushIssue(errors, 'sample_size_policy_drift', {});
  }
  if (workflow.sample_policy?.batch_generation_requires !== 'validated_user_sample_confirmation_record') {
    pushIssue(errors, 'batch_requires_user_confirmation_missing', {});
  }
  if (workflow.approval_record_policy?.required_for_formal_use !== true) {
    pushIssue(errors, 'approval_record_not_required', {});
  }
  for (const field of REQUIRED_APPROVAL_FIELDS) {
    if (!(workflow.approval_record_policy?.required_fields || []).includes(field)) {
      pushIssue(errors, 'approval_record_policy_required_field_missing', { field });
    }
  }
  for (const field of REQUIRED_SAMPLE_GATE_FIELDS) {
    if (!(workflow.sample_quality_gate?.required_before_user_confirmation || []).includes(field)) {
      pushIssue(errors, 'sample_quality_gate_field_missing', { field });
    }
  }
  for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
    if (!(workflow.self_review_required_checks || []).includes(field)) {
      pushIssue(errors, 'self_review_analysis_reference_check_missing', {field});
    }
  }
  for (const field of ['explicit_user_confirmation', 'linked_agent_self_review_record', 'harness_validation', 'card_validation', 'card_quality_audit_report']) {
    if (!(workflow.sample_quality_gate?.approval_requires || []).includes(field)) {
      pushIssue(errors, 'sample_quality_gate_approval_requirement_missing', { field });
    }
  }
  if (workflow.sample_quality_gate?.quality_metadata_schema !== 'spec/card-metadata.schema.json') {
    pushIssue(errors, 'sample_quality_gate_schema_drift', {});
  }
  const candidateIntegrity = workflow.changed_candidate_integrity_policy || {};
  if (candidateIntegrity.contract !== 'spec/content-quality-contract.json#candidate_integrity_policy') {
    pushIssue(errors, 'changed_candidate_integrity_contract_drift', {});
  }
  if (candidateIntegrity.validator !== 'scripts/validate_pr_scope.mjs') {
    pushIssue(errors, 'changed_candidate_integrity_validator_drift', {});
  }
  if (candidateIntegrity.strict_on_any_card_change !== true) {
    pushIssue(errors, 'changed_candidate_integrity_not_strict', {});
  }
  for (const requiredText of [
    'complete schema-valid quality_metadata',
    'exactly one changed review coverage',
    'even when the card itself did not change',
    'coverage.reviewed_card_ids are identical',
    'complete declared track',
    'same non-empty card ID set at merge-base',
    'regardless of filename prefix',
    'exact repository-declared template paths',
    'approved_batches',
    'canonical governed filename',
    'complete immutable HEAD card_boxes_json snapshot',
    'elimination runtime ID items',
  ]) {
    if (!(candidateIntegrity.requirements || []).some(requirement => requirement.includes(requiredText))) {
      pushIssue(errors, 'changed_candidate_integrity_requirement_missing', { requiredText });
    }
  }
  for (const forbiddenText of [
    'grandfather inherited integrity defects',
    'derive changed card scope only',
    'missing optional metadata fields',
    'exclude any parity field other than artifact-local review_status',
    'self-review-only churn',
    'unprefixed governed review filename',
    'merely because its basename ends in TEMPLATE.json',
    'invalid or mismatched full-track scope and coverage',
    'partial-track aggregate',
    'claim a track that differs',
    'absent from merge-base',
    'attach a cards snapshot payload to a full-track aggregate',
    'base worktree that retains card files deleted or renamed by HEAD',
    'without an explicit immutable head commit',
  ]) {
    if (!(candidateIntegrity.must_not || []).some(rule => rule.includes(forbiddenText))) {
      pushIssue(errors, 'changed_candidate_integrity_forbidden_bypass_missing', { forbiddenText });
    }
  }
  if (workflow.residual_blocker_closure_review_policy?.review_scope_type !== 'residual_blocker_closure') {
    pushIssue(errors, 'residual_blocker_closure_policy_missing', {});
  }
  if (workflow.residual_blocker_closure_review_policy?.not_sample_approval !== true) {
    pushIssue(errors, 'residual_blocker_closure_must_not_be_sample_approval', {});
  }
  if (!(workflow.self_review_output?.batch_status || []).includes(RESIDUAL_BLOCKER_CLOSURE_STATUS)) {
    pushIssue(errors, 'residual_blocker_closure_status_missing', {});
  }
  const expansionPolicy = workflow.confirmed_box_expansion_review_policy;
  if (expansionPolicy?.review_scope_type !== 'confirmed_box_expansion') {
    pushIssue(errors, 'confirmed_box_expansion_policy_missing', {});
  }
  if (!(workflow.self_review_output?.batch_status || []).includes(CONFIRMED_BOX_EXPANSION_STATUS)) {
    pushIssue(errors, 'confirmed_box_expansion_status_missing', {});
  }
  if (!String(expansionPolicy?.approval_boundary || '').includes('separate explicit user approval')) {
    pushIssue(errors, 'confirmed_box_expansion_approval_boundary_missing', {});
  }
  const fullTrackPolicy = workflow.full_track_remediation_policy;
  if (fullTrackPolicy?.review_scope_type !== 'full_track_remediation') {
    pushIssue(errors, 'full_track_remediation_policy_missing', {});
  }
  if (!(workflow.self_review_output?.batch_status || []).includes(FULL_TRACK_READY_STATUS)) {
    pushIssue(errors, 'full_track_ready_status_missing', {});
  }
  if (fullTrackPolicy?.approval_model !== 'execution_team_remediates_and_reviews_the_full_track; user_performs_one_final_complete_batch_approval') {
    pushIssue(errors, 'full_track_approval_model_drift', {});
  }
  if (workflow.approval_record_policy?.full_track_final_mode?.approval_mode !== 'full_track_final') {
    pushIssue(errors, 'full_track_final_approval_mode_missing', {});
  }
  if (!exists('scripts/build_full_track_remediation_baseline.mjs')) {
    pushIssue(errors, 'full_track_remediation_baseline_tool_missing', {});
  } else {
    const baselineTool = readText('scripts/build_full_track_remediation_baseline.mjs');
    for (const token of [
      'full-track-remediation-baseline.v1',
      'candidate remediation planning only',
      'human_CET_review_not_recorded',
      'final_user_approval_not_recorded',
    ]) {
      if (!baselineTool.includes(token)) {
        pushIssue(errors, 'full_track_remediation_baseline_guard_missing', { token });
      }
    }
  }
  for (const forbidden of [
    'declare_final_formal_usability',
    'batch_generate_before_user_confirms_sample',
    'delete_cards_without_user_confirmation',
    'auto_merge_formal_content_without_user_confirmed_sample_and_scope_delegation',
    'auto_merge_without_standing_or_explicit_user_authorization',
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
    'auto_merge_validated_harness_or_tooling_PRs_under_standing_user_delegation',
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
  if (workflow.git_policy?.PR_merge !== 'auto_merge_validated_harness_or_tooling_PRs_under_standing_user_delegation') {
    pushIssue(errors, 'git_PR_merge_policy_drift', {});
  }
}

function validateReviewDirs(errors) {
  const expectedTemplateAuthorities = new Map([
    ['reviews/agent_self_review/FULL_TRACK_TEMPLATE.json', 'full_track_review_template'],
    ['reviews/agent_self_review/TEMPLATE.json', 'review_template'],
    ['reviews/approved_batches/FULL_TRACK_TEMPLATE.json', 'full_track_approval_template'],
    ['reviews/approved_batches/TEMPLATE.json', 'approval_template'],
    ['reviews/sample_confirmations/TEMPLATE.json', 'sample_confirmation_template'],
  ]);
  const expectedTemplatePaths = [...expectedTemplateAuthorities.keys()];
  if (
    REVIEW_RECORD_TEMPLATE_PATHS.size !== expectedTemplatePaths.length ||
    expectedTemplatePaths.some(filePath => !REVIEW_RECORD_TEMPLATE_PATHS.has(filePath))
  ) {
    pushIssue(errors, 'review_record_template_allowlist_drift', {
      actual: [...REVIEW_RECORD_TEMPLATE_PATHS].sort(),
      expected: expectedTemplatePaths.sort(),
    });
  }
  const manifestEntries = new Map(
    (readJson('spec/doc-manifest.json').active_docs || [])
      .map(entry => [entry.path, entry]),
  );
  for (const [templatePath, expectedAuthority] of expectedTemplateAuthorities) {
    if (manifestEntries.get(templatePath)?.authority !== expectedAuthority) {
      pushIssue(errors, 'review_template_manifest_authority_mismatch', {
        source: templatePath,
        expected: expectedAuthority,
        actual: manifestEntries.get(templatePath)?.authority,
      });
    }
  }
  for (const dir of [
    'reviews/agent_self_review',
    'reviews/approved_batches',
    'reviews/sample_confirmations',
    'reviews/audit_scopes',
    'reviews/audio_qc',
    'reviews/drafts',
    'reviews/git_handoffs',
  ]) {
    const full = resolveWorkspacePath(dir);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      pushIssue(errors, 'review_dir_missing', { dir });
    }
  }
}

function listReviewRecordFiles(dir, root = ROOT) {
  const records = [];
  const walk = currentDir => {
    const full = path.resolve(root, currentDir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, {withFileTypes: true})) {
      const recordPath = `${currentDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(recordPath);
      } else if (
        entry.name.endsWith('.json') &&
        !REVIEW_RECORD_TEMPLATE_PATHS.has(recordPath)
      ) {
        records.push(recordPath);
      }
    }
  };
  walk(dir);
  return records.sort();
}

function isCanonicalReviewRecordPath(file, dir) {
  return path.posix.dirname(file) === dir;
}

function hasUnsafeReviewPathCharacters(file) {
  return file.includes('\\') || /[\u0001-\u001f\u007f\u2028\u2029]/.test(file);
}

function isCanonicalAgentSelfReviewRecordPath(file) {
  return (
    hasText(file) &&
    file.endsWith('.json') &&
    !REVIEW_RECORD_TEMPLATE_PATHS.has(file) &&
    isCanonicalReviewRecordPath(file, 'reviews/agent_self_review') &&
    !hasUnsafeReviewPathCharacters(file)
  );
}

function isTrackedWorkspacePath(file) {
  try {
    const trackedPath = execFileSync(
      'git',
      ['ls-files', '--error-unmatch', '--', file],
      {cwd: ROOT, encoding: 'utf8'},
    ).trim();
    return trackedPath === file;
  } catch {
    return false;
  }
}

function validateReviewRecordDiscovery(errors) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-review-discovery-'));
  const nestedDir = path.join(tempRoot, 'reviews/agent_self_review/nested');
  const nestedRecord = 'reviews/agent_self_review/nested/review.json';
  try {
    fs.mkdirSync(nestedDir, {recursive: true});
    fs.writeFileSync(path.join(tempRoot, nestedRecord), '{}\n');
    const discovered = listReviewRecordFiles('reviews/agent_self_review', tempRoot);
    if (!discovered.includes(nestedRecord)) {
      pushIssue(errors, 'agent_self_review_recursive_discovery_missing', {});
    }
    if (
      isCanonicalReviewRecordPath(nestedRecord, 'reviews/agent_self_review') ||
      !isCanonicalReviewRecordPath(
        'reviews/agent_self_review/review.json',
        'reviews/agent_self_review',
      )
    ) {
      pushIssue(errors, 'agent_self_review_canonical_path_classifier_invalid', {});
    }
    if (
      !hasUnsafeReviewPathCharacters('reviews/agent_self_review/line\u2028break.json') ||
      hasUnsafeReviewPathCharacters('reviews/agent_self_review/review.json')
    ) {
      pushIssue(errors, 'agent_self_review_path_character_classifier_invalid', {});
    }
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
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

function validateQualityAuditRecord(auditRecord, errors, source, {
  template,
  fixture = false,
  scopeCardIds = [],
  requiredForApproval = false,
  allowHistoricalScopedReport = false,
  currentFingerprint = currentCardCorpusFingerprint(),
}) {
  if (!auditRecord || typeof auditRecord !== 'object') {
    pushIssue(errors, 'quality_audit_record_missing', { source });
    return;
  }
  for (const field of REQUIRED_QUALITY_AUDIT_RECORD_FIELDS) {
    if (!hasOwn(auditRecord, field)) {
      pushIssue(errors, 'quality_audit_record_field_missing', { source, field });
    }
  }
  const scopeSummary = auditRecord.scope_summary;
  if (!scopeSummary || typeof scopeSummary !== 'object') {
    pushIssue(errors, 'quality_audit_scope_summary_missing', { source });
  } else {
    for (const field of REQUIRED_QUALITY_AUDIT_SCOPE_SUMMARY_FIELDS) {
      if (!hasOwn(scopeSummary, field)) {
        pushIssue(errors, 'quality_audit_scope_summary_field_missing', { source, field });
      }
    }
    for (const severity of QUALITY_AUDIT_SEVERITIES) {
      if (!hasOwn(scopeSummary.by_severity, severity)) {
        pushIssue(errors, 'quality_audit_scope_summary_severity_missing', {
          source,
          severity,
        });
      }
    }
    if (template || fixture) {
      for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
        if (!hasOwn(scopeSummary.by_rule, ruleId)) {
          pushIssue(errors, 'quality_audit_scope_summary_rule_missing', {
            source,
            ruleId,
          });
        }
      }
    }
  }
  const usesGlobalReport = isGlobalQualityAuditReport(auditRecord.report);
  const usesScopedReport = isScopedQualityAuditReport(auditRecord.report);
  if (!usesGlobalReport && !usesScopedReport) {
    pushIssue(errors, 'quality_audit_record_report_path_drift', {
      source,
      report: auditRecord.report,
    });
  }
  if (typeof auditRecord.scope_has_no_hard_blockers !== 'boolean') {
    pushIssue(errors, 'quality_audit_record_scope_flag_not_boolean', { source });
  }
  if (requiredForApproval && auditRecord.scope_has_no_hard_blockers !== true) {
    pushIssue(errors, 'quality_audit_scope_not_cleared_for_approval', { source });
  }
  if (template) return;

  if (!hasText(auditRecord.corpus_fingerprint)) {
    pushIssue(errors, 'quality_audit_record_fingerprint_empty', { source });
  }
  if (fixture) return;
  if (!exists(auditRecord.report)) {
    if (usesGlobalReport && validateArchivedGlobalAuditReference(auditRecord, errors, source)) return;
    pushIssue(errors, 'quality_audit_record_report_missing_on_disk', {
      source,
      report: auditRecord.report,
    });
    return;
  }

  const report = readJson(auditRecord.report);
  const reportDigest = report.corpus_fingerprint?.digest;
  const allowStaleGlobalReport = usesGlobalReport && allowsStaleGlobalAuditReportForScopedCandidate();
  const expectedRecordFingerprint = usesScopedReport || allowStaleGlobalReport
    ? reportDigest
    : currentFingerprint.digest;
  if (auditRecord.corpus_fingerprint !== expectedRecordFingerprint) {
    pushIssue(errors, 'quality_audit_record_fingerprint_mismatch', {
      source,
      expected: expectedRecordFingerprint,
      actual: auditRecord.corpus_fingerprint,
    });
  }
  if (usesScopedReport && report.report_type !== 'scoped_card_quality_audit') {
    pushIssue(errors, 'quality_audit_scoped_report_type_invalid', {
      source,
      report: auditRecord.report,
      report_type: report.report_type,
    });
  }
  if (
    reportDigest !== currentFingerprint.digest &&
    !usesScopedReport &&
    !allowStaleGlobalReport
  ) {
    pushIssue(errors, 'quality_audit_record_links_stale_report', {
      source,
      expected: currentFingerprint.digest,
      actual: reportDigest,
    });
  }
  if (
    usesScopedReport &&
    reportDigest !== currentFingerprint.digest &&
    !allowHistoricalScopedReport
  ) {
    pushIssue(errors, 'quality_audit_record_links_stale_scoped_report', {
      source,
      expected: currentFingerprint.digest,
      actual: reportDigest,
    });
  }

  const scopedIds = stringSet(scopeCardIds);
  const scopedHardBlockers = usesScopedReport
    ? (report.scoped_hard_blocker_issues || []).filter(issue => scopedIds.has(issue.card_id))
    : (report.hard_blocker_issues || []).filter(issue => scopedIds.has(issue.card_id));
  if (scopedHardBlockers.length > 0 && (requiredForApproval || auditRecord.scope_has_no_hard_blockers === true)) {
    pushIssue(errors, 'quality_audit_scope_has_hard_blockers', {
      source,
      card_ids: scopedHardBlockers.map(issue => issue.card_id),
    });
  }
  let expectedSummary;
  let missingCardIds;
  if (usesScopedReport) {
    expectedSummary = report.scope_summary;
    missingCardIds = report.scope?.missing_card_ids || [];
    if (!expectedSummary || typeof expectedSummary !== 'object') {
      pushIssue(errors, 'quality_audit_scoped_report_summary_missing', { source, report: auditRecord.report });
      return;
    }
    if (!setsEqual(report.scope?.card_ids || [], scopeCardIds)) {
      pushIssue(errors, 'quality_audit_scoped_report_scope_mismatch', {
        source,
        report: auditRecord.report,
        expected: sortedStrings(scopeCardIds),
        actual: sortedStrings(report.scope?.card_ids || []),
      });
    }
  } else {
    if (!report.card_issue_index || typeof report.card_issue_index !== 'object') {
      pushIssue(errors, 'quality_audit_record_report_card_issue_index_missing', { source });
      return;
    }
    ({ summary: expectedSummary, missingCardIds } = buildScopedAuditSummary(report, scopeCardIds));
  }
  if (missingCardIds.length > 0) {
    pushIssue(errors, 'quality_audit_scope_cards_missing_from_report_index', {
      source,
      card_ids: missingCardIds,
    });
    return;
  }
  if (!scopeSummary || typeof scopeSummary !== 'object') return;
  if (!setsEqual(scopeSummary.card_ids, expectedSummary.card_ids)) {
    pushIssue(errors, 'quality_audit_scope_summary_card_ids_mismatch', {
      source,
      expected: expectedSummary.card_ids,
      actual: scopeSummary.card_ids,
    });
  }
  for (const field of ['card_count', 'issue_count']) {
    if (numericCount(scopeSummary[field]) !== expectedSummary[field]) {
      pushIssue(errors, 'quality_audit_scope_summary_count_mismatch', {
        source,
        field,
        expected: expectedSummary[field],
        actual: scopeSummary[field],
      });
    }
  }
  for (const severity of QUALITY_AUDIT_SEVERITIES) {
    if (numericCount(scopeSummary.by_severity?.[severity]) !== expectedSummary.by_severity[severity]) {
      pushIssue(errors, 'quality_audit_scope_summary_severity_mismatch', {
        source,
        severity,
        expected: expectedSummary.by_severity[severity],
        actual: scopeSummary.by_severity?.[severity],
      });
    }
  }
  const expectedRuleIds = Object.keys(expectedSummary.by_rule || {});
  for (const ruleId of expectedRuleIds) {
    if (!hasOwn(scopeSummary.by_rule, ruleId)) {
      pushIssue(errors, 'quality_audit_scope_summary_rule_missing', {
        source,
        ruleId,
      });
    } else if (numericCount(scopeSummary.by_rule?.[ruleId]) !== expectedSummary.by_rule[ruleId]) {
      pushIssue(errors, 'quality_audit_scope_summary_rule_mismatch', {
        source,
        ruleId,
        expected: expectedSummary.by_rule[ruleId],
        actual: scopeSummary.by_rule?.[ruleId],
      });
    }
  }
  const scopeHasNoHardBlockers = expectedSummary.by_severity.hard_blocker === 0;
  if (auditRecord.scope_has_no_hard_blockers !== scopeHasNoHardBlockers) {
    pushIssue(errors, 'quality_audit_scope_flag_mismatch', {
      source,
      expected: scopeHasNoHardBlockers,
      actual: auditRecord.scope_has_no_hard_blockers,
    });
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
  if (template || hasOwn(card, 'analysis_reference_check')) {
    for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
      if (card.analysis_reference_check?.[field] !== true) {
        pushIssue(errors, 'self_review_analysis_reference_check_invalid', {
          source,
          card_id: card.card_id,
          field,
          actual: card.analysis_reference_check?.[field],
        });
      }
    }
  }

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

function selfReviewScopeType(record) {
  const explicitType = record.sample_policy?.review_scope_type;
  if (hasText(explicitType)) return explicitType;
  if (record.sample_policy?.residual_blocker_closure === true) return 'residual_blocker_closure';
  return 'three_card_sample_per_box';
}

function isDirectSampleConfirmationRecordPath(value) {
  if (!hasText(value) || !value.startsWith('reviews/sample_confirmations/') || !value.endsWith('.json')) {
    return false;
  }
  if (value === 'reviews/sample_confirmations/TEMPLATE.json') return false;
  return !value.slice('reviews/sample_confirmations/'.length).includes('/');
}

function validateSampleConfirmationRecord(record, errors, source, {template = false} = {}) {
  if (record?.schema_version !== 'sample-confirmation.v1') {
    pushIssue(errors, 'sample_confirmation_schema_version_invalid', {source});
  }
  if (!hasText(record?.confirmation_id)) {
    pushIssue(errors, 'sample_confirmation_id_missing', {source});
  }
  if (!hasText(record?.recorded_at) || (!template && (Number.isNaN(Date.parse(record.recorded_at)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(record.recorded_at)))) {
    pushIssue(errors, 'sample_confirmation_timestamp_invalid', {source});
  }
  if (record?.confirmed_by_user !== true) {
    pushIssue(errors, 'sample_confirmation_user_confirmation_missing', {source});
  }
  for (const field of ['conversation_id', 'message', 'context']) {
    if (!hasText(record?.confirmation_source?.[field])) {
      pushIssue(errors, 'sample_confirmation_source_field_missing', {source, field});
    }
  }
  if (!['cet4', 'cet6'].includes(record?.scope?.track)) {
    pushIssue(errors, 'sample_confirmation_track_invalid', {source, track: record?.scope?.track});
  }
  if (!hasText(record?.scope?.purpose)) {
    pushIssue(errors, 'sample_confirmation_purpose_missing', {source});
  }
  if (!Number.isInteger(record?.scope?.target_card_count) || record.scope.target_card_count <= 0) {
    pushIssue(errors, 'sample_confirmation_target_count_invalid', {source});
  }

  const boxTargets = Array.isArray(record?.scope?.box_targets) ? record.scope.box_targets : [];
  const prefixes = boxTargets.map(target => target?.box_prefix);
  if (!hasUniqueNonEmptyTextArray(prefixes)) {
    pushIssue(errors, 'sample_confirmation_box_targets_invalid', {source});
  }
  let sampleCardCount = 0;
  let targetCardCount = 0;
  const allSampleCardIds = [];
  for (const target of boxTargets) {
    const sampleCardIds = Array.isArray(target?.sample_card_ids) ? target.sample_card_ids : [];
    if (!/^\d{4}$/.test(target?.box_prefix || '')) {
      pushIssue(errors, 'sample_confirmation_box_prefix_invalid', {source, box_prefix: target?.box_prefix});
    }
    if (!Number.isInteger(target?.target_card_count) || target.target_card_count < 3) {
      pushIssue(errors, 'sample_confirmation_box_target_count_invalid', {source, box_prefix: target?.box_prefix});
    }
    if (!hasUniqueNonEmptyTextArray(sampleCardIds) || sampleCardIds.length !== 3) {
      pushIssue(errors, 'sample_confirmation_box_sample_count_invalid', {source, box_prefix: target?.box_prefix});
    }
    for (const cardId of sampleCardIds) {
      if (!String(cardId).startsWith(target?.box_prefix || '__invalid__')) {
        pushIssue(errors, 'sample_confirmation_card_prefix_mismatch', {source, box_prefix: target?.box_prefix, card_id: cardId});
      }
      allSampleCardIds.push(cardId);
    }
    sampleCardCount += sampleCardIds.length;
    targetCardCount += Number.isInteger(target?.target_card_count) ? target.target_card_count : 0;
  }
  if (new Set(allSampleCardIds).size !== allSampleCardIds.length) {
    pushIssue(errors, 'sample_confirmation_sample_card_ids_duplicate', {source});
  }
  if (targetCardCount !== record?.scope?.target_card_count) {
    pushIssue(errors, 'sample_confirmation_total_target_mismatch', {source, expected: targetCardCount, actual: record?.scope?.target_card_count});
  }
  if (record?.sample_evidence?.sample_card_count !== sampleCardCount || record?.sample_evidence?.box_count !== boxTargets.length) {
    pushIssue(errors, 'sample_confirmation_evidence_count_mismatch', {source});
  }
  if (!template && !/^sha256:[a-f0-9]{64}$/.test(record?.sample_evidence?.review_pack_sha256 || '')) {
    pushIssue(errors, 'sample_confirmation_review_pack_hash_invalid', {source});
  }
  const branchHeads = Array.isArray(record?.sample_evidence?.branch_heads) ? record.sample_evidence.branch_heads : [];
  if (branchHeads.length !== boxTargets.length || !setsEqual(branchHeads.map(item => item?.box_prefix), prefixes)) {
    pushIssue(errors, 'sample_confirmation_branch_heads_mismatch', {source});
  }
  for (const item of branchHeads) {
    if (!hasText(item?.branch) || (!template && !/^[a-f0-9]{7,40}$/.test(item?.commit_sha || ''))) {
      pushIssue(errors, 'sample_confirmation_branch_head_invalid', {source, box_prefix: item?.box_prefix});
    }
  }
  if (record?.authorizes?.confirmed_box_expansion !== true || record?.authorizes?.same_quality_contract !== true) {
    pushIssue(errors, 'sample_confirmation_expansion_authority_missing', {source});
  }
  const requiredLimits = ['formal_content_approval', 'audio_perceptual_qc', 'pilot_release', 'destructive_card_changes'];
  if (!hasUniqueNonEmptyTextArray(record?.does_not_authorize) || !requiredLimits.every(limit => record.does_not_authorize.includes(limit))) {
    pushIssue(errors, 'sample_confirmation_limits_invalid', {source});
  }
  if (record?.final_user_approval_required !== true || record?.gate_eligible !== false) {
    pushIssue(errors, 'sample_confirmation_formal_boundary_invalid', {source});
  }
}

function confirmedBoxTarget(record, boxPrefix, errors, source, {template = false, fixture = false} = {}) {
  const confirmationPath = record.sample_policy?.sample_confirmation_record;
  if (!isDirectSampleConfirmationRecordPath(confirmationPath)) {
    pushIssue(errors, 'confirmed_expansion_confirmation_path_invalid', {source, confirmationPath});
    return null;
  }
  if (template || fixture) return null;
  const absolutePath = resolveWorkspacePath(confirmationPath);
  if (!fs.existsSync(absolutePath) || !fs.lstatSync(absolutePath).isFile()) {
    pushIssue(errors, 'confirmed_expansion_confirmation_record_missing', {source, confirmationPath});
    return null;
  }
  const confirmation = readJson(confirmationPath);
  const confirmationErrors = [];
  validateSampleConfirmationRecord(confirmation, confirmationErrors, confirmationPath);
  if (confirmationErrors.length > 0) {
    pushIssue(errors, 'confirmed_expansion_confirmation_record_invalid', {source, confirmationPath, issues: confirmationErrors});
    return null;
  }
  if (confirmation.confirmation_id !== record.sample_policy?.sample_confirmation_id) {
    pushIssue(errors, 'confirmed_expansion_confirmation_id_mismatch', {source, confirmationPath});
  }
  return confirmation.scope.box_targets.find(target => target.box_prefix === boxPrefix) || null;
}

function validateStandardSampleBoxDistribution(cards, boxPrefixes, errors, source) {
  const normalizedBoxPrefixes = Array.isArray(boxPrefixes) ? boxPrefixes : [];
  const expectedCards = Math.max(1, normalizedBoxPrefixes.length) * 3;
  if (cards.length !== expectedCards) {
    pushIssue(errors, 'self_review_sample_card_count_not_three_per_box', {
      source,
      expectedCards,
      actualCards: cards.length,
    });
  }
  const cardsPerBox = new Map(normalizedBoxPrefixes.map(boxPrefix => [boxPrefix, 0]));
  for (const card of cards) {
    const boxPrefix = card?.knowledge_ref?.box_prefix;
    if (!cardsPerBox.has(boxPrefix)) {
      pushIssue(errors, 'self_review_card_box_prefix_outside_scope', {
        source,
        card_id: card?.card_id,
        box_prefix: boxPrefix,
      });
      continue;
    }
    cardsPerBox.set(boxPrefix, cardsPerBox.get(boxPrefix) + 1);
  }
  for (const [boxPrefix, count] of cardsPerBox) {
    if (count !== 3) {
      pushIssue(errors, 'self_review_box_sample_count_not_three', {
        source,
        box_prefix: boxPrefix,
        expectedCards: 3,
        actualCards: count,
      });
    }
  }
}

function validateStandardSampleBoxDistributionSelfTest(errors) {
  const validCards = [
    ...Array.from({length: 3}, (_, index) => ({
      card_id: `a${index}`,
      knowledge_ref: {box_prefix: '0000'},
    })),
    ...Array.from({length: 3}, (_, index) => ({
      card_id: `b${index}`,
      knowledge_ref: {box_prefix: '9999'},
    })),
  ];
  const validErrors = [];
  validateStandardSampleBoxDistribution(
    validCards,
    ['0000', '9999'],
    validErrors,
    'standard-box-distribution-valid-self-test',
  );
  if (validErrors.length > 0) {
    pushIssue(errors, 'standard_sample_box_distribution_valid_case_failed', {
      actual: validErrors,
    });
  }

  const imbalancedErrors = [];
  validateStandardSampleBoxDistribution(
    validCards.map(card => ({
      ...card,
      knowledge_ref: {box_prefix: '0000'},
    })),
    ['0000', '9999'],
    imbalancedErrors,
    'standard-box-distribution-imbalanced-self-test',
  );
  const counts = imbalancedErrors.filter(
    issue => issue.code === 'self_review_box_sample_count_not_three',
  );
  if (
    !counts.some(issue => issue.box_prefix === '0000' && issue.actualCards === 6) ||
    !counts.some(issue => issue.box_prefix === '9999' && issue.actualCards === 0)
  ) {
    pushIssue(errors, 'standard_sample_box_distribution_imbalanced_case_not_rejected', {
      actual: imbalancedErrors,
    });
  }
}

function validateCurrentCardSnapshotIdentity(cards, errors, source) {
  const cardsById = currentCardsById();
  for (const snapshot of cards) {
    const matches = cardsById.get(snapshot?.card_id) || [];
    if (matches.length !== 1) {
      pushIssue(
        errors,
        matches.length === 0
          ? 'self_review_card_missing_from_current_corpus'
          : 'self_review_card_ambiguous_in_current_corpus',
        {
          source,
          card_id: snapshot?.card_id,
          corpus_files: matches.map(match => match.file),
        },
      );
      continue;
    }
    const currentCard = matches[0].card;
    if (snapshot.interaction_id !== currentCard.interaction_id) {
      pushIssue(errors, 'self_review_card_interaction_mismatch', {
        source,
        card_id: snapshot.card_id,
        expected: currentCard.interaction_id,
        actual: snapshot.interaction_id,
      });
    }
    if (!isDeepStrictEqual(snapshot.knowledge_ref, currentCard.knowledge_ref)) {
      pushIssue(errors, 'self_review_card_knowledge_ref_mismatch', {
        source,
        card_id: snapshot.card_id,
        expected: currentCard.knowledge_ref,
        actual: snapshot.knowledge_ref,
      });
    }
    const parity = validateChangedCardSelfReviewParity(
      [{card: currentCard, path: matches[0].file}],
      [{card: snapshot, path: source}],
      currentIntegrityPolicy(),
      {required: true},
    );
    for (const parityIssue of parity.issues) {
      const {code, ...details} = parityIssue;
      pushIssue(errors, `self_review_current_corpus_${code}`, {
        source,
        ...details,
      });
    }
  }
}

function validateCurrentCardSnapshotIdentitySelfTest(errors) {
  const currentEntry = [...currentCardsById().values()]
    .flat()
    .find(entry => entry.card?.quality_metadata);
  if (!currentEntry) {
    pushIssue(errors, 'self_review_current_corpus_parity_self_test_card_missing', {});
    return;
  }
  const validSnapshot = structuredClone(currentEntry.card);
  const validErrors = [];
  validateCurrentCardSnapshotIdentity(
    [validSnapshot],
    validErrors,
    'self-review-current-corpus-valid-self-test',
  );
  if (validErrors.length > 0) {
    pushIssue(errors, 'self_review_current_corpus_parity_valid_case_failed', {
      actual: validErrors,
    });
  }

  const driftedSnapshot = structuredClone(validSnapshot);
  driftedSnapshot.quality_metadata.exam_value =
    '这是一条结构有效但故意偏离当前语料卡片的考试价值说明，用于证明独立 harness 会拒绝陈旧或伪造的自审元数据。';
  const driftErrors = [];
  validateCurrentCardSnapshotIdentity(
    [driftedSnapshot],
    driftErrors,
    'self-review-current-corpus-drift-self-test',
  );
  if (!driftErrors.some(
    issue => issue.code === 'self_review_current_corpus_candidate_self_review_metadata_mismatch'
  )) {
    pushIssue(errors, 'self_review_current_corpus_parity_drift_case_not_rejected', {
      actual: driftErrors,
    });
  }
}

function shouldValidateCurrentSelfReviewSnapshots(
  auditRecord,
  currentFingerprint = currentCardCorpusFingerprint(),
) {
  if (!isScopedQualityAuditReport(auditRecord?.report)) return true;
  if (!exists(auditRecord.report)) return true;
  try {
    const report = readJson(auditRecord.report);
    return report.corpus_fingerprint?.digest === currentFingerprint.digest;
  } catch {
    return true;
  }
}

function hasCurrentScopedAuditFingerprint(
  auditRecord,
  currentFingerprint = currentCardCorpusFingerprint(),
) {
  if (!isScopedQualityAuditReport(auditRecord?.report)) return false;
  if (!exists(auditRecord.report)) return false;
  try {
    const report = readJson(auditRecord.report);
    return (
      hasText(auditRecord.corpus_fingerprint) &&
      auditRecord.corpus_fingerprint === report.corpus_fingerprint?.digest &&
      report.corpus_fingerprint?.digest === currentFingerprint.digest
    );
  } catch {
    return false;
  }
}

function hasCurrentApprovalAuditFingerprint(
  record,
  currentFingerprint = currentCardCorpusFingerprint(),
) {
  return hasCurrentScopedAuditFingerprint(
    record?.card_quality_audit,
    currentFingerprint,
  );
}

function validateReviewIdentityUniquenessSelfTest(errors) {
  const standardRecord = structuredClone(
    readJson('reviews/agent_self_review/TEMPLATE.json'),
  );
  standardRecord.scope = {
    library: 'fixture-library',
    group: 'fixture-group',
    box: 'fixture-box',
    box_prefixes: ['0000'],
    card_ids: ['000001', '000002', '000003'],
  };
  standardRecord.specs_read = ['spec/review-workflow.json'];
  const snapshot = structuredClone(standardRecord.cards[0]);
  snapshot.card_id = '000001';
  snapshot.interaction_id = 'flip';
  snapshot.knowledge_ref.box_prefix = '0000';
  standardRecord.cards = [
    structuredClone(snapshot),
    structuredClone(snapshot),
    structuredClone(snapshot),
  ];
  standardRecord.batch_review.box_progression = 'fixture progression';
  standardRecord.batch_review.representative_cards = ['000001'];
  standardRecord.batch_review.next_step = 'fixture next step';
  const standardErrors = [];
  validateSelfReviewRecord(
    standardRecord,
    standardErrors,
    'duplicate-standard-snapshot-self-test',
    {fixture: true},
  );
  if (!standardErrors.some(
    issue => issue.code === 'self_review_snapshot_card_ids_invalid'
  )) {
    pushIssue(errors, 'self_review_snapshot_identity_self_test_failed', {
      actual: standardErrors,
    });
  }

  const fullTrackRecord = structuredClone(
    readJson('reviews/agent_self_review/FULL_TRACK_TEMPLATE.json'),
  );
  fullTrackRecord.scope = {
    track: 'cet4',
    box_prefixes: ['0000'],
    card_ids: ['000001', '000002'],
  };
  fullTrackRecord.specs_read = ['spec/review-workflow.json'];
  fullTrackRecord.coverage = {
    expected_card_count: 2,
    reviewed_card_ids: ['000001', '000001'],
    human_reviewer: 'external:fixture-human',
    analysis_reference_check: {
      answer_matches_card: true,
      choice_or_bank_references_match_source: true,
      distractor_labels_match_explanations: true,
    },
    boxes: [{
      box_prefix: '0000',
      status: 'pass',
      reviewer: 'external:fixture-human',
    }],
  };
  fullTrackRecord.representative_cards = ['000001'];
  fullTrackRecord.batch_review.summary = 'fixture summary';
  const fullTrackErrors = [];
  validateSelfReviewRecord(
    fullTrackRecord,
    fullTrackErrors,
    'duplicate-full-track-coverage-self-test',
    {fixture: true},
  );
  if (!fullTrackErrors.some(
    issue => issue.code === 'full_track_review_coverage_card_ids_invalid'
  )) {
    pushIssue(errors, 'full_track_review_coverage_identity_self_test_failed', {
      actual: fullTrackErrors,
    });
  }
}

function validateSelfReviewRecord(record, errors, source, {
  template = false,
  fixture = false,
  currentFingerprint = currentCardCorpusFingerprint(),
} = {}) {
  const reviewScopeType = selfReviewScopeType(record);
  const isResidualBlockerClosure = reviewScopeType === 'residual_blocker_closure';
  const isConfirmedBoxExpansion = reviewScopeType === 'confirmed_box_expansion';
  const isFullTrackRemediation = reviewScopeType === 'full_track_remediation';
  const isImmutableLegacyRecord =
    !template && !fixture && isImmutablePreCutoverRecord(source, record);

  if (!SELF_REVIEW_SCOPE_TYPES.includes(reviewScopeType)) {
    pushIssue(errors, 'self_review_unknown_scope_type', { source, reviewScopeType });
  }

  if (isFullTrackRemediation) {
    if (record.sample_policy?.is_three_card_sample_per_box !== false) {
      pushIssue(errors, 'full_track_review_must_not_claim_three_card_sample', { source });
    }
    if (record.sample_policy?.full_track_remediation !== true) {
      pushIssue(errors, 'full_track_review_policy_flag_missing', { source });
    }
    if (record.sample_policy?.final_user_approval_required !== true) {
      pushIssue(errors, 'full_track_review_final_user_approval_missing', { source });
    }
    if (!isScopedQualityAuditReport(record.quality_audit?.report)) {
      pushIssue(errors, 'full_track_review_scoped_audit_missing', {
        source,
        report: record.quality_audit?.report,
      });
    }
  } else if (isConfirmedBoxExpansion) {
    for (const [field, expected] of [
      ['is_three_card_sample_per_box', false],
      ['confirmed_box_expansion', true],
      ['sample_confirmation_satisfied', true],
      ['final_user_approval_required', true],
    ]) {
      if (record.sample_policy?.[field] !== expected) {
        pushIssue(errors, 'confirmed_expansion_sample_policy_invalid', {source, field, expected});
      }
    }
    if (!hasText(record.sample_policy?.sample_confirmation_id)) {
      pushIssue(errors, 'confirmed_expansion_confirmation_id_missing', {source});
    }
    if (!isScopedQualityAuditReport(record.quality_audit?.report)) {
      pushIssue(errors, 'confirmed_expansion_scoped_audit_missing', {source, report: record.quality_audit?.report});
    }
  } else if (isResidualBlockerClosure) {
    if (record.sample_policy?.review_scope_type !== 'residual_blocker_closure') {
      pushIssue(errors, 'residual_self_review_scope_type_missing', {source});
    }
    if (record.sample_policy?.is_three_card_sample_per_box !== false) {
      pushIssue(errors, 'residual_self_review_must_not_claim_three_card_sample', { source });
    }
    if (record.sample_policy?.residual_blocker_closure !== true) {
      pushIssue(errors, 'residual_self_review_policy_flag_missing', { source });
    }
    if (record.sample_policy?.not_sample_approval !== true) {
      pushIssue(errors, 'residual_self_review_not_sample_approval_missing', { source });
    }
    if (!isScopedQualityAuditReport(record.quality_audit?.report)) {
      pushIssue(errors, 'residual_self_review_scoped_audit_missing', {
        source,
        report: record.quality_audit?.report,
      });
    }
  } else {
    if (record.sample_policy?.is_three_card_sample_per_box !== true) {
      pushIssue(errors, 'self_review_sample_policy_not_three_card', { source });
    }
    if (
      !isImmutableLegacyRecord &&
      !isScopedQualityAuditReport(record.quality_audit?.report)
    ) {
      pushIssue(errors, 'standard_self_review_scoped_audit_missing', {
        source,
        report: record.quality_audit?.report,
      });
    }
  }
  if (record.sample_policy?.batch_generation_requires_user_confirmation !== true) {
    pushIssue(errors, 'self_review_sample_policy_user_confirmation_missing', { source });
  }

  if (isFullTrackRemediation) {
    const scopeCardIds = Array.isArray(record.scope?.card_ids) ? record.scope.card_ids : [];
    const scopeBoxPrefixes = Array.isArray(record.scope?.box_prefixes)
      ? record.scope.box_prefixes
      : [];
    validateQualityAuditRecord(record.quality_audit, errors, source, {
      template,
      fixture,
      scopeCardIds,
      requiredForApproval: record.batch_review?.status === FULL_TRACK_READY_STATUS,
      allowHistoricalScopedReport: true,
      currentFingerprint,
    });
    if (template) {
      for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
        if (record.coverage?.analysis_reference_check?.[field] !== true) {
          pushIssue(errors, 'full_track_review_analysis_reference_check_invalid', {
            source,
            field,
            actual: record.coverage?.analysis_reference_check?.[field],
          });
        }
      }
    }
    if (template) return;

    if (!['cet4', 'cet6'].includes(record.scope?.track)) {
      pushIssue(errors, 'full_track_review_track_invalid', { source, track: record.scope?.track });
    }
    if (!hasUniqueNonEmptyTextArray(scopeBoxPrefixes)) {
      pushIssue(errors, 'full_track_review_box_prefixes_invalid', {
        source,
        box_prefixes: scopeBoxPrefixes,
      });
    }
    if (!hasUniqueNonEmptyTextArray(scopeCardIds)) {
      pushIssue(errors, 'full_track_review_card_ids_invalid', {
        source,
        card_ids: scopeCardIds,
      });
    }
    if (
      shouldValidateCurrentSelfReviewSnapshots(
        record.quality_audit,
        currentFingerprint,
      )
    ) {
      const currentTrackScope = currentTrackCorpusScope(record.scope?.track);
      if (
        currentTrackScope.cardIds.length === 0 ||
        currentTrackScope.cardsMissingId.length > 0 ||
        currentTrackScope.duplicateCardIds.length > 0 ||
        scopeCardIds.length !== currentTrackScope.cardIds.length ||
        !setsEqual(scopeCardIds, currentTrackScope.cardIds)
      ) {
        pushIssue(errors, 'full_track_review_card_scope_not_complete_track', {
          source,
          track: record.scope?.track,
          expected_card_ids: [...new Set(currentTrackScope.cardIds)].sort(),
          actual_card_ids: sortedStrings(scopeCardIds),
          duplicate_head_card_ids: sortedStrings(currentTrackScope.duplicateCardIds),
          head_cards_missing_id: currentTrackScope.cardsMissingId,
        });
      }
      if (
        currentTrackScope.boxPrefixes.length === 0 ||
        currentTrackScope.cardsMissingBoxPrefix.length > 0 ||
        scopeBoxPrefixes.length !== currentTrackScope.boxPrefixes.length ||
        !setsEqual(scopeBoxPrefixes, currentTrackScope.boxPrefixes)
      ) {
        pushIssue(errors, 'full_track_review_box_scope_not_complete_track', {
          source,
          track: record.scope?.track,
          expected_box_prefixes: currentTrackScope.boxPrefixes,
          actual_box_prefixes: sortedStrings(scopeBoxPrefixes),
          head_cards_missing_box_prefix: currentTrackScope.cardsMissingBoxPrefix,
        });
      }
    }
    if (!Array.isArray(record.specs_read) || record.specs_read.length === 0) {
      pushIssue(errors, 'self_review_specs_read_missing', { source });
    }
    if (record.coverage?.expected_card_count !== scopeCardIds.length) {
      pushIssue(errors, 'full_track_review_expected_count_mismatch', {
        source,
        expected: scopeCardIds.length,
        actual: record.coverage?.expected_card_count,
      });
    }
    if (!hasUniqueNonEmptyTextArray(record.coverage?.reviewed_card_ids)) {
      pushIssue(errors, 'full_track_review_coverage_card_ids_invalid', {
        source,
        reviewed_card_ids: record.coverage?.reviewed_card_ids,
      });
    }
    if (!setsEqual(record.coverage?.reviewed_card_ids, scopeCardIds)) {
      pushIssue(errors, 'full_track_review_coverage_mismatch', { source });
    }
    if (!hasText(record.coverage?.human_reviewer)) {
      pushIssue(errors, 'full_track_review_human_reviewer_missing', { source });
    } else if (!isHumanReviewerIdentity(record.coverage.human_reviewer)) {
      pushIssue(errors, 'full_track_review_human_reviewer_invalid', {
        source,
        human_reviewer: record.coverage.human_reviewer,
      });
    }
    if (template || hasOwn(record.coverage || {}, 'analysis_reference_check')) {
      for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
        if (record.coverage?.analysis_reference_check?.[field] !== true) {
          pushIssue(errors, 'full_track_review_analysis_reference_check_invalid', {
            source,
            field,
            actual: record.coverage?.analysis_reference_check?.[field],
          });
        }
      }
    }
    const boxes = Array.isArray(record.coverage?.boxes) ? record.coverage.boxes : [];
    if (boxes.length !== scopeBoxPrefixes.length) {
      pushIssue(errors, 'full_track_review_box_coverage_mismatch', {
        source,
        expected: scopeBoxPrefixes.length,
        actual: boxes.length,
      });
    }
    const reviewedPrefixes = boxes.map(box => box?.box_prefix);
    if (!hasUniqueNonEmptyTextArray(reviewedPrefixes)) {
      pushIssue(errors, 'full_track_review_coverage_box_prefixes_invalid', {
        source,
        box_prefixes: reviewedPrefixes,
      });
    }
    if (!setsEqual(reviewedPrefixes, scopeBoxPrefixes)) {
      pushIssue(errors, 'full_track_review_box_prefix_mismatch', { source });
    }
    for (const box of boxes) {
      if (box?.status !== 'pass' || !isHumanReviewerIdentity(box?.reviewer)) {
        pushIssue(errors, 'full_track_review_box_not_human_passed', {
          source,
          box_prefix: box?.box_prefix,
        });
      }
      if (box?.reviewer !== record.coverage?.human_reviewer) {
        pushIssue(errors, 'full_track_review_box_reviewer_mismatch', {
          source,
          box_prefix: box?.box_prefix,
          expected: record.coverage?.human_reviewer,
          actual: box?.reviewer,
        });
      }
    }
    if (
      !hasNonEmptyTextArray(record.representative_cards) ||
      new Set(record.representative_cards).size !== record.representative_cards.length ||
      !isSubset(record.representative_cards, scopeCardIds)
    ) {
      pushIssue(errors, 'full_track_review_representative_cards_invalid', {
        source,
        representative_cards: record.representative_cards,
      });
    }
    if (record.batch_review?.status !== FULL_TRACK_READY_STATUS) {
      pushIssue(errors, 'full_track_review_batch_status_invalid', {
        source,
        status: record.batch_review?.status,
      });
    }
    if (!Array.isArray(record.batch_review?.remaining_risks) || record.batch_review.remaining_risks.length > 0) {
      pushIssue(errors, 'full_track_review_has_remaining_risks', { source });
    }
    if (!hasText(record.batch_review?.summary) || !hasText(record.batch_review?.next_step)) {
      pushIssue(errors, 'full_track_review_batch_evidence_incomplete', {source});
    }
    return;
  }

  const cards = record.cards || [];
  if (!Array.isArray(cards) || cards.length === 0) {
    pushIssue(errors, 'self_review_cards_missing', { source });
    return;
  }

  for (const card of cards) validateSelfReviewCard(card, errors, source, { template });
  validateQualityAuditRecord(record.quality_audit, errors, source, {
    template,
    fixture,
    scopeCardIds: record.scope?.card_ids || cards.map(card => card.card_id),
    requiredForApproval: !isResidualBlockerClosure && !isConfirmedBoxExpansion && record.batch_review?.status === 'recommend_user_confirmation',
    allowHistoricalScopedReport: true,
    currentFingerprint,
  });

  if (!template) {
    const boxPrefixes = record.scope?.box_prefixes || [];
    const scopeCardIds = record.scope?.card_ids || [];
    if (!Array.isArray(boxPrefixes) || boxPrefixes.length === 0) {
      pushIssue(errors, 'self_review_scope_box_prefixes_missing', { source });
    }
    const snapshotCardIds = cards.map(card => card?.card_id);
    if (!hasUniqueNonEmptyTextArray(scopeCardIds)) {
      pushIssue(errors, 'self_review_scope_card_ids_invalid', {
        source,
        scopeCardIds,
      });
    }
    if (!hasUniqueNonEmptyTextArray(snapshotCardIds)) {
      pushIssue(errors, 'self_review_snapshot_card_ids_invalid', {
        source,
        card_ids: snapshotCardIds,
      });
    }
    if (
      scopeCardIds.length !== snapshotCardIds.length ||
      !setsEqual(scopeCardIds, snapshotCardIds)
    ) {
      pushIssue(errors, 'self_review_scope_card_ids_mismatch', {
        source,
        scopeCardIds,
        actualCardIds: snapshotCardIds,
      });
    }
    if (!Array.isArray(record.specs_read) || record.specs_read.length === 0) {
      pushIssue(errors, 'self_review_specs_read_missing', { source });
    }
    if (
      !fixture &&
      !isImmutableLegacyRecord &&
      shouldValidateCurrentSelfReviewSnapshots(
        record.quality_audit,
        currentFingerprint,
      )
    ) {
      validateCurrentCardSnapshotIdentity(cards, errors, source);
    }

    if (isConfirmedBoxExpansion) {
      if (boxPrefixes.length !== 1 || !/^\d{4}$/.test(boxPrefixes[0] || '')) {
        pushIssue(errors, 'confirmed_expansion_single_box_scope_required', {source, box_prefixes: boxPrefixes});
      }
      for (const field of ['library', 'group', 'box']) {
        if (!hasText(record.scope?.[field])) {
          pushIssue(errors, 'self_review_scope_field_missing', {source, field});
        }
      }
      const boxPrefix = boxPrefixes[0];
      for (const card of cards) {
        if (card?.knowledge_ref?.box_prefix !== boxPrefix) {
          pushIssue(errors, 'confirmed_expansion_card_box_prefix_mismatch', {source, box_prefix: boxPrefix, card_id: card?.card_id});
        }
      }
      const target = confirmedBoxTarget(record, boxPrefix, errors, source, {template, fixture});
      if (target) {
        const expectedExpansionCount = target.target_card_count - target.sample_card_ids.length;
        if (cards.length !== expectedExpansionCount) {
          pushIssue(errors, 'confirmed_expansion_card_count_mismatch', {source, box_prefix: boxPrefix, expected: expectedExpansionCount, actual: cards.length});
        }
        const sampleIds = new Set(target.sample_card_ids);
        if (scopeCardIds.some(cardId => sampleIds.has(cardId))) {
          pushIssue(errors, 'confirmed_expansion_reuses_sample_card_id', {source, box_prefix: boxPrefix});
        }
      }
      if (record.batch_review?.status !== CONFIRMED_BOX_EXPANSION_STATUS) {
        pushIssue(errors, 'confirmed_expansion_batch_status_invalid', {source, status: record.batch_review?.status});
      }
      const anyBlocked = cards.some(card => card.status !== 'pass' || Object.values(card.blocker_scan || {}).some(Boolean));
      if (anyBlocked) {
        pushIssue(errors, 'confirmed_expansion_contains_unpassed_card', {source});
      }
      if (!hasText(record.batch_review?.box_progression)) {
        pushIssue(errors, 'self_review_batch_box_progression_missing', {source});
      }
      if (!Array.isArray(record.batch_review?.repetition_or_gap_risks)) {
        pushIssue(errors, 'self_review_batch_risks_invalid', {source});
      }
      const representativeCards = record.batch_review?.representative_cards;
      if (!hasNonEmptyTextArray(representativeCards) || new Set(representativeCards).size !== representativeCards.length || !isSubset(representativeCards, scopeCardIds)) {
        pushIssue(errors, 'self_review_batch_representative_cards_invalid', {source, representative_cards: representativeCards});
      }
      if (!hasText(record.batch_review?.next_step)) {
        pushIssue(errors, 'self_review_batch_next_step_missing', {source});
      }
    } else if (isResidualBlockerClosure) {
      if (!hasText(record.scope?.closure_reason)) {
        pushIssue(errors, 'residual_self_review_closure_reason_missing', { source });
      }
      if (!hasNonEmptyTextArray(record.scope?.source_issue_refs)) {
        pushIssue(errors, 'residual_self_review_source_issue_refs_missing', { source });
      }
      if (cards.length !== scopeCardIds.length) {
        pushIssue(errors, 'residual_self_review_scope_card_count_mismatch', {
          source,
          scopeCards: scopeCardIds.length,
          actualCards: cards.length,
        });
      }
      if (record.batch_review?.status === 'recommend_user_confirmation') {
        pushIssue(errors, 'residual_self_review_must_not_recommend_confirmation', { source });
      } else if (record.batch_review?.status !== RESIDUAL_BLOCKER_CLOSURE_STATUS) {
        pushIssue(errors, 'residual_self_review_batch_status_invalid', {
          source,
          status: record.batch_review?.status,
        });
      }
    } else {
      for (const field of ['library', 'group', 'box']) {
        if (!hasText(record.scope?.[field])) {
          pushIssue(errors, 'self_review_scope_field_missing', { source, field });
        }
      }
      validateStandardSampleBoxDistribution(cards, boxPrefixes, errors, source);
      if (!record.batch_review || !STANDARD_SELF_REVIEW_BATCH_STATUSES.includes(record.batch_review.status)) {
        pushIssue(errors, 'self_review_batch_status_invalid', { source, status: record.batch_review?.status });
      }
      if (!hasText(record.batch_review?.box_progression)) {
        pushIssue(errors, 'self_review_batch_box_progression_missing', {source});
      }
      if (!Array.isArray(record.batch_review?.repetition_or_gap_risks)) {
        pushIssue(errors, 'self_review_batch_risks_invalid', {source});
      }
      const representativeCards = record.batch_review?.representative_cards;
      if (
        !hasNonEmptyTextArray(representativeCards) ||
        new Set(representativeCards).size !== representativeCards.length ||
        !isSubset(representativeCards, scopeCardIds)
      ) {
        pushIssue(errors, 'self_review_batch_representative_cards_invalid', {
          source,
          representative_cards: representativeCards,
        });
      }
      if (!hasText(record.batch_review?.next_step)) {
        pushIssue(errors, 'self_review_batch_next_step_missing', {source});
      }
      if (record.batch_review?.status === 'recommend_user_confirmation') {
        const anyBlocked = cards.some(card => card.status !== 'pass' || Object.values(card.blocker_scan || {}).some(Boolean));
        if (anyBlocked) pushIssue(errors, 'self_review_recommends_confirmation_with_blocked_card', { source });
      }
    }
  }
}

function validateApprovalRecord(record, errors, source, {
  template = false,
  fixture = false,
  currentFingerprint = currentCardCorpusFingerprint(),
} = {}) {
  const isFullTrackFinal = record.approval_mode === 'full_track_final';
  if (record.approved_by_user !== true) {
    pushIssue(errors, 'approval_record_not_user_approved', { source });
  }
  for (const field of REQUIRED_APPROVAL_FIELDS) {
    if (!hasOwn(record, field)) {
      pushIssue(errors, 'approval_record_field_missing', { source, field });
    }
  }
  if (!Array.isArray(record.approval_limits) || record.approval_limits.length < 3) {
    pushIssue(errors, 'approval_record_limits_missing', { source });
  }
  validateQualityAuditRecord(record.card_quality_audit, errors, source, {
    template,
    fixture,
    scopeCardIds: record.scope?.card_ids || [],
    requiredForApproval: true,
    allowHistoricalScopedReport: true,
    currentFingerprint,
  });
  if (isFullTrackFinal) {
    const reportSha256 = record.card_quality_audit?.report_sha256;
    if (!hasText(reportSha256)) {
      pushIssue(errors, 'full_track_approval_audit_report_hash_missing', { source });
    } else if (!template && !fixture) {
      if (!/^sha256:[a-f0-9]{64}$/.test(reportSha256)) {
        pushIssue(errors, 'full_track_approval_audit_report_hash_invalid', {
          source,
          report_sha256: reportSha256,
        });
      } else if (exists(record.card_quality_audit?.report)) {
        const actualReportSha256 = `sha256:${crypto
          .createHash('sha256')
          .update(fs.readFileSync(resolveWorkspacePath(record.card_quality_audit.report)))
          .digest('hex')}`;
        if (reportSha256 !== actualReportSha256) {
          pushIssue(errors, 'full_track_approval_audit_report_hash_mismatch', {
            source,
            expected: actualReportSha256,
            actual: reportSha256,
          });
        }
      }
    }
  }
  if (!template) {
    if (
      !hasText(record.approved_at) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.approved_at) ||
      Number.isNaN(Date.parse(record.approved_at))
    ) {
      pushIssue(errors, 'approval_record_approved_at_invalid', {
        source,
        approved_at: record.approved_at,
      });
    }
    if (!hasText(record.summary)) {
      pushIssue(errors, 'approval_record_summary_missing', {source});
    }
    if (isFullTrackFinal) {
      if (!['cet4', 'cet6'].includes(record.scope?.track)) {
        pushIssue(errors, 'full_track_approval_track_invalid', { source, track: record.scope?.track });
      }
    } else {
      for (const field of ['library', 'group', 'box']) {
        if (!hasText(record.scope?.[field])) {
          pushIssue(errors, 'approval_record_scope_field_missing', { source, field });
        }
      }
    }
    const scopeBoxPrefixes = record.scope?.box_prefixes;
    if (
      !hasNonEmptyTextArray(scopeBoxPrefixes) ||
      new Set(scopeBoxPrefixes).size !== scopeBoxPrefixes.length
    ) {
      pushIssue(errors, 'approval_record_scope_box_prefixes_invalid', {
        source,
        box_prefixes: scopeBoxPrefixes,
      });
    }
    const scopeCardIds = record.scope?.card_ids;
    if (
      !hasNonEmptyTextArray(scopeCardIds) ||
      new Set(scopeCardIds).size !== scopeCardIds.length
    ) {
      pushIssue(errors, 'approval_record_scope_card_ids_invalid', {
        source,
        card_ids: scopeCardIds,
      });
    }
    const linkedReview = record.validation?.agent_self_review;
    let selfReview = null;
    if (!hasText(linkedReview)) {
      pushIssue(errors, 'approval_record_missing_agent_self_review', { source });
    } else if (!isCanonicalAgentSelfReviewRecordPath(linkedReview)) {
      pushIssue(errors, 'approval_record_agent_self_review_path_invalid', {
        source,
        linkedReview,
      });
    } else if (!exists(linkedReview)) {
      pushIssue(errors, 'approval_record_agent_self_review_missing_on_disk', { source, linkedReview });
    } else if (!fs.lstatSync(resolveWorkspacePath(linkedReview)).isFile()) {
      pushIssue(errors, 'approval_record_agent_self_review_not_regular_file', {
        source,
        linkedReview,
      });
    } else if (!isTrackedWorkspacePath(linkedReview)) {
      pushIssue(errors, 'approval_record_agent_self_review_not_tracked', {
        source,
        linkedReview,
      });
    } else {
      selfReview = readJson(linkedReview);
      const selfReviewErrors = [];
      validateSelfReviewRecord(
        selfReview,
        selfReviewErrors,
        linkedReview,
        {currentFingerprint},
      );
      if (selfReviewErrors.length > 0) {
        pushIssue(errors, 'approval_record_linked_self_review_invalid', {
          source,
          linkedReview,
          linkedErrors: selfReviewErrors.map(issue => issue.code),
        });
      }
      if (
        hasCurrentApprovalAuditFingerprint(record, currentFingerprint) &&
        !hasCurrentScopedAuditFingerprint(
          selfReview.quality_audit,
          currentFingerprint,
        )
      ) {
        pushIssue(
          errors,
          'approval_record_current_authorization_links_historical_self_review',
          {source, linkedReview},
        );
      }
    }
    if (!hasText(record.validation?.harness)) {
      pushIssue(errors, 'approval_record_harness_validation_missing', { source });
    }
    if (!hasText(record.validation?.cards)) {
      pushIssue(errors, 'approval_record_card_validation_missing', { source });
    }
    if (!hasText(record.validation?.card_quality_audit)) {
      pushIssue(errors, 'approval_record_quality_audit_validation_missing', { source });
    }
    if (record.validation?.card_quality_audit_report !== 'reports/card_quality_audit_report.json') {
      pushIssue(errors, 'approval_record_quality_audit_report_missing', { source });
    }
    if (selfReview) {
      const linkedScopeType = selfReviewScopeType(selfReview);
      const expectedStatus = isFullTrackFinal ? FULL_TRACK_READY_STATUS : 'recommend_user_confirmation';
      const expectedScopeType = isFullTrackFinal ? 'full_track_remediation' : 'three_card_sample_per_box';
      if (linkedScopeType !== expectedScopeType) {
        pushIssue(errors, 'approval_record_review_scope_type_mismatch', {
          source,
          linkedReview,
          expected: expectedScopeType,
          actual: linkedScopeType,
        });
      }
      if (selfReview.batch_review?.status !== expectedStatus) {
        pushIssue(errors, 'approval_record_self_review_not_recommended', {
          source,
          linkedReview,
          expected: expectedStatus,
          status: selfReview.batch_review?.status,
        });
      }
      const scalarFields = isFullTrackFinal ? ['track'] : ['library', 'group', 'box'];
      for (const field of scalarFields) {
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
    if (
      !hasNonEmptyTextArray(record.representative_cards) ||
      new Set(record.representative_cards).size !== record.representative_cards.length ||
      !isSubset(record.representative_cards, scopeCardIds)
    ) {
      pushIssue(errors, 'approval_record_representative_cards_invalid', {
        source,
        representative_cards: record.representative_cards,
      });
    }
  }
}

function readGovernedReviewTemplate(file, expectedKind, errors) {
  const fullPath = resolveWorkspacePath(file);
  if (!fs.existsSync(fullPath)) {
    pushIssue(errors, 'review_template_missing', {source: file});
    return null;
  }
  if (!fs.lstatSync(fullPath).isFile()) {
    pushIssue(errors, 'review_template_not_regular_file', {source: file});
    return null;
  }
  let record;
  try {
    record = readJson(file);
  } catch (error) {
    pushIssue(errors, 'review_template_unreadable', {
      source: file,
      message: error.message,
    });
    return null;
  }
  if (
    expectedKind === 'standard_self_review' &&
    record.sample_policy?.review_scope_type !== 'three_card_sample_per_box'
  ) {
    pushIssue(errors, 'standard_self_review_template_mode_mismatch', {source: file});
  }
  if (
    expectedKind === 'full_track_self_review' &&
    record.sample_policy?.review_scope_type !== 'full_track_remediation'
  ) {
    pushIssue(errors, 'full_track_self_review_template_mode_mismatch', {source: file});
  }
  if (
    expectedKind === 'standard_approval' &&
    hasOwn(record, 'approval_mode')
  ) {
    pushIssue(errors, 'standard_approval_template_mode_mismatch', {
      source: file,
      approval_mode: record.approval_mode,
    });
  }
  if (
    expectedKind === 'full_track_approval' &&
    record.approval_mode !== 'full_track_final'
  ) {
    pushIssue(errors, 'full_track_approval_template_mode_mismatch', {
      source: file,
      approval_mode: record.approval_mode,
    });
  }
  const commonSelfReviewShape = [
    ['review_id', 'string'],
    ['created_at', 'string'],
    ['agent', 'string'],
    ['scope', 'object'],
    ['scope.box_prefixes', 'array'],
    ['scope.card_ids', 'array'],
    ['specs_read', 'array'],
    ['sample_policy', 'object'],
    ['quality_audit', 'object'],
    ['batch_review', 'object'],
    ['batch_review.status', 'string'],
    ['batch_review.next_step', 'string'],
  ];
  const requiredShape = {
    standard_self_review: [
      ...commonSelfReviewShape,
      ['scope.library', 'string'],
      ['scope.group', 'string'],
      ['scope.box', 'string'],
      ['cards', 'array'],
      ['batch_review.box_progression', 'string'],
      ['batch_review.repetition_or_gap_risks', 'array'],
      ['batch_review.representative_cards', 'array'],
    ],
    full_track_self_review: [
      ...commonSelfReviewShape,
      ['scope.track', 'string'],
      ['coverage', 'object'],
      ['coverage.expected_card_count', 'number'],
      ['coverage.reviewed_card_ids', 'array'],
      ['coverage.human_reviewer', 'string'],
      ['coverage.boxes', 'array'],
      ['representative_cards', 'array'],
      ['batch_review.summary', 'string'],
      ['batch_review.remaining_risks', 'array'],
    ],
    standard_approval: [
      ['approval_id', 'string'],
      ['approved_at', 'string'],
      ['scope', 'object'],
      ['scope.library', 'string'],
      ['scope.group', 'string'],
      ['scope.box', 'string'],
      ['scope.box_prefixes', 'array'],
      ['scope.card_ids', 'array'],
      ['summary', 'string'],
      ['representative_cards', 'array'],
      ['card_quality_audit', 'object'],
      ['validation', 'object'],
      ['approval_limits', 'array'],
    ],
    full_track_approval: [
      ['approval_id', 'string'],
      ['approved_at', 'string'],
      ['scope', 'object'],
      ['scope.track', 'string'],
      ['scope.box_prefixes', 'array'],
      ['scope.card_ids', 'array'],
      ['summary', 'string'],
      ['representative_cards', 'array'],
      ['card_quality_audit', 'object'],
      ['card_quality_audit.report_sha256', 'string'],
      ['validation', 'object'],
      ['approval_limits', 'array'],
    ],
  }[expectedKind] || [];
  for (const [fieldPath, expectedType] of requiredShape) {
    const value = fieldPath
      .split('.')
      .reduce((current, field) => current?.[field], record);
    const valid = expectedType === 'array'
      ? Array.isArray(value)
      : expectedType === 'object'
        ? Boolean(value && typeof value === 'object' && !Array.isArray(value))
        : typeof value === expectedType;
    if (!valid) {
      pushIssue(errors, 'review_template_required_shape_missing', {
        source: file,
        expected_kind: expectedKind,
        field: fieldPath,
        expected_type: expectedType,
      });
    }
  }
  return record;
}

function validateApprovalRecordShapeSelfTest(errors) {
  const record = structuredClone(readJson('reviews/approved_batches/TEMPLATE.json'));
  record.approved_at = '';
  record.summary = '';
  record.scope.box_prefixes = ['0000', '0000'];
  record.scope.card_ids = ['000001', '000001'];
  record.representative_cards = null;
  record.validation.agent_self_review = '../forged-review.json';
  const shapeErrors = [];
  validateApprovalRecord(
    record,
    shapeErrors,
    'approval-record-shape-self-test',
    {fixture: true},
  );
  for (const code of [
    'approval_record_approved_at_invalid',
    'approval_record_summary_missing',
    'approval_record_scope_box_prefixes_invalid',
    'approval_record_scope_card_ids_invalid',
    'approval_record_representative_cards_invalid',
    'approval_record_agent_self_review_path_invalid',
  ]) {
    if (!shapeErrors.some(issue => issue.code === code)) {
      pushIssue(errors, 'approval_record_shape_self_test_failed', {
        expected: code,
        actual: shapeErrors,
      });
    }
  }
}

function validateHistoricalScopedAuditRecordAgingSelfTest(errors) {
  const reportPath =
    'reviews/audit_scopes/20260521-front-answer-leak-proof-scope-audit.json';
  if (!exists(reportPath)) {
    pushIssue(errors, 'historical_scoped_audit_link_aging_self_test_missing', {
      report: reportPath,
    });
    return;
  }
  const report = readJson(reportPath);
  const record = {
    report: reportPath,
    corpus_fingerprint: report.corpus_fingerprint?.digest,
    scope_has_no_hard_blockers:
      report.scope_summary?.by_severity?.hard_blocker === 0,
    scope_summary: structuredClone(report.scope_summary),
  };
  const agingErrors = [];
  validateQualityAuditRecord(
    record,
    agingErrors,
    'historical-scoped-audit-link-aging-self-test',
    {
      template: false,
      fixture: false,
      scopeCardIds: report.scope?.card_ids || [],
      requiredForApproval: false,
      allowHistoricalScopedReport: true,
      currentFingerprint: {
        ...report.corpus_fingerprint,
        digest: 'f'.repeat(64),
      },
    },
  );
  if (agingErrors.length > 0) {
    pushIssue(errors, 'historical_scoped_audit_link_aging_self_test_failed', {
      actual: agingErrors,
    });
  }

  const approvalArchiveErrors = [];
  validateQualityAuditRecord(
    record,
    approvalArchiveErrors,
    'historical-scoped-audit-approval-archive-self-test',
    {
      template: false,
      fixture: false,
      scopeCardIds: report.scope?.card_ids || [],
      requiredForApproval: false,
      allowHistoricalScopedReport: true,
      currentFingerprint: {
        ...report.corpus_fingerprint,
        digest: 'f'.repeat(64),
      },
    },
  );
  if (approvalArchiveErrors.length > 0) {
    pushIssue(errors, 'historical_scoped_audit_approval_archive_self_test_failed', {
      actual: approvalArchiveErrors,
    });
  }
  const approvalRecord = {card_quality_audit: record};
  if (hasCurrentApprovalAuditFingerprint(
    approvalRecord,
    {
      ...report.corpus_fingerprint,
      digest: 'f'.repeat(64),
    },
  )) {
    pushIssue(errors, 'historical_approval_misclassified_as_current_self_test_failed', {});
  }
  if (!hasCurrentApprovalAuditFingerprint(
    approvalRecord,
    report.corpus_fingerprint,
  )) {
    pushIssue(errors, 'current_approval_fingerprint_self_test_failed', {});
  }
}

function validateHistoricalSelfReviewLifecycleSelfTest(errors) {
  const reviewPath =
    'reviews/agent_self_review/20260514-cet4-listening-0011-existing-sample.json';
  const reportPath =
    'reviews/audit_scopes/20260521-front-answer-leak-proof-scope-audit.json';
  if (!exists(reviewPath) || !exists(reportPath)) {
    pushIssue(errors, 'historical_self_review_lifecycle_self_test_missing', {
      review: reviewPath,
      report: reportPath,
    });
    return;
  }
  const record = structuredClone(readJson(reviewPath));
  const report = readJson(reportPath);
  record.sample_policy.review_scope_type = 'three_card_sample_per_box';
  record.quality_audit = {
    report: reportPath,
    corpus_fingerprint: report.corpus_fingerprint.digest,
    scope_has_no_hard_blockers: false,
    scope_summary: structuredClone(report.scope_summary),
  };
  record.cards[0].interaction_id = 'flip';

  const simulatedFutureFingerprint = {
    ...report.corpus_fingerprint,
    digest: 'f'.repeat(64),
  };
  const historicalErrors = [];
  validateSelfReviewRecord(
    record,
    historicalErrors,
    'historical-self-review-lifecycle-self-test',
    {currentFingerprint: simulatedFutureFingerprint},
  );
  if (historicalErrors.length > 0) {
    pushIssue(errors, 'historical_self_review_lifecycle_aging_self_test_failed', {
      actual: historicalErrors,
    });
  }

  const currentErrors = [];
  validateSelfReviewRecord(
    record,
    currentErrors,
    'current-self-review-lifecycle-self-test',
    {currentFingerprint: report.corpus_fingerprint},
  );
  if (!currentErrors.some(
    issue => issue.code === 'self_review_card_interaction_mismatch'
  )) {
    pushIssue(errors, 'current_self_review_lifecycle_parity_self_test_failed', {
      actual: currentErrors,
    });
  }
}

function validateHistoricalFullTrackLifecycleSelfTest(errors) {
  const reportPath =
    'reviews/audit_scopes/20260521-front-answer-leak-proof-scope-audit.json';
  if (!exists(reportPath)) {
    pushIssue(errors, 'historical_full_track_lifecycle_self_test_missing', {
      report: reportPath,
    });
    return;
  }
  const report = readJson(reportPath);
  const record = structuredClone(
    readJson('reviews/agent_self_review/FULL_TRACK_TEMPLATE.json'),
  );
  record.scope = {
    track: 'cet4',
    box_prefixes: ['0011'],
    card_ids: structuredClone(report.scope.card_ids),
  };
  record.specs_read = ['spec/review-workflow.json'];
  record.coverage = {
    expected_card_count: report.scope.card_ids.length,
    reviewed_card_ids: structuredClone(report.scope.card_ids),
    human_reviewer: 'external:张三',
    boxes: [{
      box_prefix: '0011',
      status: 'pass',
      reviewer: 'external:张三',
    }],
  };
  record.quality_audit = {
    report: reportPath,
    corpus_fingerprint: report.corpus_fingerprint.digest,
    scope_has_no_hard_blockers: false,
    scope_summary: structuredClone(report.scope_summary),
  };
  record.representative_cards = [report.scope.card_ids[0]];
  record.batch_review.summary = 'historical fixture summary';

  const historicalErrors = [];
  validateSelfReviewRecord(
    record,
    historicalErrors,
    'historical-full-track-lifecycle-self-test',
    {
      currentFingerprint: {
        ...report.corpus_fingerprint,
        digest: 'f'.repeat(64),
      },
    },
  );
  for (const code of [
    'full_track_review_card_scope_not_complete_track',
    'full_track_review_box_scope_not_complete_track',
  ]) {
    if (historicalErrors.some(issue => issue.code === code)) {
      pushIssue(errors, 'historical_full_track_lifecycle_aging_self_test_failed', {
        forbidden: code,
        actual: historicalErrors,
      });
    }
  }

  const currentErrors = [];
  validateSelfReviewRecord(
    record,
    currentErrors,
    'current-full-track-lifecycle-self-test',
    {currentFingerprint: report.corpus_fingerprint},
  );
  for (const code of [
    'full_track_review_card_scope_not_complete_track',
    'full_track_review_box_scope_not_complete_track',
  ]) {
    if (!currentErrors.some(issue => issue.code === code)) {
      pushIssue(errors, 'current_full_track_lifecycle_parity_self_test_failed', {
        expected: code,
        actual: currentErrors,
      });
    }
  }
}

function validateReviewTemplatesAndRecords(errors, warnings) {
  validateReviewRecordDiscovery(errors);
  validateStandardSampleBoxDistributionSelfTest(errors);
  validateCurrentCardSnapshotIdentitySelfTest(errors);
  validateReviewIdentityUniquenessSelfTest(errors);
  validateApprovalRecordShapeSelfTest(errors);
  validateHistoricalScopedAuditRecordAgingSelfTest(errors);
  validateHistoricalSelfReviewLifecycleSelfTest(errors);
  validateHistoricalFullTrackLifecycleSelfTest(errors);
  const standardSelfReviewTemplate = readGovernedReviewTemplate(
    'reviews/agent_self_review/TEMPLATE.json',
    'standard_self_review',
    errors,
  );
  const fullTrackSelfReviewTemplate = readGovernedReviewTemplate(
    'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
    'full_track_self_review',
    errors,
  );
  const standardApprovalTemplate = readGovernedReviewTemplate(
    'reviews/approved_batches/TEMPLATE.json',
    'standard_approval',
    errors,
  );
  const fullTrackApprovalTemplate = readGovernedReviewTemplate(
    'reviews/approved_batches/FULL_TRACK_TEMPLATE.json',
    'full_track_approval',
    errors,
  );
  const sampleConfirmationTemplate = readGovernedReviewTemplate(
    'reviews/sample_confirmations/TEMPLATE.json',
    'sample_confirmation',
    errors,
  );
  if (standardSelfReviewTemplate) {
    validateSelfReviewRecord(
      standardSelfReviewTemplate,
      errors,
      'reviews/agent_self_review/TEMPLATE.json',
      {template: true},
    );
  }
  if (fullTrackSelfReviewTemplate) {
    validateSelfReviewRecord(
      fullTrackSelfReviewTemplate,
      errors,
      'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
      {template: true},
    );
  }
  if (standardApprovalTemplate) {
    validateApprovalRecord(
      standardApprovalTemplate,
      errors,
      'reviews/approved_batches/TEMPLATE.json',
      {template: true},
    );
  }
  if (fullTrackApprovalTemplate) {
    validateApprovalRecord(
      fullTrackApprovalTemplate,
      errors,
      'reviews/approved_batches/FULL_TRACK_TEMPLATE.json',
      {template: true},
    );
  }
  if (sampleConfirmationTemplate) {
    validateSampleConfirmationRecord(
      sampleConfirmationTemplate,
      errors,
      'reviews/sample_confirmations/TEMPLATE.json',
      {template: true},
    );
  }

  for (const file of listReviewRecordFiles('reviews/sample_confirmations')) {
    if (!isCanonicalReviewRecordPath(file, 'reviews/sample_confirmations')) {
      pushIssue(errors, 'sample_confirmation_path_noncanonical', {source: file});
      continue;
    }
    if (hasUnsafeReviewPathCharacters(file)) {
      pushIssue(errors, 'sample_confirmation_path_characters_invalid', {source: file});
      continue;
    }
    if (!fs.lstatSync(resolveWorkspacePath(file)).isFile()) {
      pushIssue(errors, 'sample_confirmation_not_regular_file', {source: file});
      continue;
    }
    validateSampleConfirmationRecord(readJson(file), errors, file);
  }

  for (const file of listReviewRecordFiles('reviews/agent_self_review')) {
    if (!isCanonicalReviewRecordPath(file, 'reviews/agent_self_review')) {
      pushIssue(errors, 'agent_self_review_path_noncanonical', {
        source: file,
        expected_parent: 'reviews/agent_self_review',
      });
      continue;
    }
    if (hasUnsafeReviewPathCharacters(file)) {
      pushIssue(errors, 'agent_self_review_path_characters_invalid', {source: file});
      continue;
    }
    if (!fs.lstatSync(resolveWorkspacePath(file)).isFile()) {
      pushIssue(errors, 'agent_self_review_not_regular_file', {source: file});
      continue;
    }
    validateSelfReviewRecord(readJson(file), errors, file);
  }
  for (const file of listReviewRecordFiles('reviews/approved_batches')) {
    if (!isCanonicalReviewRecordPath(file, 'reviews/approved_batches')) {
      pushIssue(errors, 'approved_batch_path_noncanonical', {
        source: file,
        expected_parent: 'reviews/approved_batches',
      });
      continue;
    }
    if (hasUnsafeReviewPathCharacters(file)) {
      pushIssue(errors, 'approved_batch_path_characters_invalid', {source: file});
      continue;
    }
    if (!fs.lstatSync(resolveWorkspacePath(file)).isFile()) {
      pushIssue(errors, 'approved_batch_not_regular_file', {source: file});
      continue;
    }
    const record = readJson(file);
    validateApprovalRecord(record, errors, file);
    if (!hasCurrentApprovalAuditFingerprint(record)) {
      pushIssue(warnings, 'historical_approval_record_not_current_authorization', {
        source: file,
      });
    }
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
  for (const token of [
    'validateQualityMetadata',
    'validateEliminationIntegrity',
    'invalid_card_box_filename',
    'allowLegacyContract',
  ]) {
    if (!structuralValidator.includes(token)) {
      pushIssue(errors, 'card_validator_integrity_guard_missing', { token });
    }
  }

  if (!exists('scripts/lib/card_integrity.mjs')) {
    pushIssue(errors, 'card_integrity_library_missing', {});
  } else {
    const integrityLibrary = readText('scripts/lib/card_integrity.mjs');
    for (const token of [
      'loadIntegrityPolicy',
      'isHumanReviewerIdentity',
      'validateQualityMetadata',
      'validateEliminationIntegrity',
      'validateChangedCardSelfReviewParity',
      'validateCurrentApprovalRecordReference',
      'loadCurrentCardQualityAudit',
      'buildCurrentScopedAuditReplay',
      'captureGitAuthorizationSnapshot',
      'committedGitFileState',
      'isDirectApprovalRecordPath',
      'isDirectSelfReviewRecordPath',
      'not_committed_at_head',
      'approval_audit_report_replay_mismatch',
      'approval_linked_self_review_audit_replay_mismatch',
      'approval_linked_self_review_not_current',
      'approval_current_corpus_changed_during_validation',
      'approval_git_snapshot_changed_during_validation',
      'approval_authorization_file_changed_during_validation',
      'candidate_quality_metadata_missing',
      'candidate_self_review_metadata_mismatch',
      'elimination_legacy_mirror_mismatch',
      'elimination_correct_items_truth_mismatch',
    ]) {
      if (!integrityLibrary.includes(token)) {
        pushIssue(errors, 'card_integrity_library_guard_missing', { token });
      }
    }
  }
  if (!exists('scripts/migrate_cards_to_softbook_contract.mjs')) {
    pushIssue(errors, 'card_contract_migration_missing', {});
  } else {
    const migration = readText('scripts/migrate_cards_to_softbook_contract.mjs');
    for (const token of [
      'buildEliminationContract',
      'elimination_items',
      'correct_items',
      'item.id',
    ]) {
      if (!migration.includes(token)) {
        pushIssue(errors, 'card_contract_migration_runtime_id_guard_missing', {token});
      }
    }
  }
}

function validateGitWorkflow(errors) {
  const gitWorkflow = readJson('spec/git-workflow.json');
  const agentEntry = readText('AGENTS.md');
  const agentHarness = readJson('spec/agent-harness.json');
  const authorityMap = readJson('spec/authority-map.json');
  const manifest = readJson('spec/doc-manifest.json');
  const activePaths = new Set((manifest.active_docs || []).map(doc => doc.path));
  const handoffTemplate = readJson('reviews/git_handoffs/TEMPLATE.json');

  if (gitWorkflow.status !== 'active') {
    pushIssue(errors, 'git_workflow_not_active', { status: gitWorkflow.status });
  }
  for (const requiredPath of [
    'scripts/lib/card_integrity.mjs',
    'scripts/validate_cards.mjs',
    'scripts/migrate_cards_to_softbook_contract.mjs',
    'scripts/validate_pr_scope.mjs',
    'scripts/validate_delivery_record.mjs',
  ]) {
    if (!activePaths.has(requiredPath)) {
      pushIssue(errors, 'integrity_validator_manifest_entry_missing', { requiredPath });
    }
  }
  if (authorityMap.owners?.content_pr_scope_gate !== 'scripts/validate_pr_scope.mjs') {
    pushIssue(errors, 'pr_scope_validator_owner_drift', {
      owner: authorityMap.owners?.content_pr_scope_gate,
    });
  }
  if (authorityMap.owners?.candidate_card_integrity !== 'scripts/lib/card_integrity.mjs') {
    pushIssue(errors, 'candidate_card_integrity_owner_drift', {
      owner: authorityMap.owners?.candidate_card_integrity,
    });
  }
  if (authorityMap.owners?.candidate_card_structural_validation !== 'scripts/validate_cards.mjs') {
    pushIssue(errors, 'candidate_card_validator_owner_drift', {
      owner: authorityMap.owners?.candidate_card_structural_validation,
    });
  }
  if (authorityMap.owners?.legacy_card_contract_migration !== 'scripts/migrate_cards_to_softbook_contract.mjs') {
    pushIssue(errors, 'legacy_card_contract_migration_owner_drift', {
      owner: authorityMap.owners?.legacy_card_contract_migration,
    });
  }
  if (!exists('scripts/validate_pr_scope.mjs')) {
    pushIssue(errors, 'pr_scope_validator_missing', {});
  } else {
    const prScopeValidator = readText('scripts/validate_pr_scope.mjs');
    for (const token of [
      'content_sample_global_report_changed',
      'content_sample_non_scope_self_review_changed',
      'content_sample_non_scope_scoped_audit_changed',
      'content_sample_multiple_scope_prefixes_missing_evidence',
      'content_sample_current_audit_scope_hard_blockers',
      'content_candidate_front_answer_leak_queue',
      'content_candidate_residual_blocker_closure',
      'multi_prefix_review_unit',
      'no_auto_merge_content_candidate_user_confirmation_required',
      'scripts/audit_card_quality.mjs',
      'rev-parse',
      'resolved_head',
      'reports/card_quality_audit_report.json',
      'reports/card_validation_report.json',
      'validateChangedCardSelfReviewParity',
      'candidate_quality_metadata_missing',
      'candidate_self_review_missing',
      'candidate_self_review_metadata_mismatch',
      'candidate_card_box_path_invalid',
      'changed_self_review_current_corpus_parity_invalid',
      'changed_self_review_deleted',
      'changed_self_review_path_noncanonical',
      'changed_self_review_not_regular_file',
      'changed_self_review_per_box_card_count_invalid',
      'changed_self_review_card_knowledge_ref_mismatch',
      'changed_self_review_scope_type_required',
      'changed_self_review_residual_scoped_audit_required',
      'changed_self_review_standard_scoped_audit_required',
      'changed_self_review_batch_box_progression_missing',
      'changed_added_card_requires_standard_sample_review',
      'changed_full_track_review_scope_coverage_mismatch',
      'changed_full_track_review_cards_forbidden',
      'changed_full_track_review_human_reviewer_invalid',
      'changed_full_track_review_quality_audit_summary_invalid',
      'changed_full_track_review_scoped_audit_required',
      'changed_full_track_review_batch_status_invalid',
      'changed_full_track_review_track_card_scope_mismatch',
      'changed_full_track_review_track_box_scope_mismatch',
      'changed_full_track_review_track_membership_changed',
      'pre_cutover_report_index_immutable',
      'changed_scoped_audit_invalid',
      'changed_scoped_audit_replay_mismatch',
      'changed_scoped_audit_deleted_or_renamed',
      'changed_legacy_scoped_audit_immutable',
      'changed_review_current_scoped_audit_required',
      'changed_review_scoped_audit_replay_mismatch',
      'changed_approval_deleted',
      'changed_approval_linked_self_review_path_invalid',
      'changed_approval_linked_self_review_scope_mismatch',
      'git_diff_path_noncanonical',
      'content_candidate_explicit_head_required',
      'isCardBoxDirectoryPath',
      'isReviewTemplatePath',
      'isSelfReviewJsonPath',
      'isApprovedBatchPath',
      'changedSelfReviewScopeType',
      'isRegularFileAtCommit',
      'isHumanReviewer',
      'REVIEW_TEMPLATE_PATHS',
      'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
      'materializeHeadCardCorpus',
      "'-z'",
      'merge-base',
    ]) {
      if (!prScopeValidator.includes(token)) {
        pushIssue(errors, 'pr_scope_validator_guard_missing', { token });
      }
    }
  }
  for (const consumerPath of [
    'scripts/validate_candidate_review_queue.mjs',
    'scripts/plan_release_gap_samples.mjs',
  ]) {
    if (
      !exists(consumerPath) ||
      !readText(consumerPath).includes('validateCurrentApprovalRecordReference')
    ) {
      pushIssue(errors, 'current_approval_consumer_guard_missing', {
        consumer: consumerPath,
      });
    }
  }
  const currentApprovalTest = readText('scripts/test_card_integrity.mjs');
  if (
    !currentApprovalTest.includes('forged replay') ||
    !currentApprovalTest.includes('approval_audit_report_replay_mismatch') ||
    !currentApprovalTest.includes(
      'approval_linked_self_review_audit_replay_mismatch',
    ) ||
    !currentApprovalTest.includes('approval_record_not_committed_at_head') ||
    !currentApprovalTest.includes(
      'approval_linked_self_review_not_committed_at_head',
    ) ||
    !currentApprovalTest.includes(
      'approval_linked_self_review_audit_not_committed_at_head',
    ) ||
    !currentApprovalTest.includes(
      'approval_current_fingerprint_override_mismatch',
    ) ||
    !currentApprovalTest.includes(
      'approval_current_audit_replay_unavailable',
    ) ||
    !currentApprovalTest.includes('uncommitted authority drift') ||
    !currentApprovalTest.includes('staged authority drift') ||
    !currentApprovalTest.includes(
      'approval_git_snapshot_changed_during_validation',
    ) ||
    !currentApprovalTest.includes(
      'approval_authorization_file_changed_during_validation',
    ) ||
    !currentApprovalTest.includes(
      'approval_current_corpus_changed_during_validation',
    ) ||
    !currentApprovalTest.includes('beforeFinalConsistencyCheck') ||
    !currentApprovalTest.includes('blocked-current-oracle') ||
    !currentApprovalTest.includes("'restore', '--staged'") ||
    !currentApprovalTest.includes('fs.chmodSync')
  ) {
    pushIssue(errors, 'current_approval_replay_regression_test_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('global report refreshes') && guardrail.includes('non-scope self-review')
  )) {
    pushIssue(errors, 'agent_harness_pr_scope_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('multi-prefix content') && guardrail.includes('explicit handoff')
  )) {
    pushIssue(errors, 'agent_harness_multi_prefix_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('merge-base-to-head') && guardrail.includes('canonical governed filename')
  )) {
    pushIssue(errors, 'agent_harness_candidate_diff_path_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('exact repository-declared template paths') &&
    guardrail.includes('filename prefix') &&
    guardrail.includes('approved_batches') &&
    guardrail.includes('approval records') &&
    guardrail.includes('direct regular JSON children') &&
    guardrail.includes('Git paths are preserved exactly')
  )) {
    pushIssue(errors, 'agent_harness_unprefixed_review_path_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('complete immutable HEAD card_boxes_json tree') &&
    guardrail.includes('deleted or renamed base paths')
  )) {
    pushIssue(errors, 'agent_harness_head_audit_snapshot_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('HEAD corpus card') && guardrail.includes('review_status')
  )) {
    pushIssue(errors, 'agent_harness_candidate_metadata_parity_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('standalone harness validation') &&
    guardrail.includes('all quality_metadata except review_status')
  )) {
    pushIssue(errors, 'agent_harness_standalone_snapshot_parity_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('every new or changed standard, residual-closure, or full-track review') &&
    guardrail.includes('byte-for-byte immutable')
  )) {
    pushIssue(errors, 'agent_harness_pre_cutover_immutability_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('every new or changed direct scoped-audit JSON artifact') &&
    guardrail.includes('structurally valid unchanged historical fingerprints') &&
    guardrail.includes('current-track parity') &&
    guardrail.includes('historical approval') &&
    guardrail.includes('current authorization') &&
    guardrail.includes('evidence churn')
  )) {
    pushIssue(errors, 'agent_harness_scoped_audit_artifact_lifecycle_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('current-authorization consumers') &&
    guardrail.includes('direct canonical non-template approval') &&
    guardrail.includes('complete linked self-review') &&
    guardrail.includes('regular committed evidence') &&
    guardrail.includes('active audit script') &&
    guardrail.includes('active audit rule spec') &&
    guardrail.includes('worktree, index, and one fixed HEAD modes and bytes agree') &&
    guardrail.includes('regenerate the complete current card-quality audit') &&
    guardrail.includes('both scoped reports to be exact replays') &&
    guardrail.includes('recheck the fixed HEAD/index snapshot') &&
    guardrail.includes('historical records remain archive-only')
  )) {
    pushIssue(errors, 'agent_harness_current_approval_authorization_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('exactly three immutable-HEAD-matching snapshots') &&
    guardrail.includes('explicit residual scope type and direct scoped audit') &&
    guardrail.includes('cannot authorize a newly added card')
  )) {
    pushIssue(errors, 'agent_harness_standard_sample_box_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('aggregate human-review evidence') &&
    guardrail.includes('structured non-automation human identity') &&
    guardrail.includes('quality_audit summary') &&
    guardrail.includes('complete declared track card and box-prefix sets') &&
    guardrail.includes('merge-base plus HEAD track membership') &&
    guardrail.includes('no cards property')
  )) {
    pushIssue(errors, 'agent_harness_full_track_aggregate_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('elimination_items IDs') && guardrail.includes('answer_key.correct_items')
  )) {
    pushIssue(errors, 'agent_harness_elimination_integrity_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('required v2 literal-pathspec patch digest') &&
    guardrail.includes('explicit fixed HEAD tree') &&
    guardrail.includes('100644 JSON blob')
  )) {
    pushIssue(errors, 'agent_harness_delivery_payload_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('exact repository-declared handoff template path') &&
    guardrail.includes('fatal byte-preserving UTF-8 decoding') &&
    guardrail.includes('leading U+FEFF') &&
    guardrail.includes('no-ignore gitlink discovery') &&
    guardrail.includes('full reachable pre- and post-payload commit sets') &&
    guardrail.includes('merged side histories') &&
    guardrail.includes('add-delete') &&
    guardrail.includes('identical-tree merge') &&
    guardrail.includes('append-only') &&
    guardrail.includes('card_boxes_json') &&
    guardrail.includes('auto-merge authority')
  )) {
    pushIssue(errors, 'agent_harness_delivery_history_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('fixed base, head, and payload commit OIDs') &&
    guardrail.includes('canonical no-replace/no-grafts environment') &&
    guardrail.includes('symlink') &&
    guardrail.includes('GIT_REPLACE_REF_BASE') &&
    guardrail.includes('common-dir info/grafts') &&
    guardrail.includes('linked-worktree grafts') &&
    guardrail.includes('legacy-hash')
  )) {
    pushIssue(errors, 'agent_harness_delivery_object_and_replace_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('mandatory for every current changed handoff') &&
    guardrail.includes('deterministic environment') &&
    guardrail.includes('commit-sourced attributes') &&
    guardrail.includes('custom diff-driver config fail closed') &&
    guardrail.includes('legacy hashing remains archive-helper-only')
  )) {
    pushIssue(errors, 'agent_harness_delivery_v2_canonicalization_guardrail_missing', {});
  }
  if (!(agentHarness.operating_model?.guardrails || []).some(guardrail =>
    guardrail.includes('delivery-record gate') &&
    guardrail.includes('exact pull_request head SHA') &&
    guardrail.includes('synthetic merge coverage')
  )) {
    pushIssue(errors, 'agent_harness_exact_pr_head_guardrail_missing', {});
  }
  if (!agentEntry.includes('## Agent-Managed Git')) {
    pushIssue(errors, 'agent_entry_missing_git_section', {});
  }
  if (!agentEntry.includes('commit, push, and open or update a draft PR')) {
    pushIssue(errors, 'agent_entry_missing_git_completion_rule', {});
  }

  for (const owned of [
    'pre_edit_git_status_check',
    'commit',
    'push',
    'open_or_update_draft_PR',
    'publish_handoff',
    'auto_merge_validated_harness_or_tooling_PRs_under_standing_user_delegation',
  ]) {
    if (!(gitWorkflow.authority_boundary?.agent_owns || []).includes(owned)) {
      pushIssue(errors, 'git_agent_owned_step_missing', { owned });
    }
  }
  for (const reserved of ['formal_content_approval', 'formal_content_PR_merge_unless_scope_delegated']) {
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
  for (const command of [
    'node scripts/validate_harness.mjs',
    'node scripts/validate_audio_qc.mjs',
    'node scripts/validate_cards.mjs --report-path exports/card_validation_report.json',
    CARD_INTEGRITY_TEST_COMMAND,
    SCOPED_AUDIT_VALIDATION_COMMAND,
    PR_SCOPE_VALIDATION_COMMAND,
    PR_SCOPE_TEST_COMMAND,
    DELIVERY_RECORD_TEST_COMMAND,
    'git diff --check',
  ]) {
    if (!validationCommands.includes(command)) {
      pushIssue(errors, 'git_validation_command_missing', { command });
    }
  }
  const contentPrScopeGate = (gitWorkflow.validation_policy?.before_commit || [])
    .find(entry => entry.scope === 'content_sample_pr_scope');
  if (!(contentPrScopeGate?.blocks || []).some(block =>
    block.includes('candidate-queue or release-gap consumers') &&
    block.includes('historical approvals') &&
    block.includes('dirty/staged/mode-drifted audit authority or approval/review/audit evidence') &&
    block.includes('concurrent HEAD/index/file/corpus drift') &&
    block.includes('forged current-digest audits') &&
    block.includes('stale linked self-reviews') &&
    block.includes('one fixed worktree/index/HEAD snapshot') &&
    block.includes('regenerating the complete current audit') &&
    block.includes('exactly replaying both scoped reports') &&
    block.includes('current authorization')
  )) {
    pushIssue(errors, 'git_current_approval_consumer_block_missing', {});
  }
  const prGatesWorkflow = readText('.github/workflows/pr-gates.yml');
  const pullRequestHeadPolicy = String(gitWorkflow.validation_policy?.delivery_record_head_policy || '');
  if (
    !pullRequestHeadPolicy.includes('github.event.pull_request.head.sha') ||
    !pullRequestHeadPolicy.includes('exact number, URL, state, draft, head/base branch, and head/base repository metadata') ||
    !pullRequestHeadPolicy.includes('synthetic merge checkout')
  ) {
    pushIssue(errors, 'git_validation_exact_pr_head_policy_missing', {});
  }
  if (
    !prGatesWorkflow.includes(
      'node scripts/validate_delivery_record.mjs --base "origin/${{ github.base_ref }}" --head "${{ github.event.pull_request.head.sha }}"',
    )
  ) {
    pushIssue(errors, 'github_delivery_record_exact_head_missing', {});
  }
  for (const token of [
    'DELIVERY_PR_NUMBER: ${{ github.event.pull_request.number }}',
    'DELIVERY_PR_URL: ${{ github.event.pull_request.html_url }}',
    'DELIVERY_PR_STATE: ${{ github.event.pull_request.state }}',
    'DELIVERY_PR_MERGED: ${{ github.event.pull_request.merged }}',
    'DELIVERY_PR_DRAFT: ${{ github.event.pull_request.draft }}',
    'DELIVERY_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    'DELIVERY_HEAD_BRANCH: ${{ github.event.pull_request.head.ref }}',
    'DELIVERY_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}',
    'DELIVERY_BASE_BRANCH: ${{ github.event.pull_request.base.ref }}',
    'DELIVERY_BASE_REPOSITORY: ${{ github.event.pull_request.base.repo.full_name }}',
  ]) {
    if (!prGatesWorkflow.includes(token)) {
      pushIssue(errors, 'github_delivery_record_event_binding_missing', {token});
    }
  }
  if (prGatesWorkflow.includes('ref: ${{ github.event.pull_request.head.sha')) {
    pushIssue(errors, 'github_pr_gate_synthetic_merge_coverage_removed', {});
  }
  for (const command of [
    CARD_INTEGRITY_TEST_COMMAND,
    PR_SCOPE_TEST_COMMAND,
    DELIVERY_RECORD_TEST_COMMAND,
  ]) {
    if (!prGatesWorkflow.includes(command)) {
      pushIssue(errors, 'github_pr_gate_integrity_test_missing', { command });
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
  if (gitWorkflow.merge_policy?.default !== 'standing_user_delegation_auto_merge_for_validated_harness_or_tooling_PRs') {
    pushIssue(errors, 'git_merge_default_drift', {});
  }
  const delegation = gitWorkflow.merge_policy?.standing_user_delegation || {};
  if (!delegation.scope?.includes('harness_changes') || !delegation.scope?.includes('tooling_changes')) {
    pushIssue(errors, 'git_auto_merge_delegation_scope_missing', {});
  }
  for (const requirement of [
    'local_validation_passed',
    'PR_ready_or_not_draft',
    'GitHub_mergeable',
    'no_bulk_card_content_changes',
    'base_branch_or_target_clear',
  ]) {
    if (!(delegation.requires || []).includes(requirement)) {
      pushIssue(errors, 'git_auto_merge_requirement_missing', { requirement });
    }
  }
  for (const condition of ['formal_content_not_user_approved', 'validator_failing', 'PR_scope_mixes_harness_and_bulk_content']) {
    if (!(gitWorkflow.merge_policy?.never_merge_when || []).includes(condition)) {
      pushIssue(errors, 'git_never_merge_condition_missing', { condition });
    }
  }

  for (const requiredPath of [
    'scripts/test_card_integrity.mjs',
    'scripts/test_validate_pr_scope.mjs',
    'scripts/test_validate_delivery_record.mjs',
  ]) {
    if (!exists(requiredPath)) {
      pushIssue(errors, 'integrity_regression_test_missing', { requiredPath });
    }
  }
  if (!exists('scripts/validate_delivery_record.mjs')) {
    pushIssue(errors, 'delivery_record_validator_missing', {});
  } else {
    const deliveryValidator = readText('scripts/validate_delivery_record.mjs');
    for (const token of [
      'git-diff-binary-v2',
      'patch_sha256',
      'base_commit_sha',
      'touched_paths',
      'PARKED_NO_PR_WIP_LIMIT',
      '/pull/',
      '/compare/',
      '--literal-pathspecs',
      'readHandoffBlobAtHead',
      "'ls-tree'",
      "'cat-file', 'blob'",
      'REGULAR_HANDOFF_MODE',
      'canonicalGitEnvironment',
      'resolveCommitOid',
      'current handoff scope.patch_format must equal',
      'HANDOFF_TEMPLATE_PATH',
      'changedPathsAcrossCommits',
      'FATAL_UTF8_DECODER',
      'decodeGitUtf8',
      'ignoreBOM: true',
      'V2_INHERITED_ENV_KEYS',
      'V2_GIT_CONFIG',
      'V2_DIFF_OPTIONS',
      'GIT_ATTR_SOURCE',
      'GIT_GRAFT_FILE',
      'GIT_NO_REPLACE_OBJECTS',
      'assertNoRepositoryGrafts',
      'validateHandoffSchema',
      'validatePullRequestBinding',
      'validateParkedPushRef',
      'payload history contains a transient or restored path',
      'current handoff record must be append-only',
      '--ignore-submodules=none',
      'assertNoRepositoryInfoAttributes',
      'assertNoCustomDiffDriverConfig',
      "['core.bigFileThreshold', '512m']",
      "['diff.compactionHeuristic', 'false']",
      "['diff.orderFile', os.devNull]",
      '\\u2028',
      '\\u2029',
    ]) {
      if (!deliveryValidator.includes(token)) {
        pushIssue(errors, 'delivery_record_integrity_guard_missing', { token });
      }
    }
    if (deliveryValidator.includes("'--ancestry-path'")) {
      pushIssue(errors, 'delivery_record_reachable_history_narrowed', {});
    }
    if (deliveryValidator.split("execFileSync('git'").length - 1 !== 1) {
      pushIssue(errors, 'delivery_record_git_helper_bypassed', {});
    }
    for (const option of ['--no-ext-diff', '--ignore-submodules=none']) {
      const occurrences = deliveryValidator.split(option).length - 1;
      if (occurrences < 3) {
        pushIssue(errors, 'delivery_record_path_walk_option_missing', {option, occurrences});
      }
    }
  }
  if (exists('scripts/test_validate_delivery_record.mjs')) {
    const deliveryTests = readText('scripts/test_validate_delivery_record.mjs');
    for (const token of [
      'V2_GOLDEN_SHA256',
      '4fa4d17ca8633b5313260f144fffaf7230b9c19adc5246e34e99685c25578fed',
      'an arbitrary TEMPLATE suffix remains a governed handoff record',
      'a post-payload mutation even when a later commit restores the payload tree',
      'mutations hidden in a pre-payload side branch with an identical-tree merge',
      'a non-UTF-8 payload path instead of hashing a lossy alias',
      'a leading UTF-8 BOM in a payload path instead of accepting its stripped alias',
      'a restored non-UTF-8 path in post-payload history',
      'the explicit pull-request head when the base branch advances',
      'ignores ambient diff formatting and attribute config',
      'prechecks ignore malformed injected Git config environment',
      'rejects non-empty repository info attributes',
      'rejects ambient custom diff-driver config',
      'rejects worktree custom diff-driver config',
      'includes gitlinks despite ambient submodule ignore config',
      'payload completeness rejects an omitted gitlink despite ambient submodule ignore config',
      'requires a direct regular 100644 handoff blob at fixed HEAD',
      'rejects a valid JSON symlink blob',
      'rejects an executable JSON blob',
      'rejects a gitlink in the handoff zone',
      'rejects nested or anomalous handoff record paths',
      'rejects removing v2 fields to downgrade a current handoff',
      'ignores Git replace refs when inspecting fixed payload history',
      'ignores an injected GIT_REPLACE_REF_BASE when inspecting fixed history',
      'rejects transient paths anywhere in the complete pre-payload history',
      'enforces the complete current handoff schema and authority mapping',
      'requires canonical handoff identity and a real calendar timestamp',
      'candidate card payload cannot claim harness auto-merge authority',
      'binds real pull-request records to exact event metadata',
      'requires parked push_ref evidence to resolve to the explicit head',
      'requires the current handoff artifact to be append-only',
      'rejects legacy Git grafts from the common repository directory',
    ]) {
      if (!deliveryTests.includes(token)) {
        pushIssue(errors, 'delivery_record_regression_coverage_missing', {token});
      }
    }
  }
  if (gitWorkflow.handoff_policy?.directory !== 'reviews/git_handoffs/') {
    pushIssue(errors, 'git_handoff_directory_drift', {});
  }
  if (gitWorkflow.handoff_policy?.template_path !== GIT_HANDOFF_TEMPLATE_PATH) {
    pushIssue(errors, 'git_handoff_template_path_drift', {});
  }
  for (const field of REQUIRED_GIT_HANDOFF_FIELDS) {
    if (!(gitWorkflow.handoff_policy?.required_fields || []).includes(field)) {
      pushIssue(errors, 'git_handoff_required_field_missing', { field });
    }
    if (!(field in handoffTemplate)) {
      pushIssue(errors, 'git_handoff_template_field_missing', { field });
    }
  }
  if (handoffTemplate.merge_authority !== 'standing_user_delegation_auto_merge_for_validated_harness_or_tooling_PRs') {
    pushIssue(errors, 'git_handoff_template_merge_authority_drift', {});
  }
  if (handoffTemplate.PR_state !== 'MERGED') {
    pushIssue(errors, 'git_handoff_template_PR_state_drift', {});
  }
  if (handoffTemplate.is_draft !== false) {
    pushIssue(errors, 'git_handoff_template_draft_state_drift', {});
  }
  const handoffPolicy = gitWorkflow.handoff_policy || {};
  if (handoffPolicy.payload_commit_policy?.commit_sha_meaning !== 'the final payload commit before the handoff-only commit') {
    pushIssue(errors, 'git_handoff_payload_commit_policy_drift', {});
  }
  if (!String(handoffPolicy.payload_commit_policy?.payload_path_set || '').includes('exactly equal')) {
    pushIssue(errors, 'git_handoff_payload_path_completeness_missing', {});
  }
  for (const token of ['every commit reachable', 'add-delete', 'modify-restore', 'restored side-branch paths fail closed']) {
    if (!String(handoffPolicy.payload_commit_policy?.payload_path_set || '').includes(token)) {
      pushIssue(errors, 'git_handoff_payload_history_policy_missing', {token});
    }
  }
  const postPayloadPolicy = String(handoffPolicy.payload_commit_policy?.post_payload_changes || '');
  if (
    !postPayloadPolicy.includes('full commit set reachable') ||
    !postPayloadPolicy.includes('not from commit_sha') ||
    !postPayloadPolicy.includes('only the current handoff record') ||
    !postPayloadPolicy.includes('merged side histories') ||
    !postPayloadPolicy.includes('identical-tree merge')
  ) {
    pushIssue(errors, 'git_handoff_post_payload_restriction_missing', {});
  }
  const recordObjectPolicy = handoffPolicy.record_object_policy || {};
  for (const token of ['direct safe', '<record>.json', 'excluding only reviews/git_handoffs/TEMPLATE.json']) {
    if (!String(recordObjectPolicy.path || '').includes(token)) {
      pushIssue(errors, 'git_handoff_record_path_policy_missing', {token});
    }
  }
  for (const token of ['100644 blob', 'symlinks', 'executable blobs', 'gitlinks', 'nested records', 'Unicode line separators']) {
    if (!String(recordObjectPolicy.fixed_head_object || '').includes(token)) {
      pushIssue(errors, 'git_handoff_record_object_policy_missing', {token});
    }
  }
  for (const token of ['literal-pathspec ls-tree -z', 'exact path/mode/type', 'cat-file blob <object_oid>']) {
    if (!String(recordObjectPolicy.read_method || '').includes(token)) {
      pushIssue(errors, 'git_handoff_record_read_policy_missing', {token});
    }
  }
  for (const token of ['absent from both base_commit and commit_sha', 'overwritten', 'deleted and re-added', 'renamed']) {
    if (!String(recordObjectPolicy.append_only || '').includes(token)) {
      pushIssue(errors, 'git_handoff_append_only_policy_missing', {token});
    }
  }
  const semanticGitReads = handoffPolicy.semantic_git_reads || {};
  for (const token of ['base, head, and handoff commit_sha', 'direct full commit OIDs once', 'tree, or blob inspection']) {
    if (!String(semanticGitReads.fixed_oids || '').includes(token)) {
      pushIssue(errors, 'git_handoff_fixed_oid_policy_missing', {token});
    }
  }
  if (JSON.stringify(semanticGitReads.environment) !== JSON.stringify(SEMANTIC_GIT_ENVIRONMENT)) {
    pushIssue(errors, 'git_handoff_semantic_environment_drift', {});
  }
  for (const token of ['Git replace refs', 'GIT_REPLACE_REF_BASE', 'info/grafts', 'GIT_GRAFT_FILE', 'linked worktrees', 'ref resolution', 'patch hashing']) {
    if (!String(semanticGitReads.replace_policy || '').includes(token)) {
      pushIssue(errors, 'git_handoff_replace_policy_missing', {token});
    }
  }
  for (const field of [
    'required',
    'non_empty',
    'repository_relative',
    'sorted',
    'unique',
    'must_exclude_current_handoff',
    'must_name_changed_payload_paths_only',
    'must_reject_transient_or_restored_payload_history',
  ]) {
    if (handoffPolicy.touched_paths_policy?.[field] !== true) {
      pushIssue(errors, 'git_handoff_touched_paths_policy_missing', { field });
    }
  }
  if (handoffPolicy.patch_integrity?.legacy_helper_format !== 'git-diff-binary-scoped-v1') {
    pushIssue(errors, 'git_handoff_legacy_patch_format_drift', {});
  }
  if (
    !String(handoffPolicy.patch_integrity?.legacy_archive_policy || '').includes('archive tooling only') ||
    !String(handoffPolicy.patch_integrity?.legacy_archive_policy || '').includes('must never omit or downgrade')
  ) {
    pushIssue(errors, 'git_handoff_legacy_downgrade_policy_missing', {});
  }
  if (handoffPolicy.patch_integrity?.new_format !== 'git-diff-binary-v2') {
    pushIssue(errors, 'git_handoff_v2_patch_format_drift', {});
  }
  if (handoffPolicy.patch_integrity?.current_handoff_required_format !== 'git-diff-binary-v2') {
    pushIssue(errors, 'git_handoff_current_v2_requirement_missing', {});
  }
  if (!String(handoffPolicy.touched_paths_policy?.git_pathspec_handling || '').includes('--literal-pathspecs')) {
    pushIssue(errors, 'git_handoff_literal_pathspec_policy_missing', {});
  }
  const pathEncodingPolicy = String(handoffPolicy.touched_paths_policy?.path_encoding || '');
  if (
    !pathEncodingPolicy.includes('valid UTF-8') ||
    !pathEncodingPolicy.includes('decoded fatally') ||
    !pathEncodingPolicy.includes('byte-preservingly') ||
    !pathEncodingPolicy.includes('leading UTF-8 BOM') ||
    !pathEncodingPolicy.includes('U+FEFF') ||
    !pathEncodingPolicy.includes('fail closed')
  ) {
    pushIssue(errors, 'git_handoff_path_encoding_policy_missing', {});
  }
  const pathDiscoveryPolicy = String(handoffPolicy.touched_paths_policy?.path_discovery || '');
  for (const token of ['Every payload and post-payload path walk', '--no-ext-diff', '--ignore-submodules=none', 'gitlink']) {
    if (!pathDiscoveryPolicy.includes(token)) {
      pushIssue(errors, 'git_handoff_path_discovery_policy_missing', {token});
    }
  }
  const v2PatchPolicy = handoffPolicy.patch_integrity || {};
  const v2Algorithm = String(v2PatchPolicy.new_algorithm || '');
  if (
    !v2Algorithm.includes('exact stdout bytes') ||
    !v2Algorithm.includes('buildPatchBytes') ||
    !v2Algorithm.includes('canonical_environment') ||
    !v2Algorithm.includes('canonical_git_config') ||
    !v2Algorithm.includes('canonical_diff_options')
  ) {
    pushIssue(errors, 'git_handoff_v2_algorithm_under_specified', {});
  }
  if (v2PatchPolicy.canonical_null_device !== 'the platform null device returned by node:os.devNull') {
    pushIssue(errors, 'git_handoff_v2_null_device_policy_drift', {});
  }
  for (const [field, expected] of [
    ['canonical_environment', V2_CANONICAL_ENVIRONMENT],
    ['canonical_git_config', V2_CANONICAL_GIT_CONFIG],
    ['canonical_diff_options', V2_CANONICAL_DIFF_OPTIONS],
  ]) {
    if (JSON.stringify(v2PatchPolicy[field]) !== JSON.stringify(expected)) {
      pushIssue(errors, 'git_handoff_v2_canonicalization_drift', {field});
    }
  }
  const attributePolicy = String(v2PatchPolicy.attribute_policy || '');
  for (const token of ['GIT_ATTR_SOURCE', 'non-empty repository info/attributes', 'diff.<driver>.*', 'fails closed']) {
    if (!attributePolicy.includes(token)) {
      pushIssue(errors, 'git_handoff_v2_attribute_policy_missing', {token});
    }
  }
  const v2Golden = v2PatchPolicy.compatibility_golden || {};
  if (
    v2Golden.fixture !== 'the fixed text-plus-binary payload in scripts/test_validate_delivery_record.mjs' ||
    v2Golden.sha256 !== '4fa4d17ca8633b5313260f144fffaf7230b9c19adc5246e34e99685c25578fed' ||
    !String(v2Golden.requirement || '').includes('must reproduce this digest')
  ) {
    pushIssue(errors, 'git_handoff_v2_compatibility_golden_drift', {});
  }
  for (const field of ['scope.base_commit_sha', 'scope.patch_sha256']) {
    if (!(handoffPolicy.patch_integrity?.new_format_requires || []).includes(field)) {
      pushIssue(errors, 'git_handoff_v2_patch_field_missing', { field });
    }
  }
  if (!String(handoffPolicy.locator_policy?.pull_request || '').includes('/pull/<number>')) {
    pushIssue(errors, 'git_handoff_pull_locator_policy_missing', {});
  }
  if (!String(handoffPolicy.locator_policy?.parked_compare || '').includes('/compare/<base_branch>...<branch>')) {
    pushIssue(errors, 'git_handoff_compare_locator_policy_missing', {});
  }
  if (
    !String(handoffPolicy.locator_policy?.push_ref || '').includes('must equal origin/<branch>') ||
    !String(handoffPolicy.locator_policy?.push_ref || '').includes('exact PR event metadata') ||
    !String(handoffPolicy.locator_policy?.push_ref || '').includes('remote-tracking commit')
  ) {
    pushIssue(errors, 'git_handoff_push_ref_policy_missing', {});
  }
  for (const token of ['exact GitHub pull_request event binding', 'explicit head SHA', 'same-origin', 'fork records fail closed']) {
    if (!String(handoffPolicy.locator_policy?.pull_request || '').includes(token)) {
      pushIssue(errors, 'git_handoff_pull_event_policy_missing', {token});
    }
  }
  for (const token of ['event context must be absent', 'refs/remotes/origin/<branch>', 'explicit validated head']) {
    if (!String(handoffPolicy.locator_policy?.parked_compare || '').includes(token)) {
      pushIssue(errors, 'git_handoff_parked_ref_policy_missing', {token});
    }
  }
  for (const token of ['complete template field set', 'strict string', 'change_type enum', 'merge_authority-to-scope consistency', 'changes card_boxes_json', 'no-auto-merge authority']) {
    if (!String(handoffPolicy.locator_policy?.record_schema || '').includes(token)) {
      pushIssue(errors, 'git_handoff_record_schema_policy_missing', {token});
    }
  }
  if (handoffTemplate.scope?.patch_format !== 'git-diff-binary-v2') {
    pushIssue(errors, 'git_handoff_template_patch_format_drift', {});
  }
  for (const field of ['base_commit_sha', 'patch_sha256']) {
    if (!(field in (handoffTemplate.scope || {}))) {
      pushIssue(errors, 'git_handoff_template_patch_field_missing', { field });
    }
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
  const sampleGateTask = (evals.golden_tasks || []).find(task => task.id === 'GT-CARD-004');
  for (const expected of [
    'derives_changed_cards_from_merge_base_to_head_objects',
    'requires_exactly_one_changed_review_coverage_per_changed_card',
    'requires_all_quality_metadata_fields_except_independently_validated_artifact_review_status_to_match_current_card_corpus',
    'validates_self_review_only_changes_against_the_unique_HEAD_corpus_card',
    'treats_unprefixed_governed_review_paths_as_content_candidate_changes',
    'excludes_only_exact_repository_declared_review_template_paths',
    'accepts_strict_full_track_aggregate_as_changed_card_review_coverage_without_cards',
    'rejects_semantically_incomplete_standard_or_full_track_review_coverage',
    'requires_exactly_three_HEAD_matching_snapshots_per_declared_standard_sample_box',
    'classifies_historical_approval_as_archive_evidence_not_current_authorization',
    'requires_every_changed_approval_record_to_link_an_exact_current_scoped_audit_replay',
    'requires_current_approval_consumers_to_reject_templates_traversal_symlinks_incomplete_shapes_stale_audits_and_stale_linked_reviews',
    'requires_current_approval_consumers_to_regenerate_the_complete_current_audit_and_exactly_replay_both_scoped_reports',
    'requires_current_approval_consumers_to_reject_uncommitted_or_staged_approval_review_and_audit_evidence',
    'requires_current_approval_consumers_to_fail_closed_when_audit_replay_is_unavailable_or_the_caller_fingerprint_is_forged',
    'binds_current_audit_script_and_rule_spec_to_committed_authority_and_rechecks_one_fixed_authorization_snapshot',
    'rejects_residual_closure_coverage_for_newly_added_cards',
    'requires_structured_non_automation_human_identity_for_full_track_review',
    'rejects_nested_symlinked_or_unusual_path_self_review_evidence',
    'rejects_partial_or_wrong_track_full_track_aggregate_coverage',
    'rejects_full_track_aggregate_coverage_for_cards_absent_from_merge_base',
    'replays_scoped_audit_against_the_complete_immutable_HEAD_card_corpus',
    'rejects_noncanonical_card_box_paths',
    'requires_elimination_runtime_IDs_and_matching_preview_answer_projection',
  ]) {
    if (!(sampleGateTask?.expected || []).includes(expected)) {
      pushIssue(errors, 'sample_gate_integrity_eval_missing', { expected });
    }
  }
  if (evals.fixture_suite !== 'spec/eval-fixtures.json') {
    pushIssue(errors, 'eval_fixture_suite_missing', {});
  }

  const perturbation = readJson('spec/perturbation-audit.json');
  const guards = new Set((perturbation.anti_drift_guards || []).map(guard => guard.id));
  for (const id of ['PA-CARD-001', 'PA-CARD-002', 'PA-CARD-003', 'PA-CARD-004', 'PA-CARD-005', 'PA-CARD-006', 'PA-CARD-007', 'PA-CARD-008', 'PA-CARD-009', 'PA-CARD-010', 'PA-CARD-011', 'PA-CARD-012', 'PA-CARD-013']) {
    if (!guards.has(id)) {
      pushIssue(errors, 'anti_drift_guard_missing', { id });
    }
  }
  const currentApprovalGuard = (perturbation.anti_drift_guards || [])
    .find(guard => guard.id === 'PA-CARD-013');
  if (
    !String(currentApprovalGuard?.reject || '').includes('candidate-queue or release-gap consumers') ||
    !String(currentApprovalGuard?.reject || '').includes('historical approvals') ||
    !String(currentApprovalGuard?.reject || '').includes('dirty/staged/mode-drifted audit authority or approval/review/audit evidence') ||
    !String(currentApprovalGuard?.reject || '').includes('concurrent HEAD/index/file/corpus drift') ||
    !String(currentApprovalGuard?.reject || '').includes('forged current-digest audits') ||
    !String(currentApprovalGuard?.reject || '').includes('stale linked self-reviews') ||
    !String(currentApprovalGuard?.recovery || '').includes('current-authorization consumer') ||
    !String(currentApprovalGuard?.recovery || '').includes('direct canonical non-template approval and linked review evidence') ||
    !String(currentApprovalGuard?.recovery || '').includes('active audit script') ||
    !String(currentApprovalGuard?.recovery || '').includes('active audit rule spec') ||
    !String(currentApprovalGuard?.recovery || '').includes('one fixed HEAD modes and bytes agree') ||
    !String(currentApprovalGuard?.recovery || '').includes('regenerate the complete current card-quality audit') ||
    !String(currentApprovalGuard?.recovery || '').includes('exactly replay both scoped reports') ||
    !String(currentApprovalGuard?.recovery || '').includes('recheck the fixed HEAD/index snapshot')
  ) {
    pushIssue(errors, 'current_approval_perturbation_guard_incomplete', {});
  }
  const deliveryPerturbation = (perturbation.anti_drift_guards || [])
    .find(guard => guard.id === 'PA-CARD-011');
  const deliveryRecovery = String(deliveryPerturbation?.recovery || '');
  for (const token of [
    'exact handoff template path',
    'fatally and byte-preservingly decode Git path bytes as UTF-8',
    'leading U+FEFF',
    'direct safe non-executable 100644 JSON blob',
    'exact ls-tree plus cat-file object ID',
    'fixed OIDs',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_GRAFT_FILE',
    'symlinks',
    'Unicode-line-separator paths',
    'Git replace refs',
    'GIT_REPLACE_REF_BASE',
    'common-dir info/grafts',
    'linked worktrees',
    'legacy hashes',
    'missing v2 fields',
    '--ignore-submodules=none',
    '--no-ext-diff',
    'fixed PR-head tree',
    'mandatory git-diff-binary-v2',
    'deterministic environment/config/options',
    'commit-sourced attributes',
    'custom diff-driver config',
    'full reachable pre- and post-payload commit sets',
    'merged side histories',
    'add-delete',
    'modify-restore',
    'identical-tree merge',
    'exact pull-request event',
    'remote-tracking refs',
  ]) {
    if (!deliveryRecovery.includes(token)) {
      pushIssue(errors, 'delivery_perturbation_recovery_missing', {token});
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
  const auditRules = new Map((readJson('spec/card-quality-audit.json').rules || []).map(rule => [rule.id, rule]));
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
      validateApprovalRecord(testCase.approval_record || {}, gateErrors, `${testCase.id}.approval_record`, {
        fixture: true,
      });
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

    if (testCase.type === 'self_review_record') {
      if (testCase.golden_task_id !== 'GT-CARD-004') {
        pushIssue(errors, 'self_review_fixture_wrong_golden_task', { fixture: testCase.id });
      }
      if (expected.self_review_status !== 'block') {
        pushIssue(errors, 'self_review_fixture_not_blocking_bad_record', { fixture: testCase.id });
      }
      const gateErrors = [];
      validateSelfReviewRecord(testCase.self_review_record || {}, gateErrors, `${testCase.id}.self_review_record`, {
        fixture: true,
      });
      const actualGateCodes = new Set(gateErrors.map(issue => issue.code));
      for (const expectedGateError of expected.expected_gate_errors || []) {
        if (!actualGateCodes.has(expectedGateError)) {
          pushIssue(errors, 'self_review_fixture_expected_error_not_triggered', {
            fixture: testCase.id,
            expectedGateError,
            actualGateErrors: [...actualGateCodes],
          });
        }
      }
      for (const actualGateCode of actualGateCodes) {
        if (!(expected.expected_gate_errors || []).includes(actualGateCode)) {
          pushIssue(errors, 'self_review_fixture_unexpected_gate_error', {
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
    const expectedAuditRules = expected.expected_audit_rules || [];
    for (const ruleId of expectedAuditRules) {
      if (!auditRules.has(ruleId)) {
        pushIssue(errors, 'fixture_unknown_expected_audit_rule', { fixture: testCase.id, ruleId });
      }
    }
    const expectedHardBlockerRules = expected.expected_hard_blocker_rules || [];
    for (const ruleId of expectedHardBlockerRules) {
      const rule = auditRules.get(ruleId);
      if (!rule) {
        pushIssue(errors, 'fixture_unknown_expected_hard_blocker_rule', { fixture: testCase.id, ruleId });
      } else if (rule.severity !== 'hard_blocker') {
        pushIssue(errors, 'fixture_expected_rule_not_hard_blocker', {
          fixture: testCase.id,
          ruleId,
          severity: rule.severity,
        });
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

    if (testCase.golden_task_id === 'GT-CARD-005') {
      const card = cards[0] || {};
      const answerKey = card.answer_key?.correct_option;
      const options = card.front?.options || card.front_content?.options || [];
      const correctOption = options.find(option => option.key === answerKey);
      const frontPrompt = [
        card.front?.text,
        card.front?.prompt,
        card.front?.task_prompt,
        card.front?.task_schema?.action,
        card.front?.task_schema?.focus,
        card.front?.task_schema?.success_criteria,
        card.front_content?.text,
        card.front_content?.prompt,
        card.front_content?.task_prompt,
        card.front_content?.task_schema?.action,
        card.front_content?.task_schema?.focus,
        card.front_content?.task_schema?.success_criteria,
      ].filter(Boolean).join(' ');
      if (testCase.fixture_flags?.front_contains_correct_option_text !== true) {
        pushIssue(errors, 'front_answer_leak_fixture_missing_flag', { fixture: testCase.id });
      }
      if (!expectedAuditRules.includes('front_leaks_correct_answer')) {
        pushIssue(errors, 'front_answer_leak_fixture_missing_audit_rule', { fixture: testCase.id });
      }
      if (!expectedHardBlockerRules.includes('front_leaks_correct_answer')) {
        pushIssue(errors, 'front_answer_leak_fixture_missing_hard_blocker_rule', { fixture: testCase.id });
      }
      if (!correctOption?.text || !frontPrompt.includes(correctOption.text)) {
        pushIssue(errors, 'front_answer_leak_fixture_does_not_name_correct_option', {
          fixture: testCase.id,
          card_id: card.card_id,
        });
      }
    }

    if (testCase.golden_task_id === 'GT-CARD-006') {
      const audioRecord = testCase.audio_qc_record || {};
      const expectedGateErrors = expected.expected_gate_errors || [];
      if (testCase.fixture_flags?.existing_ai_tts_path_only !== true) {
        pushIssue(errors, 'formal_audio_fixture_missing_existing_path_flag', { fixture: testCase.id });
      }
      if (testCase.fixture_flags?.target_signal_unreviewed !== true) {
        pushIssue(errors, 'formal_audio_fixture_missing_target_signal_flag', { fixture: testCase.id });
      }
      if (audioRecord.verdict?.formal_audio_ready !== true) {
        pushIssue(errors, 'formal_audio_fixture_does_not_claim_ready', { fixture: testCase.id });
      }
      if (audioRecord.qa_checks?.target_signal_audible !== false) {
        pushIssue(errors, 'formal_audio_fixture_target_signal_not_failed', { fixture: testCase.id });
      }
      if (!expectedGateErrors.includes('target_signal_audible_required_for_formal_audio')) {
        pushIssue(errors, 'formal_audio_fixture_expected_gate_missing', { fixture: testCase.id });
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
validateAudioGenerationContract(errors);
validateCardQualityAudit(errors, warnings);
validateMetadataSchema(errors);
validateWorkflow(errors);
validateReviewDirs(errors);
validateReviewTemplatesAndRecords(errors, warnings);
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
