import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  isHumanReviewerIdentity,
  loadIntegrityPolicy,
  validateChangedCardSelfReviewParity,
  validateEliminationIntegrity,
  validateQualityMetadata,
} from './lib/card_integrity.mjs';

const DEFAULT_BASE = 'origin/fix/review-findings-card-contract';
const GLOBAL_REPORT_PATHS = new Set([
  'reports/card_quality_audit_report.json',
  'reports/card_validation_report.json',
]);
const PRE_CUTOVER_REPORT_INDEX = 'reports/pre-cutover-report-index.json';
const MULTI_PREFIX_CONTENT_CHANGE_TYPES = new Set([
  'content_candidate_front_answer_leak_queue',
  'content_candidate_residual_blocker_closure',
]);
const CONTENT_NO_AUTO_MERGE_AUTHORITY = 'no_auto_merge_content_candidate_user_confirmation_required';
const REVIEW_TEMPLATE_PATHS = new Set([
  'reviews/approved_batches/FULL_TRACK_TEMPLATE.json',
  'reviews/approved_batches/TEMPLATE.json',
  'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
  'reviews/agent_self_review/TEMPLATE.json',
  'reviews/sample_confirmations/TEMPLATE.json',
  'reviews/controlled_pilot_reviews/TEMPLATE.json',
  'reviews/controlled_pilot_approvals/TEMPLATE.json',
]);
const CARD_INTEGRITY_ISSUE_CODES = Object.freeze({
  qualityMetadataMissing: 'candidate_quality_metadata_missing',
  selfReviewMissing: 'candidate_self_review_missing',
  selfReviewMetadataMismatch: 'candidate_self_review_metadata_mismatch',
});
const CARD_INTEGRITY_SCOPE_CODE_BY_LIBRARY_CODE = new Map([
  [CARD_INTEGRITY_ISSUE_CODES.qualityMetadataMissing, 'changed_card_quality_metadata_invalid'],
  [CARD_INTEGRITY_ISSUE_CODES.selfReviewMissing, 'changed_card_self_review_count_invalid'],
  [CARD_INTEGRITY_ISSUE_CODES.selfReviewMetadataMismatch, 'changed_card_self_review_metadata_mismatch'],
]);
const CURRENT_AUDIT_OVERLAY_PATHS = [
  'scripts/audit_card_quality.mjs',
  'spec/card-quality-audit.json',
];
const POINTER_ONLY_GIT_ENV = Object.freeze({
  GIT_LFS_SKIP_SMUDGE: '1',
});
const FULL_TRACK_READY_STATUS = 'ready_for_full_track_user_approval';
const CONTROLLED_PILOT_REVIEW_SCHEMA = 'controlled-pilot-review.v1';
const CONTROLLED_PILOT_APPROVAL_SCHEMA = 'controlled-pilot-approval.v1';
const SHA256_VALUE_RE = /^sha256:[a-f0-9]{64}$/;
const TIMEZONE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const QUALITY_AUDIT_SEVERITIES = ['hard_blocker', 'content_risk', 'review_gap', 'source_risk'];
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
const STANDARD_SELF_REVIEW_BATCH_STATUSES = [
  'recommend_user_confirmation',
  'revise_before_user_review',
  'blocked',
];
const RESIDUAL_BLOCKER_CLOSURE_STATUS = 'documented_residual_closure';
const CONFIRMED_BOX_EXPANSION_STATUS = 'reviewed_confirmed_box_expansion';
const CORE_INTERACTION_IDS = ['flip', 'multiple_choice', 'lock', 'elimination', 'swipe'];
const SELF_REVIEW_CARD_STATUSES = ['pass', 'revise', 'block'];
const ANALYSIS_REFERENCE_CHECK_FIELDS = [
  'answer_matches_card',
  'choice_or_bank_references_match_source',
  'distractor_labels_match_explanations',
];

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env
      ? {...process.env, ...options.env}
      : process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(' ')} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

function runGit(args, options = {}) {
  return runCommand('git', args, options);
}

function addDetachedPointerWorktree(worktreePath, commit) {
  runGit(
    ['worktree', 'add', '--detach', worktreePath, commit],
    {env: POINTER_ONLY_GIT_ENV},
  );
}

function resolveCommit(ref) {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function changedEntries(base, head) {
  const range = head ? `${base}...${head}` : base;
  const output = runGit(['diff', '--name-status', '-z', '--find-renames', range, '--']);
  const fields = output.split('\0').filter((field, index, all) =>
    field.length > 0 || index < all.length - 1
  );
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields
      .slice(index, index + pathCount);
    index += pathCount;
    if (paths.length !== pathCount) {
      throw new Error(`unable to parse NUL-delimited git diff entry for status ${status}`);
    }
    entries.push({
      status,
      paths,
      path: paths[paths.length - 1] || '',
    });
  }
  if (!head) {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean)
      .map(filePath => ({
        status: '??',
        paths: [filePath],
        path: filePath,
      }));
    entries.push(...untracked);
  }
  return entries;
}

function pathPrefix(filePath) {
  const basename = path.posix.basename(filePath);
  const match = basename.match(/(?:^|[-_])(\d{4})(?:[-_.]|$)/);
  return match ? match[1] : null;
}

function isCardBoxPath(filePath) {
  return /^card_boxes_json\/card_boxes_seed_(?:cet4|cet6)_[a-z0-9_]+_\d{4}\.json$/.test(filePath);
}

function isCardBoxDirectoryPath(filePath) {
  return filePath.startsWith('card_boxes_json/');
}

function isReviewTemplatePath(filePath) {
  return REVIEW_TEMPLATE_PATHS.has(filePath);
}

function isJsonBelow(filePath, directory) {
  if (typeof filePath !== 'string') return false;
  const prefix = `${directory}/`;
  return filePath.startsWith(prefix) &&
    filePath.length > prefix.length + '.json'.length &&
    filePath.endsWith('.json');
}

function isDraftPath(filePath) {
  return isJsonBelow(filePath, 'reviews/drafts') &&
    !isReviewTemplatePath(filePath);
}

function isSelfReviewJsonPath(filePath) {
  return isJsonBelow(filePath, 'reviews/agent_self_review') &&
    !isReviewTemplatePath(filePath);
}

function isSelfReviewPath(filePath) {
  if (!isSelfReviewJsonPath(filePath)) return false;
  const relativePath = filePath.slice('reviews/agent_self_review/'.length);
  return !relativePath.includes('/');
}

function isNoncanonicalSelfReviewPath(filePath) {
  return isSelfReviewJsonPath(filePath) && !isSelfReviewPath(filePath);
}

function isApprovedBatchJsonPath(filePath) {
  return isJsonBelow(filePath, 'reviews/approved_batches') &&
    !isReviewTemplatePath(filePath);
}

function isApprovedBatchPath(filePath) {
  if (!isApprovedBatchJsonPath(filePath)) return false;
  const relativePath = filePath.slice('reviews/approved_batches/'.length);
  return !relativePath.includes('/');
}

function isNoncanonicalApprovedBatchPath(filePath) {
  return isApprovedBatchJsonPath(filePath) && !isApprovedBatchPath(filePath);
}

function isSampleConfirmationJsonPath(filePath) {
  return isJsonBelow(filePath, 'reviews/sample_confirmations') &&
    !isReviewTemplatePath(filePath);
}

function isSampleConfirmationPath(filePath) {
  if (!isSampleConfirmationJsonPath(filePath)) return false;
  return !filePath.slice('reviews/sample_confirmations/'.length).includes('/');
}

function isNoncanonicalSampleConfirmationPath(filePath) {
  return isSampleConfirmationJsonPath(filePath) && !isSampleConfirmationPath(filePath);
}

function isControlledPilotReviewJsonPath(filePath) {
  return isJsonBelow(filePath, 'reviews/controlled_pilot_reviews') &&
    !isReviewTemplatePath(filePath);
}

function isControlledPilotReviewPath(filePath) {
  if (!isControlledPilotReviewJsonPath(filePath)) return false;
  return !filePath.slice('reviews/controlled_pilot_reviews/'.length).includes('/');
}

function isNoncanonicalControlledPilotReviewPath(filePath) {
  return isControlledPilotReviewJsonPath(filePath) && !isControlledPilotReviewPath(filePath);
}

function isControlledPilotApprovalJsonPath(filePath) {
  return isJsonBelow(filePath, 'reviews/controlled_pilot_approvals') &&
    !isReviewTemplatePath(filePath);
}

function isControlledPilotApprovalPath(filePath) {
  if (!isControlledPilotApprovalJsonPath(filePath)) return false;
  return !filePath.slice('reviews/controlled_pilot_approvals/'.length).includes('/');
}

function isNoncanonicalControlledPilotApprovalPath(filePath) {
  return isControlledPilotApprovalJsonPath(filePath) && !isControlledPilotApprovalPath(filePath);
}

function isHandoffPath(filePath) {
  return isJsonBelow(filePath, 'reviews/git_handoffs') &&
    !filePath.endsWith('/TEMPLATE.json');
}

function isScopedAuditPath(filePath) {
  return isJsonBelow(filePath, 'reviews/audit_scopes') &&
    !isReviewTemplatePath(filePath);
}

function isContentReviewPath(filePath) {
  if (
    isDraftPath(filePath) ||
    isSelfReviewJsonPath(filePath) ||
    isApprovedBatchJsonPath(filePath) ||
    isSampleConfirmationJsonPath(filePath) ||
    isControlledPilotReviewJsonPath(filePath) ||
    isControlledPilotApprovalJsonPath(filePath) ||
    isScopedAuditPath(filePath)
  ) {
    return true;
  }
  return Boolean(pathPrefix(filePath)) && isHandoffPath(filePath);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isQualityAuditReportPath(value) {
  if (value === 'reports/card_quality_audit_report.json') return true;
  return isScopedQualityAuditReportPath(value);
}

function isScopedQualityAuditReportPath(value) {
  if (typeof value !== 'string' || !isJsonBelow(value, 'reviews/audit_scopes')) return false;
  return !value.slice('reviews/audit_scopes/'.length).includes('/');
}

function hasUnsafeGitPathCharacters(filePath) {
  return filePath.includes('\\') || /[\u0001-\u001f\u007f\u2028\u2029]/.test(filePath);
}

function isRegularFileAtCommit(commit, filePath) {
  if (!commit) return true;
  const output = runGit([
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    commit,
    '--',
    filePath,
  ]);
  const metadata = output.split('\t', 1)[0] || '';
  const [mode, type] = metadata.split(' ');
  return type === 'blob' && (mode === '100644' || mode === '100755');
}

function readChangedJson(filePath, head) {
  let text = null;
  try {
    text = head ? runGit(['show', `${head}:${filePath}`]) : fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return safeJsonParse(text);
}

function scopedCardIdsFromRecord(record = {}) {
  const ids = new Set();
  for (const id of record.scope?.card_ids || []) {
    if (typeof id === 'string') ids.add(id);
  }
  for (const id of record.card_ids || []) {
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function changedScopeCardIds(entries, head) {
  const ids = new Set();
  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;

    for (const filePath of entry.paths) {
      if (!isScopedAuditPath(filePath) && !isSelfReviewPath(filePath) && !isHandoffPath(filePath) && !isDraftPath(filePath)) continue;
      const record = readChangedJson(filePath, head);
      if (!record) continue;
      for (const id of scopedCardIdsFromRecord(record)) ids.add(id);
    }
  }
  return [...ids].sort();
}

function changedCardBoxPaths(entries) {
  const paths = new Set();
  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;
    if (isCardBoxPath(entry.path)) paths.add(entry.path);
  }
  return [...paths].sort();
}

function hasCardBoxDiff(entries) {
  return entries.some(entry => entry.paths.some(isCardBoxDirectoryPath));
}

function cardBoxPathsAtCommit(commit) {
  return runGit(['ls-tree', '-r', '-z', '--name-only', commit, '--', 'card_boxes_json'])
    .split('\0')
    .filter(isCardBoxPath)
    .sort();
}

function cardCorpusAtCommit(commit) {
  const cardsById = new Map();
  const issues = [];

  for (const filePath of cardBoxPathsAtCommit(commit)) {
    const box = safeJsonParse(runGit(['show', `${commit}:${filePath}`]));
    if (!box || !Array.isArray(box.cards)) {
      issues.push({
        code: 'changed_card_corpus_box_unreadable',
        path: filePath,
        message: 'Card box files must be readable JSON objects with a cards array before changed-card integrity can be proven.',
      });
      continue;
    }

    for (let index = 0; index < box.cards.length; index += 1) {
      const card = box.cards[index];
      const cardId = typeof card?.card_id === 'string' ? card.card_id : null;
      if (!cardId) {
        issues.push({
          code: 'changed_card_corpus_card_id_missing',
          path: filePath,
          card_index: index,
          message: 'Every corpus card needs a string card_id so changes can be identified independently of declared review scope.',
        });
        continue;
      }

      const occurrences = cardsById.get(cardId) || [];
      occurrences.push({ card, path: filePath, card_index: index });
      cardsById.set(cardId, occurrences);
    }
  }

  return { cardsById, issues };
}

function trackScopeFromCorpus(corpus, track) {
  const cardIds = new Set();
  const boxPrefixes = new Set();
  const cardsMissingBoxPrefix = [];
  const ambiguousCardIds = [];

  for (const [cardId, occurrences] of corpus.cardsById) {
    if (occurrences.length !== 1) {
      if (occurrences.some(occurrence => occurrence.card?.track === track)) {
        ambiguousCardIds.push(cardId);
      }
      continue;
    }
    const card = occurrences[0].card;
    if (card?.track !== track) continue;
    cardIds.add(cardId);
    const boxPrefix = card?.knowledge_ref?.box_prefix;
    if (typeof boxPrefix === 'string' && boxPrefix.length > 0) {
      boxPrefixes.add(boxPrefix);
    } else {
      cardsMissingBoxPrefix.push(cardId);
    }
  }

  return {cardIds, boxPrefixes, cardsMissingBoxPrefix, ambiguousCardIds};
}

function changedSelfReviewPaths(entries) {
  const paths = new Set();
  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;
    if (isSelfReviewPath(entry.path)) paths.add(entry.path);
  }
  return [...paths].sort();
}

function appendLibraryIssues(target, libraryIssues, context) {
  for (const issue of libraryIssues || []) {
    const scopeCode = CARD_INTEGRITY_SCOPE_CODE_BY_LIBRARY_CODE.get(issue.code) || context.code;
    target.push({
      ...issue,
      ...context,
      library_code: issue.code || null,
      integrity_path: issue.path || null,
      code: scopeCode,
      message: issue.message || context.message,
    });
  }
}

function validateFullTrackAggregateSemantics({
  record,
  filePath,
  scopeCardIds,
  scopeBoxPrefixes,
}) {
  const issues = [];
  const push = (code, message, details = {}) => {
    issues.push({code, path: filePath, message, ...details});
  };
  const samplePolicy = record.sample_policy;
  const requiredSampleFlags = [
    ['is_three_card_sample_per_box', false],
    ['full_track_remediation', true],
    ['batch_generation_requires_user_confirmation', true],
    ['final_user_approval_required', true],
  ];
  for (const [field, expected] of requiredSampleFlags) {
    if (samplePolicy?.[field] !== expected) {
      push(
        'changed_full_track_review_sample_policy_invalid',
        `A changed full-track aggregate must set sample_policy.${field}=${expected}.`,
        {field, expected, actual: samplePolicy?.[field] ?? null},
      );
    }
  }

  if (
    !Array.isArray(record.specs_read) ||
    record.specs_read.length === 0 ||
    !record.specs_read.every(hasText)
  ) {
    push(
      'changed_full_track_review_specs_read_invalid',
      'A changed full-track aggregate must name the governing specs it read.',
    );
  }

  const aggregateReviewer = record.coverage?.human_reviewer;
  if (!isHumanReviewerIdentity(aggregateReviewer)) {
    push(
      'changed_full_track_review_human_reviewer_invalid',
      'A changed full-track aggregate must identify a named human reviewer as github:<id>, team:<id>, or external:<id>; agent, bot, Codex, automation, and CI identities are forbidden.',
      {human_reviewer: aggregateReviewer ?? null},
    );
  }
  for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
    if (record.coverage?.analysis_reference_check?.[field] !== true) {
      push(
        'changed_full_track_review_analysis_reference_check_invalid',
        'A changed full-track review must explicitly confirm answer truth, option or word-bank references, and distractor labels against the reviewed source.',
        {
          field,
          actual: record.coverage?.analysis_reference_check?.[field] ?? null,
        },
      );
    }
  }

  const boxes = Array.isArray(record.coverage?.boxes) ? record.coverage.boxes : [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (
      box?.status !== 'pass' ||
      !isHumanReviewerIdentity(box?.reviewer) ||
      box.reviewer !== aggregateReviewer
    ) {
      push(
        'changed_full_track_review_box_human_pass_invalid',
        'Every covered box must be marked pass by the same named human reviewer declared for the aggregate.',
        {
          box_index: index,
          box_prefix: box?.box_prefix ?? null,
          status: box?.status ?? null,
          reviewer: box?.reviewer ?? null,
          expected_reviewer: aggregateReviewer ?? null,
        },
      );
    }
  }

  const qualityAudit = record.quality_audit;
  if (!qualityAudit || typeof qualityAudit !== 'object' || Array.isArray(qualityAudit)) {
    push(
      'changed_full_track_review_quality_audit_invalid',
      'A changed full-track aggregate must carry a structured quality_audit record.',
    );
  } else {
    if (!isScopedQualityAuditReportPath(qualityAudit.report)) {
      push(
        'changed_full_track_review_scoped_audit_required',
        'A changed full-track aggregate must link one direct current scoped audit report under reviews/audit_scopes; archived global reports are immutable legacy evidence only.',
        {report: qualityAudit.report ?? null},
      );
    }
    if (!hasText(qualityAudit.corpus_fingerprint)) {
      push(
        'changed_full_track_review_quality_audit_fingerprint_invalid',
        'quality_audit.corpus_fingerprint must be non-empty.',
      );
    }
    if (qualityAudit.scope_has_no_hard_blockers !== true) {
      push(
        'changed_full_track_review_quality_audit_not_clear',
        'quality_audit.scope_has_no_hard_blockers must be true before full-track coverage can authorize a changed card.',
        {actual: qualityAudit.scope_has_no_hard_blockers ?? null},
      );
    }

    const summary = qualityAudit.scope_summary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      push(
        'changed_full_track_review_quality_audit_summary_invalid',
        'quality_audit.scope_summary must be a structured complete-track summary.',
      );
    } else {
      const summaryCardIds = Array.isArray(summary.card_ids) ? summary.card_ids : [];
      const validSummaryCardIds = summaryCardIds.every(hasText);
      const uniqueSummaryCardIds = new Set(summaryCardIds);
      if (
        summaryCardIds.length !== scopeCardIds.size ||
        !validSummaryCardIds ||
        uniqueSummaryCardIds.size !== summaryCardIds.length ||
        !setsEqual(uniqueSummaryCardIds, scopeCardIds)
      ) {
        push(
          'changed_full_track_review_quality_audit_scope_mismatch',
          'quality_audit.scope_summary.card_ids must exactly equal the unique full-track scope.card_ids.',
          {
            expected_card_ids: [...scopeCardIds].sort(),
            actual_card_ids: summaryCardIds,
          },
        );
      }
      if (summary.card_count !== scopeCardIds.size) {
        push(
          'changed_full_track_review_quality_audit_count_mismatch',
          'quality_audit.scope_summary.card_count must equal the unique full-track scope size.',
          {expected: scopeCardIds.size, actual: summary.card_count ?? null},
        );
      }
      if (!isNonNegativeInteger(summary.issue_count)) {
        push(
          'changed_full_track_review_quality_audit_issue_count_invalid',
          'quality_audit.scope_summary.issue_count must be a non-negative integer.',
          {actual: summary.issue_count ?? null},
        );
      }

      let severityTotal = 0;
      for (const severity of QUALITY_AUDIT_SEVERITIES) {
        const count = summary.by_severity?.[severity];
        if (!isNonNegativeInteger(count)) {
          push(
            'changed_full_track_review_quality_audit_severity_invalid',
            'Every required quality_audit severity count must be a non-negative integer.',
            {severity, actual: count ?? null},
          );
        } else {
          severityTotal += count;
        }
      }
      if (summary.by_severity?.hard_blocker !== 0) {
        push(
          'changed_full_track_review_quality_audit_has_hard_blockers',
          'The full-track quality_audit summary must contain zero hard blockers.',
          {actual: summary.by_severity?.hard_blocker ?? null},
        );
      }
      if (isNonNegativeInteger(summary.issue_count) && severityTotal !== summary.issue_count) {
        push(
          'changed_full_track_review_quality_audit_severity_total_mismatch',
          'quality_audit.scope_summary.issue_count must equal the sum of required severity counts.',
          {expected: severityTotal, actual: summary.issue_count},
        );
      }
      for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
        const count = summary.by_rule?.[ruleId];
        if (!isNonNegativeInteger(count)) {
          push(
            'changed_full_track_review_quality_audit_rule_invalid',
            'Every governed quality_audit rule count must be a non-negative integer.',
            {rule_id: ruleId, actual: count ?? null},
          );
        }
      }
    }
  }

  if (record.batch_review?.status !== FULL_TRACK_READY_STATUS) {
    push(
      'changed_full_track_review_batch_status_invalid',
      `A changed full-track aggregate batch_review.status must be ${FULL_TRACK_READY_STATUS}.`,
      {actual: record.batch_review?.status ?? null},
    );
  }
  if (
    !Array.isArray(record.batch_review?.remaining_risks) ||
    record.batch_review.remaining_risks.length !== 0
  ) {
    push(
      'changed_full_track_review_remaining_risks_invalid',
      'A full-track aggregate ready for user approval must declare an empty batch_review.remaining_risks array.',
    );
  }
  if (!hasText(record.batch_review?.summary) || !hasText(record.batch_review?.next_step)) {
    push(
      'changed_full_track_review_batch_evidence_incomplete',
      'A changed full-track aggregate must include non-empty batch_review.summary and batch_review.next_step.',
    );
  }
  if (
    !Array.isArray(record.representative_cards) ||
    record.representative_cards.length === 0 ||
    !record.representative_cards.every(hasText) ||
    new Set(record.representative_cards).size !== record.representative_cards.length ||
    record.representative_cards.some(cardId => !scopeCardIds.has(cardId))
  ) {
    push(
      'changed_full_track_review_representative_cards_invalid',
      'representative_cards must be a non-empty unique array containing only card IDs from the declared full-track scope.',
    );
  }

  if (boxes.length !== scopeBoxPrefixes.size) {
    push(
      'changed_full_track_review_box_count_mismatch',
      'coverage.boxes must contain exactly one entry for every unique scope.box_prefixes value.',
      {expected: scopeBoxPrefixes.size, actual: boxes.length},
    );
  }

  return issues;
}

function changedSelfReviewScopeType(record) {
  if (hasText(record.sample_policy?.review_scope_type)) {
    return record.sample_policy.review_scope_type;
  }
  if (record.sample_policy?.residual_blocker_closure === true) {
    return 'residual_blocker_closure';
  }
  return 'three_card_sample_per_box';
}

function validateSampleConfirmationSemantics(record, filePath) {
  const issues = [];
  const push = (code, message, details = {}) => issues.push({code, path: filePath, message, ...details});
  if (record?.schema_version !== 'sample-confirmation.v1' || record?.confirmed_by_user !== true) {
    push('changed_sample_confirmation_authority_invalid', 'A sample-confirmation record must use sample-confirmation.v1 and record explicit user confirmation.');
  }
  if (!hasText(record?.confirmation_id) || !hasText(record?.confirmation_source?.conversation_id) || !hasText(record?.confirmation_source?.message) || !hasText(record?.confirmation_source?.context)) {
    push('changed_sample_confirmation_source_invalid', 'A sample-confirmation record must bind a confirmation ID and non-empty conversation, message, and context evidence.');
  }
  if (!hasText(record?.recorded_at) || Number.isNaN(Date.parse(record.recorded_at)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(record.recorded_at)) {
    push('changed_sample_confirmation_timestamp_invalid', 'A sample-confirmation record requires a timezone-qualified timestamp.');
  }
  if (!['cet4', 'cet6'].includes(record?.scope?.track) || !hasText(record?.scope?.purpose) || !Number.isInteger(record?.scope?.target_card_count) || record.scope.target_card_count <= 0) {
    push('changed_sample_confirmation_scope_invalid', 'A sample-confirmation record must name a governed track, purpose, and positive target count.');
  }
  const boxTargets = Array.isArray(record?.scope?.box_targets) ? record.scope.box_targets : [];
  const prefixes = boxTargets.map(target => target?.box_prefix);
  const prefixSet = new Set(prefixes);
  let sampleCount = 0;
  let targetCount = 0;
  const allSampleIds = [];
  if (boxTargets.length === 0 || prefixSet.size !== boxTargets.length) {
    push('changed_sample_confirmation_box_targets_invalid', 'Box targets must be non-empty and use unique prefixes.');
  }
  for (const target of boxTargets) {
    const ids = Array.isArray(target?.sample_card_ids) ? target.sample_card_ids : [];
    if (!/^\d{4}$/.test(target?.box_prefix || '') || !Number.isInteger(target?.target_card_count) || target.target_card_count < 3 || ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !hasText(id) || !id.startsWith(target.box_prefix))) {
      push('changed_sample_confirmation_box_target_invalid', 'Each box target must bind one four-digit prefix, exactly three unique matching sample IDs, and a target of at least three.', {box_prefix: target?.box_prefix ?? null});
    }
    sampleCount += ids.length;
    targetCount += Number.isInteger(target?.target_card_count) ? target.target_card_count : 0;
    allSampleIds.push(...ids);
  }
  if (new Set(allSampleIds).size !== allSampleIds.length || targetCount !== record?.scope?.target_card_count) {
    push('changed_sample_confirmation_totals_invalid', 'Sample IDs must be globally unique and per-box targets must sum to the overall target.');
  }
  if (record?.sample_evidence?.sample_card_count !== sampleCount || record?.sample_evidence?.box_count !== boxTargets.length || !/^sha256:[a-f0-9]{64}$/.test(record?.sample_evidence?.review_pack_sha256 || '')) {
    push('changed_sample_confirmation_evidence_invalid', 'Sample evidence counts and SHA-256 must exactly match the recorded box targets.');
  }
  const branchHeads = Array.isArray(record?.sample_evidence?.branch_heads) ? record.sample_evidence.branch_heads : [];
  if (branchHeads.length !== boxTargets.length || new Set(branchHeads.map(item => item?.box_prefix)).size !== boxTargets.length || branchHeads.some(item => !prefixSet.has(item?.box_prefix) || !hasText(item?.branch) || !/^[a-f0-9]{7,40}$/.test(item?.commit_sha || ''))) {
    push('changed_sample_confirmation_branch_heads_invalid', 'Sample evidence must bind one valid branch head for every confirmed box.');
  }
  const limits = Array.isArray(record?.does_not_authorize) ? record.does_not_authorize : [];
  if (record?.authorizes?.confirmed_box_expansion !== true || record?.authorizes?.same_quality_contract !== true || record?.final_user_approval_required !== true || record?.gate_eligible !== false || !['formal_content_approval', 'audio_perceptual_qc', 'pilot_release', 'destructive_card_changes'].every(limit => limits.includes(limit))) {
    push('changed_sample_confirmation_formal_boundary_invalid', 'Sample confirmation may authorize target-bound expansion only and must preserve every formal-use, audio, release, and destructive-change boundary.');
  }
  return issues;
}

function confirmedBoxTargetAtHead(record, filePath, head, issues) {
  const confirmationPath = record.sample_policy?.sample_confirmation_record;
  if (!isSampleConfirmationPath(confirmationPath) || !isRegularFileAtCommit(head, confirmationPath)) {
    issues.push({code: 'changed_confirmed_expansion_confirmation_missing', path: filePath, confirmation_path: confirmationPath ?? null, message: 'Confirmed expansion must link one direct regular non-template sample-confirmation record at immutable HEAD.'});
    return null;
  }
  const confirmation = readChangedJson(confirmationPath, head);
  const confirmationIssues = validateSampleConfirmationSemantics(confirmation, confirmationPath);
  if (confirmationIssues.length > 0) {
    issues.push({code: 'changed_confirmed_expansion_confirmation_invalid', path: filePath, confirmation_path: confirmationPath, validation_issues: confirmationIssues, message: 'The linked sample-confirmation record is invalid.'});
    return null;
  }
  if (confirmation.confirmation_id !== record.sample_policy?.sample_confirmation_id) {
    issues.push({code: 'changed_confirmed_expansion_confirmation_id_mismatch', path: filePath, message: 'The linked sample-confirmation ID must match sample_policy.sample_confirmation_id.'});
  }
  const prefixes = Array.isArray(record.scope?.box_prefixes) ? record.scope.box_prefixes : [];
  return confirmation.scope.box_targets.find(target => target.box_prefix === prefixes[0]) || null;
}

function validateStandardReviewSemantics({
  record,
  filePath,
  scopeCardIds,
  head,
}) {
  const issues = [];
  const push = (code, message, details = {}) => {
    issues.push({code, path: filePath, message, ...details});
  };
  const samplePolicy = record.sample_policy;
  const reviewScopeType = changedSelfReviewScopeType(record);
  const isResidualClosure = reviewScopeType === 'residual_blocker_closure';
  const isConfirmedExpansion = reviewScopeType === 'confirmed_box_expansion';
  if (!hasText(samplePolicy?.review_scope_type)) {
    push(
      'changed_self_review_scope_type_required',
      'Every changed self-review must explicitly declare sample_policy.review_scope_type before it can count as candidate coverage.',
    );
  }
  if (!['three_card_sample_per_box', 'confirmed_box_expansion', 'residual_blocker_closure'].includes(reviewScopeType)) {
    push(
      'changed_self_review_scope_type_invalid',
      'A changed non-full-track self-review must use the standard sample or residual blocker closure scope type.',
      {actual: reviewScopeType},
    );
  }
  if (isConfirmedExpansion) {
    for (const [field, expected] of [
      ['is_three_card_sample_per_box', false],
      ['confirmed_box_expansion', true],
      ['sample_confirmation_satisfied', true],
      ['final_user_approval_required', true],
      ['batch_generation_requires_user_confirmation', true],
    ]) {
      if (samplePolicy?.[field] !== expected) {
        push('changed_confirmed_expansion_sample_policy_invalid', `Confirmed expansion must set sample_policy.${field}=${expected}.`, {field, expected});
      }
    }
    const prefixes = Array.isArray(record.scope?.box_prefixes) ? record.scope.box_prefixes : [];
    if (prefixes.length !== 1 || !/^\d{4}$/.test(prefixes[0] || '')) {
      push('changed_confirmed_expansion_single_box_required', 'Confirmed expansion must cover exactly one four-digit box prefix.');
    }
    const target = confirmedBoxTargetAtHead(record, filePath, head, issues);
    const cards = Array.isArray(record.cards) ? record.cards : [];
    if (cards.some(card => card?.knowledge_ref?.box_prefix !== prefixes[0])) {
      push('changed_confirmed_expansion_card_prefix_mismatch', 'Every confirmed expansion snapshot must belong to the single confirmed box prefix.');
    }
    if (target) {
      const expected = target.target_card_count - target.sample_card_ids.length;
      if (cards.length !== expected || scopeCardIds.size !== expected) {
        push('changed_confirmed_expansion_count_mismatch', 'Confirmed expansion must contain exactly target minus the three confirmed sample cards.', {expected, actual: cards.length});
      }
      if ([...scopeCardIds].some(cardId => target.sample_card_ids.includes(cardId))) {
        push('changed_confirmed_expansion_reuses_sample_card', 'Expansion coverage must contain only new expansion cards, not the three confirmed sample cards.');
      }
    }
    if (record.batch_review?.status !== CONFIRMED_BOX_EXPANSION_STATUS) {
      push('changed_self_review_batch_status_invalid', `Confirmed expansion status must be ${CONFIRMED_BOX_EXPANSION_STATUS}.`);
    }
    if (!isScopedQualityAuditReportPath(record.quality_audit?.report)) {
      push('changed_confirmed_expansion_scoped_audit_required', 'Confirmed expansion must link one direct current scoped audit report.');
    }
    if (!hasText(record.batch_review?.box_progression) || !Array.isArray(record.batch_review?.repetition_or_gap_risks) || !hasText(record.batch_review?.next_step)) {
      push('changed_confirmed_expansion_batch_conclusion_invalid', 'Confirmed expansion must record progression, repetition/gap risks, and the next step.');
    }
    const representativeCards = Array.isArray(record.batch_review?.representative_cards) ? record.batch_review.representative_cards : [];
    if (representativeCards.length === 0 || new Set(representativeCards).size !== representativeCards.length || representativeCards.some(cardId => !scopeCardIds.has(cardId))) {
      push('changed_confirmed_expansion_representative_cards_invalid', 'Confirmed expansion must name non-empty unique representative cards within scope.');
    }
  } else if (isResidualClosure) {
    for (const [field, expected] of [
      ['is_three_card_sample_per_box', false],
      ['residual_blocker_closure', true],
      ['not_sample_approval', true],
    ]) {
      if (samplePolicy?.[field] !== expected) {
        push(
          'changed_self_review_sample_policy_invalid',
          `Residual closure evidence must set sample_policy.${field}=${expected}.`,
          {field, expected, actual: samplePolicy?.[field] ?? null},
        );
      }
    }
    if (
      !hasText(record.scope?.closure_reason) ||
      !Array.isArray(record.scope?.source_issue_refs) ||
      record.scope.source_issue_refs.length === 0 ||
      !record.scope.source_issue_refs.every(hasText)
    ) {
      push(
        'changed_self_review_residual_scope_invalid',
        'Residual closure evidence must name a closure reason and non-empty source issue references.',
      );
    }
    if (!isScopedQualityAuditReportPath(record.quality_audit?.report)) {
      push(
        'changed_self_review_residual_scoped_audit_required',
        'Residual blocker closure evidence must link one direct scoped audit report under reviews/audit_scopes.',
        {report: record.quality_audit?.report ?? null},
      );
    }
    if (record.batch_review?.status !== RESIDUAL_BLOCKER_CLOSURE_STATUS) {
      push(
        'changed_self_review_batch_status_invalid',
        `Residual closure evidence batch_review.status must be ${RESIDUAL_BLOCKER_CLOSURE_STATUS}.`,
        {actual: record.batch_review?.status ?? null},
      );
    }
  } else {
    if (samplePolicy?.is_three_card_sample_per_box !== true) {
      push(
        'changed_self_review_sample_policy_invalid',
        'A standard changed self-review must set sample_policy.is_three_card_sample_per_box=true.',
      );
    }
    for (const field of ['library', 'group', 'box']) {
      if (!hasText(record.scope?.[field])) {
        push(
          'changed_self_review_scope_field_missing',
          `A standard changed self-review must declare scope.${field}.`,
          {field},
        );
      }
    }
    if (!STANDARD_SELF_REVIEW_BATCH_STATUSES.includes(record.batch_review?.status)) {
      push(
        'changed_self_review_batch_status_invalid',
        'A standard changed self-review must use a governed batch_review.status.',
        {actual: record.batch_review?.status ?? null},
      );
    }
    if (!isScopedQualityAuditReportPath(record.quality_audit?.report)) {
      push(
        'changed_self_review_standard_scoped_audit_required',
        'A changed standard sample must link one direct current scoped audit report under reviews/audit_scopes; archived global reports are immutable legacy evidence only.',
        {report: record.quality_audit?.report ?? null},
      );
    }
    if (!hasText(record.batch_review?.box_progression)) {
      push(
        'changed_self_review_batch_box_progression_missing',
        'A changed standard sample must explain the batch box progression before its snapshots can count as coverage.',
      );
    }
    if (!Array.isArray(record.batch_review?.repetition_or_gap_risks)) {
      push(
        'changed_self_review_batch_risks_invalid',
        'A changed standard sample must carry a repetition_or_gap_risks array, including an empty array when no risks remain.',
      );
    }
    const representativeCards = Array.isArray(record.batch_review?.representative_cards)
      ? record.batch_review.representative_cards
      : [];
    if (
      representativeCards.length === 0 ||
      !representativeCards.every(hasText) ||
      new Set(representativeCards).size !== representativeCards.length ||
      !representativeCards.every(cardId => scopeCardIds.has(cardId))
    ) {
      push(
        'changed_self_review_batch_representative_cards_invalid',
        'A changed standard sample must name non-empty unique representative_cards drawn only from scope.card_ids.',
        {representative_cards: representativeCards},
      );
    }
    if (!hasText(record.batch_review?.next_step)) {
      push(
        'changed_self_review_batch_next_step_missing',
        'A changed standard sample must state its next-step recommendation.',
      );
    }
  }
  if (samplePolicy?.batch_generation_requires_user_confirmation !== true) {
    push(
      'changed_self_review_user_confirmation_policy_missing',
      'A changed self-review must preserve explicit user confirmation before batch generation or formal use.',
    );
  }
  if (
    !Array.isArray(record.specs_read) ||
    record.specs_read.length === 0 ||
    !record.specs_read.every(hasText)
  ) {
    push(
      'changed_self_review_specs_read_invalid',
      'A changed self-review must name the governing specs it read.',
    );
  }
  const scopeBoxPrefixes = Array.isArray(record.scope?.box_prefixes)
    ? record.scope.box_prefixes
    : [];
  if (
    scopeBoxPrefixes.length === 0 ||
    !scopeBoxPrefixes.every(hasText) ||
    new Set(scopeBoxPrefixes).size !== scopeBoxPrefixes.length
  ) {
    push(
      'changed_self_review_scope_box_prefixes_invalid',
      'A changed self-review must declare non-empty unique string scope.box_prefixes.',
    );
  }

  const qualityAudit = record.quality_audit;
  if (!qualityAudit || typeof qualityAudit !== 'object' || Array.isArray(qualityAudit)) {
    push(
      'changed_self_review_quality_audit_invalid',
      'A changed self-review must carry a structured quality_audit record.',
    );
  } else {
    if (!isQualityAuditReportPath(qualityAudit.report)) {
      push(
        'changed_self_review_quality_audit_report_invalid',
        'quality_audit.report must name the governed global report or one direct scoped-audit JSON record.',
        {report: qualityAudit.report ?? null},
      );
    }
    if (!hasText(qualityAudit.corpus_fingerprint)) {
      push(
        'changed_self_review_quality_audit_fingerprint_invalid',
        'quality_audit.corpus_fingerprint must be non-empty.',
      );
    }
    if (typeof qualityAudit.scope_has_no_hard_blockers !== 'boolean') {
      push(
        'changed_self_review_quality_audit_scope_flag_invalid',
        'quality_audit.scope_has_no_hard_blockers must be boolean.',
      );
    }
    if (
      record.batch_review?.status === 'recommend_user_confirmation' &&
      qualityAudit.scope_has_no_hard_blockers !== true
    ) {
      push(
        'changed_self_review_quality_audit_not_clear',
        'A self-review recommending user confirmation must declare zero scoped hard blockers.',
      );
    }
    const summary = qualityAudit.scope_summary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      push(
        'changed_self_review_quality_audit_summary_invalid',
        'quality_audit.scope_summary must be a structured scoped summary.',
      );
    } else {
      const summaryCardIds = Array.isArray(summary.card_ids) ? summary.card_ids : [];
      const summaryCardIdSet = new Set(summaryCardIds);
      if (
        summaryCardIds.length !== scopeCardIds.size ||
        !summaryCardIds.every(hasText) ||
        summaryCardIdSet.size !== summaryCardIds.length ||
        !setsEqual(summaryCardIdSet, scopeCardIds)
      ) {
        push(
          'changed_self_review_quality_audit_scope_mismatch',
          'quality_audit.scope_summary.card_ids must exactly equal the unique self-review scope.card_ids.',
          {
            expected_card_ids: [...scopeCardIds].sort(),
            actual_card_ids: summaryCardIds,
          },
        );
      }
      if (summary.card_count !== scopeCardIds.size || !isNonNegativeInteger(summary.issue_count)) {
        push(
          'changed_self_review_quality_audit_counts_invalid',
          'quality_audit scope card_count must match and issue_count must be a non-negative integer.',
          {
            expected_card_count: scopeCardIds.size,
            actual_card_count: summary.card_count ?? null,
            issue_count: summary.issue_count ?? null,
          },
        );
      }
      let severityTotal = 0;
      let severitiesValid = true;
      for (const severity of QUALITY_AUDIT_SEVERITIES) {
        const count = summary.by_severity?.[severity];
        if (!isNonNegativeInteger(count)) {
          severitiesValid = false;
          push(
            'changed_self_review_quality_audit_severity_invalid',
            'Every required quality_audit severity count must be a non-negative integer.',
            {severity, actual: count ?? null},
          );
        } else {
          severityTotal += count;
        }
      }
      if (
        record.batch_review?.status === 'recommend_user_confirmation' &&
        summary.by_severity?.hard_blocker !== 0
      ) {
        push(
          'changed_self_review_quality_audit_has_hard_blockers',
          'A self-review recommending user confirmation must report zero hard blockers.',
        );
      }
      if (
        severitiesValid &&
        isNonNegativeInteger(summary.issue_count) &&
        severityTotal !== summary.issue_count
      ) {
        push(
          'changed_self_review_quality_audit_severity_total_mismatch',
          'quality_audit.scope_summary.issue_count must equal the sum of required severity counts.',
        );
      }
      for (const ruleId of REQUIRED_QUALITY_AUDIT_RULES) {
        if (!isNonNegativeInteger(summary.by_rule?.[ruleId])) {
          push(
            'changed_self_review_quality_audit_rule_invalid',
            'Every governed quality_audit rule count must be a non-negative integer.',
            {rule_id: ruleId, actual: summary.by_rule?.[ruleId] ?? null},
          );
        }
      }
    }
  }

  const cards = Array.isArray(record.cards) ? record.cards : [];
  if (isResidualClosure) {
    if (cards.length !== scopeCardIds.size) {
      push(
        'changed_self_review_residual_card_count_invalid',
        'Residual closure evidence must carry exactly one card snapshot for every unique scope.card_ids entry.',
        {expected: scopeCardIds.size, actual: cards.length},
      );
    }
  } else if (!isConfirmedExpansion) {
    const expectedCardCount = scopeBoxPrefixes.length * 3;
    if (cards.length !== expectedCardCount) {
      push(
        'changed_self_review_sample_card_count_invalid',
        'A standard changed self-review must contain exactly three card snapshots per scoped box.',
        {expected: expectedCardCount, actual: cards.length},
      );
    }
    const cardsPerBox = new Map(scopeBoxPrefixes.map(boxPrefix => [boxPrefix, 0]));
    for (let index = 0; index < cards.length; index += 1) {
      const boxPrefix = cards[index]?.knowledge_ref?.box_prefix;
      if (!cardsPerBox.has(boxPrefix)) {
        push(
          'changed_self_review_card_box_prefix_invalid',
          'Every standard self-review snapshot must belong to one declared scope.box_prefixes value.',
          {review_index: index, card_id: cards[index]?.card_id ?? null, box_prefix: boxPrefix ?? null},
        );
        continue;
      }
      cardsPerBox.set(boxPrefix, cardsPerBox.get(boxPrefix) + 1);
    }
    for (const [boxPrefix, count] of cardsPerBox) {
      if (count !== 3) {
        push(
          'changed_self_review_per_box_card_count_invalid',
          'Every standard sample box must contain exactly three card snapshots.',
          {box_prefix: boxPrefix, expected: 3, actual: count},
        );
      }
    }
  } else if (cards.length !== scopeCardIds.size) {
    push(
      'changed_confirmed_expansion_snapshot_count_invalid',
      'Confirmed expansion evidence must carry exactly one snapshot for every unique scope.card_ids entry.',
      {expected: scopeCardIds.size, actual: cards.length},
    );
  }
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    for (const field of [
      'card_id',
      'interaction_id',
      'knowledge_ref',
      'status',
      'quality_metadata',
      'blocker_scan',
    ]) {
      if (!Object.hasOwn(card || {}, field)) {
        push(
          'changed_self_review_card_evidence_incomplete',
          `Every changed self-review card snapshot must include ${field}.`,
          {review_index: index, card_id: card?.card_id ?? null, field},
        );
      }
    }
    if (!CORE_INTERACTION_IDS.includes(card?.interaction_id)) {
      push(
        'changed_self_review_card_interaction_invalid',
        'Every changed self-review card snapshot must use a core interaction ID.',
        {review_index: index, card_id: card?.card_id ?? null, actual: card?.interaction_id ?? null},
      );
    }
    if (!SELF_REVIEW_CARD_STATUSES.includes(card?.status)) {
      push(
        'changed_self_review_card_status_invalid',
        'Every changed self-review card status must be pass, revise, or block.',
        {review_index: index, card_id: card?.card_id ?? null, actual: card?.status ?? null},
      );
    }
    if (card?.quality_metadata?.review_status === 'user_approved') {
      push(
        'changed_self_review_card_claims_user_approval',
        'Agent self-review metadata cannot claim user_approved status.',
        {review_index: index, card_id: card?.card_id ?? null},
      );
    }
    for (const field of ANALYSIS_REFERENCE_CHECK_FIELDS) {
      if (card?.analysis_reference_check?.[field] !== true) {
        push(
          'changed_self_review_analysis_reference_check_invalid',
          'Every card entry in a changed self-review must explicitly confirm answer truth, option or word-bank references, and distractor labels against the exact card source.',
          {
            review_index: index,
            card_id: card?.card_id ?? null,
            field,
            actual: card?.analysis_reference_check?.[field] ?? null,
          },
        );
      }
    }
    let hasBlocker = false;
    for (const blocker of REQUIRED_BLOCKERS) {
      if (typeof card?.blocker_scan?.[blocker] !== 'boolean') {
        push(
          'changed_self_review_blocker_scan_invalid',
          'Every governed blocker scan field must be boolean.',
          {review_index: index, card_id: card?.card_id ?? null, blocker},
        );
      } else if (card.blocker_scan[blocker]) {
        hasBlocker = true;
      }
    }
    if (card?.status === 'pass' && hasBlocker) {
      push(
        'changed_self_review_pass_card_has_blocker',
        'A changed self-review card marked pass cannot carry a true blocker.',
        {review_index: index, card_id: card?.card_id ?? null},
      );
    }
    if (
      record.batch_review?.status === 'recommend_user_confirmation' &&
      (card?.status !== 'pass' || hasBlocker)
    ) {
      push(
        'changed_self_review_recommends_confirmation_with_blocked_card',
        'A self-review cannot recommend user confirmation while an included card is non-pass or blocked.',
        {review_index: index, card_id: card?.card_id ?? null},
      );
    }
  }

  return issues;
}

function runChangedCardIntegrity({ base, head, entries }) {
  if (!head) {
    return {
      skipped: true,
      reason: 'head_ref_not_provided',
      merge_base: null,
      changed_card_ids: [],
      changed_self_review_paths: changedSelfReviewPaths(entries),
      issues: [],
    };
  }

  const reviewPaths = changedSelfReviewPaths(entries);
  const hasChangedCardBox = hasCardBoxDiff(entries);
  if (!hasChangedCardBox && reviewPaths.length === 0) {
    return {
      skipped: true,
      reason: 'no_changed_card_or_self_review_paths',
      merge_base: null,
      changed_card_ids: [],
      changed_self_review_paths: [],
      issues: [],
    };
  }

  const mergeBase = runGit(['merge-base', base, head]).trim();
  const baseCorpus = cardCorpusAtCommit(mergeBase);
  const headCorpus = cardCorpusAtCommit(head);
  const issues = [...headCorpus.issues];
  const changedCards = [];

  if (hasChangedCardBox) {
    for (const [cardId, headOccurrences] of headCorpus.cardsById) {
      if (headOccurrences.length !== 1) {
        issues.push({
          code: 'changed_card_head_corpus_duplicate_id',
          card_id: cardId,
          paths: headOccurrences.map(occurrence => occurrence.path),
          message: 'HEAD must contain exactly one corpus card for each card_id before changed-card integrity can be proven.',
        });
        continue;
      }

      const baseOccurrences = baseCorpus.cardsById.get(cardId) || [];
      if (baseOccurrences.length !== 1 || !isDeepStrictEqual(baseOccurrences[0].card, headOccurrences[0].card)) {
        changedCards.push({
          card_id: cardId,
          added: baseOccurrences.length === 0,
          ...headOccurrences[0],
        });
      }
    }

    for (const [cardId, baseOccurrences] of baseCorpus.cardsById) {
      const headOccurrences = headCorpus.cardsById.get(cardId) || [];
      if (baseOccurrences.length === 1 && headOccurrences.length === 0) {
        issues.push({
          code: 'changed_candidate_card_deleted',
          card_id: cardId,
          path: baseOccurrences[0].path,
          message: 'Candidate card deletion is not permitted; keep the card and use the governed discard-candidate workflow for user confirmation.',
        });
      }
    }
  }

  const reviewsByCardId = new Map();
  const fullTrackReviewPaths = [];
  for (const filePath of reviewPaths) {
    if (!isRegularFileAtCommit(head, filePath)) {
      issues.push({
        code: 'changed_self_review_not_regular_file',
        path: filePath,
        message: 'Each changed self-review must be a direct regular JSON file, not a symlink or another Git object type.',
      });
      continue;
    }
    const record = readChangedJson(filePath, head);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push({
        code: 'changed_self_review_unreadable',
        path: filePath,
        message: 'Each changed self-review must be a readable JSON object.',
      });
      continue;
    }

    const rawScopeCardIds = Array.isArray(record.scope?.card_ids)
      ? record.scope.card_ids
      : [];
    const validScopeCardIds = rawScopeCardIds.filter(cardId =>
      typeof cardId === 'string' && cardId.length > 0
    );
    const scopeCardIds = new Set(validScopeCardIds);
    if (rawScopeCardIds.length === 0 || validScopeCardIds.length !== rawScopeCardIds.length) {
      issues.push({
        code: 'changed_self_review_scope_card_ids_invalid',
        path: filePath,
        message: 'A changed self-review must declare a non-empty scope.card_ids array of strings.',
      });
    }
    if (scopeCardIds.size !== validScopeCardIds.length) {
      issues.push({
        code: 'changed_self_review_scope_card_ids_duplicate',
        path: filePath,
        message: 'A changed self-review scope.card_ids list must not contain duplicates.',
      });
    }

    const isFullTrackAggregate =
      record.sample_policy?.review_scope_type === 'full_track_remediation';
    if (isFullTrackAggregate) {
      fullTrackReviewPaths.push(filePath);
      const fullTrackCardsAbsent = !Object.hasOwn(record, 'cards');
      if (!fullTrackCardsAbsent) {
        issues.push({
          code: 'changed_full_track_review_cards_forbidden',
          path: filePath,
          message: 'A full-track aggregate must use governed scope, coverage, audit, and status fields; it must not carry an unvalidated cards snapshot payload.',
        });
      }
      const rawReviewedCardIds = Array.isArray(record.coverage?.reviewed_card_ids)
        ? record.coverage.reviewed_card_ids
        : [];
      const validReviewedCardIds = rawReviewedCardIds.filter(cardId =>
        typeof cardId === 'string' && cardId.length > 0
      );
      const reviewedCardIds = new Set(validReviewedCardIds);
      const coverageIdsValid =
        rawReviewedCardIds.length > 0 &&
        validReviewedCardIds.length === rawReviewedCardIds.length;
      const coverageIdsUnique = reviewedCardIds.size === validReviewedCardIds.length;
      const scopeCoverageEqual =
        scopeCardIds.size === reviewedCardIds.size &&
        [...scopeCardIds].every(cardId => reviewedCardIds.has(cardId));
      const expectedCountMatches =
        Number.isInteger(record.coverage?.expected_card_count) &&
        record.coverage.expected_card_count === scopeCardIds.size;
      const scopeTrack = record.scope?.track;
      const trackValid = scopeTrack === 'cet4' || scopeTrack === 'cet6';
      const headTrackScope = trackScopeFromCorpus(headCorpus, scopeTrack);
      const baseTrackScope = trackScopeFromCorpus(baseCorpus, scopeTrack);
      const rawScopeBoxPrefixes = Array.isArray(record.scope?.box_prefixes)
        ? record.scope.box_prefixes
        : [];
      const validScopeBoxPrefixes = rawScopeBoxPrefixes.filter(boxPrefix =>
        typeof boxPrefix === 'string' && boxPrefix.length > 0
      );
      const scopeBoxPrefixes = new Set(validScopeBoxPrefixes);
      const scopeBoxPrefixesValid =
        rawScopeBoxPrefixes.length > 0 &&
        validScopeBoxPrefixes.length === rawScopeBoxPrefixes.length;
      const scopeBoxPrefixesUnique =
        scopeBoxPrefixes.size === validScopeBoxPrefixes.length;
      const rawCoverageBoxes = Array.isArray(record.coverage?.boxes)
        ? record.coverage.boxes
        : [];
      const validCoverageBoxPrefixes = rawCoverageBoxes
        .map(box => box?.box_prefix)
        .filter(boxPrefix => typeof boxPrefix === 'string' && boxPrefix.length > 0);
      const coverageBoxPrefixes = new Set(validCoverageBoxPrefixes);
      const coverageBoxPrefixesValid =
        rawCoverageBoxes.length > 0 &&
        validCoverageBoxPrefixes.length === rawCoverageBoxes.length;
      const coverageBoxPrefixesUnique =
        coverageBoxPrefixes.size === validCoverageBoxPrefixes.length;
      const semanticIssues = validateFullTrackAggregateSemantics({
        record,
        filePath,
        scopeCardIds,
        scopeBoxPrefixes,
      });
      issues.push(...semanticIssues);
      const trackCardScopeEqual =
        trackValid &&
        headTrackScope.cardIds.size > 0 &&
        headTrackScope.ambiguousCardIds.length === 0 &&
        setsEqual(scopeCardIds, headTrackScope.cardIds);
      const trackMembershipStable =
        trackValid &&
        baseTrackScope.cardIds.size > 0 &&
        baseTrackScope.ambiguousCardIds.length === 0 &&
        headTrackScope.ambiguousCardIds.length === 0 &&
        setsEqual(baseTrackScope.cardIds, headTrackScope.cardIds);
      const trackBoxScopeEqual =
        trackValid &&
        headTrackScope.boxPrefixes.size > 0 &&
        headTrackScope.cardsMissingBoxPrefix.length === 0 &&
        setsEqual(scopeBoxPrefixes, headTrackScope.boxPrefixes);
      const coverageBoxScopeEqual =
        setsEqual(coverageBoxPrefixes, scopeBoxPrefixes);

      if (!coverageIdsValid) {
        issues.push({
          code: 'changed_full_track_review_coverage_card_ids_invalid',
          path: filePath,
          message: 'A changed full-track aggregate must declare a non-empty coverage.reviewed_card_ids array of strings.',
        });
      }
      if (!coverageIdsUnique) {
        issues.push({
          code: 'changed_full_track_review_coverage_card_ids_duplicate',
          path: filePath,
          message: 'A changed full-track aggregate coverage.reviewed_card_ids list must not contain duplicates.',
        });
      }
      if (!scopeCoverageEqual) {
        issues.push({
          code: 'changed_full_track_review_scope_coverage_mismatch',
          path: filePath,
          scope_card_ids: [...scopeCardIds].sort(),
          reviewed_card_ids: [...reviewedCardIds].sort(),
          message: 'A changed full-track aggregate must cover exactly the same card IDs declared by scope.card_ids.',
        });
      }
      if (!expectedCountMatches) {
        issues.push({
          code: 'changed_full_track_review_expected_count_mismatch',
          path: filePath,
          expected: scopeCardIds.size,
          actual: record.coverage?.expected_card_count ?? null,
          message: 'A changed full-track aggregate coverage.expected_card_count must equal the unique scope card count.',
        });
      }
      if (!trackValid) {
        issues.push({
          code: 'changed_full_track_review_track_invalid',
          path: filePath,
          track: scopeTrack ?? null,
          message: 'A changed full-track aggregate must declare scope.track as cet4 or cet6.',
        });
      }
      if (!scopeBoxPrefixesValid) {
        issues.push({
          code: 'changed_full_track_review_scope_box_prefixes_invalid',
          path: filePath,
          message: 'A changed full-track aggregate must declare non-empty string scope.box_prefixes.',
        });
      }
      if (!scopeBoxPrefixesUnique) {
        issues.push({
          code: 'changed_full_track_review_scope_box_prefixes_duplicate',
          path: filePath,
          message: 'A changed full-track aggregate scope.box_prefixes list must not contain duplicates.',
        });
      }
      if (!coverageBoxPrefixesValid) {
        issues.push({
          code: 'changed_full_track_review_coverage_boxes_invalid',
          path: filePath,
          message: 'A changed full-track aggregate must declare coverage.boxes with a non-empty box_prefix on every entry.',
        });
      }
      if (!coverageBoxPrefixesUnique) {
        issues.push({
          code: 'changed_full_track_review_coverage_boxes_duplicate',
          path: filePath,
          message: 'A changed full-track aggregate coverage.boxes must not repeat a box_prefix.',
        });
      }
      if (trackValid && !trackCardScopeEqual) {
        issues.push({
          code: 'changed_full_track_review_track_card_scope_mismatch',
          path: filePath,
          track: scopeTrack,
          expected_card_ids: [...headTrackScope.cardIds].sort(),
          actual_card_ids: [...scopeCardIds].sort(),
          message: 'A changed full-track aggregate scope.card_ids must equal every unique card in the declared immutable HEAD track.',
        });
      }
      if (trackValid && !trackMembershipStable) {
        issues.push({
          code: 'changed_full_track_review_track_membership_changed',
          path: filePath,
          track: scopeTrack,
          merge_base_card_ids: [...baseTrackScope.cardIds].sort(),
          head_card_ids: [...headTrackScope.cardIds].sort(),
          merge_base_ambiguous_card_ids: baseTrackScope.ambiguousCardIds,
          head_ambiguous_card_ids: headTrackScope.ambiguousCardIds,
          message: 'A full-track remediation aggregate cannot authorize added, deleted, or ambiguous track membership; the merge-base and immutable HEAD card ID sets must be the same non-empty track.',
        });
      }
      if (trackValid && !trackBoxScopeEqual) {
        issues.push({
          code: 'changed_full_track_review_track_box_scope_mismatch',
          path: filePath,
          track: scopeTrack,
          expected_box_prefixes: [...headTrackScope.boxPrefixes].sort(),
          actual_box_prefixes: [...scopeBoxPrefixes].sort(),
          head_cards_missing_box_prefix: headTrackScope.cardsMissingBoxPrefix,
          message: 'A changed full-track aggregate scope.box_prefixes must equal every box prefix in the declared immutable HEAD track.',
        });
      }
      if (!coverageBoxScopeEqual) {
        issues.push({
          code: 'changed_full_track_review_coverage_box_scope_mismatch',
          path: filePath,
          scope_box_prefixes: [...scopeBoxPrefixes].sort(),
          coverage_box_prefixes: [...coverageBoxPrefixes].sort(),
          message: 'A changed full-track aggregate coverage.boxes must cover exactly the declared scope.box_prefixes.',
        });
      }

      const aggregateCoverageValid =
        rawScopeCardIds.length > 0 &&
        validScopeCardIds.length === rawScopeCardIds.length &&
        scopeCardIds.size === validScopeCardIds.length &&
        fullTrackCardsAbsent &&
        coverageIdsValid &&
        coverageIdsUnique &&
        scopeCoverageEqual &&
        expectedCountMatches &&
        trackValid &&
        scopeBoxPrefixesValid &&
        scopeBoxPrefixesUnique &&
        coverageBoxPrefixesValid &&
        coverageBoxPrefixesUnique &&
        semanticIssues.length === 0 &&
        trackCardScopeEqual &&
        trackMembershipStable &&
        trackBoxScopeEqual &&
        coverageBoxScopeEqual;
      const aggregateIds = new Set([...scopeCardIds, ...reviewedCardIds]);
      let aggregateHeadResolutionValid = true;
      for (const cardId of aggregateIds) {
        const corpusOccurrences = headCorpus.cardsById.get(cardId) || [];
        if (corpusOccurrences.length !== 1) {
          aggregateHeadResolutionValid = false;
          issues.push({
            code: corpusOccurrences.length === 0
              ? 'changed_self_review_scope_card_missing_from_head_corpus'
              : 'changed_self_review_scope_card_ambiguous_in_head_corpus',
            card_id: cardId,
            path: filePath,
            corpus_occurrences: corpusOccurrences.map(occurrence => occurrence.path),
            message: 'Every card_id declared by a changed full-track aggregate must resolve to exactly one card in the immutable HEAD corpus.',
          });
        } else if (corpusOccurrences[0].card?.track !== scopeTrack) {
          aggregateHeadResolutionValid = false;
          issues.push({
            code: 'changed_full_track_review_scope_track_mismatch',
            card_id: cardId,
            path: filePath,
            expected_track: scopeTrack,
            actual_track: corpusOccurrences[0].card?.track ?? null,
            message: 'Every card_id declared by a changed full-track aggregate must belong to scope.track in immutable HEAD.',
          });
        }
      }
      if (aggregateCoverageValid && aggregateHeadResolutionValid) {
        for (const cardId of scopeCardIds) {
          const matches = reviewsByCardId.get(cardId) || [];
          matches.push({
            review: null,
            path: filePath,
            review_index: null,
            scope_card_ids: scopeCardIds,
            mode: 'full_track_aggregate',
          });
          reviewsByCardId.set(cardId, matches);
        }
      }
      continue;
    }

    const standardSemanticIssues = validateStandardReviewSemantics({
      record,
      filePath,
      scopeCardIds,
      head,
    });
    issues.push(...standardSemanticIssues);
    const standardSemanticsValid = standardSemanticIssues.length === 0;

    if (!Array.isArray(record.cards)) {
      issues.push({
        code: 'changed_self_review_cards_missing',
        path: filePath,
        message: 'Each changed non-full-track self-review must carry a cards array of per-card metadata snapshots.',
      });
      continue;
    }

    const recordCardIds = [];
    for (let index = 0; index < record.cards.length; index += 1) {
      const review = record.cards[index];
      const cardId = typeof review?.card_id === 'string' ? review.card_id : null;
      if (!cardId) {
        issues.push({
          code: 'changed_self_review_card_id_missing',
          path: filePath,
          review_index: index,
          message: 'Every card entry in a changed self-review must name a card_id.',
        });
        continue;
      }
      recordCardIds.push(cardId);

      if (!scopeCardIds.has(cardId)) {
        issues.push({
          code: 'changed_self_review_card_missing_from_scope',
          card_id: cardId,
          path: filePath,
          message: 'A changed self-review card entry must also be named in that record\'s scope.card_ids.',
        });
      }

      const corpusOccurrences = headCorpus.cardsById.get(cardId) || [];
      let snapshotIdentityValid = corpusOccurrences.length === 1;
      if (corpusOccurrences.length !== 1) {
        issues.push({
          code: corpusOccurrences.length === 0
            ? 'changed_self_review_card_missing_from_head_corpus'
            : 'changed_self_review_card_ambiguous_in_head_corpus',
          card_id: cardId,
          path: filePath,
          corpus_occurrences: corpusOccurrences.map(occurrence => occurrence.path),
          message: 'Every changed self-review card entry must resolve to exactly one card in the HEAD corpus.',
        });
      } else {
        const corpusCard = corpusOccurrences[0].card;
        if (review.interaction_id !== corpusCard?.interaction_id) {
          snapshotIdentityValid = false;
          issues.push({
            code: 'changed_self_review_card_interaction_mismatch',
            card_id: cardId,
            path: filePath,
            expected: corpusCard?.interaction_id ?? null,
            actual: review.interaction_id ?? null,
            message: 'A standard self-review snapshot interaction_id must match its unique immutable HEAD corpus card.',
          });
        }
        if (!isDeepStrictEqual(review.knowledge_ref, corpusCard?.knowledge_ref)) {
          snapshotIdentityValid = false;
          issues.push({
            code: 'changed_self_review_card_knowledge_ref_mismatch',
            card_id: cardId,
            path: filePath,
            expected: corpusCard?.knowledge_ref ?? null,
            actual: review.knowledge_ref ?? null,
            message: 'A standard self-review snapshot knowledge_ref must exactly match its unique immutable HEAD corpus card.',
          });
        }
      }

      if (standardSemanticsValid && snapshotIdentityValid) {
        const matches = reviewsByCardId.get(cardId) || [];
        matches.push({
          review,
          path: filePath,
          review_index: index,
          scope_card_ids: scopeCardIds,
          mode: changedSelfReviewScopeType(record) === 'residual_blocker_closure'
            ? 'residual_snapshot'
            : 'standard_snapshot',
        });
        reviewsByCardId.set(cardId, matches);
      }
    }

    const recordCardIdSet = new Set(recordCardIds);
    if (recordCardIdSet.size !== recordCardIds.length) {
      issues.push({
        code: 'changed_self_review_duplicate_card_entry',
        path: filePath,
        message: 'A changed self-review must contain exactly one card entry for each card_id.',
      });
    }
    for (const cardId of scopeCardIds) {
      const corpusOccurrences = headCorpus.cardsById.get(cardId) || [];
      if (corpusOccurrences.length === 0) {
        issues.push({
          code: 'changed_self_review_scope_card_missing_from_head_corpus',
          card_id: cardId,
          path: filePath,
          message: 'Every card_id declared by a changed self-review scope must exist in the HEAD corpus.',
        });
      }
      if (!recordCardIdSet.has(cardId)) {
        issues.push({
          code: 'changed_self_review_scope_card_missing_from_record',
          card_id: cardId,
          path: filePath,
          message: 'Every card_id declared by a changed self-review scope must have exactly one card entry in that record.',
        });
      }
    }
  }

  const policy = loadIntegrityPolicy(process.cwd());
  for (const [cardId, matches] of reviewsByCardId) {
    const snapshotMatches = matches.filter(match =>
      match.mode === 'standard_snapshot' || match.mode === 'residual_snapshot'
    );
    if (snapshotMatches.length === 0) continue;
    const corpusOccurrences = headCorpus.cardsById.get(cardId) || [];
    if (corpusOccurrences.length !== 1) continue;
    const parityResult = validateChangedCardSelfReviewParity(
      [{card: corpusOccurrences[0].card, path: corpusOccurrences[0].path}],
      snapshotMatches.map(match => ({card: match.review, path: match.path})),
      policy,
      {required: true},
    );
    appendLibraryIssues(issues, parityResult.issues, {
      code: 'changed_self_review_current_corpus_parity_invalid',
      card_id: cardId,
      path: corpusOccurrences[0].path,
      self_review_paths: snapshotMatches.map(match => match.path),
      message: 'Every entry in a changed self-review must carry complete quality_metadata that matches its unique current HEAD corpus card except for the independently validated review_status.',
    });
  }

  for (const changedCard of changedCards) {
    const metadataResult = validateQualityMetadata(changedCard.card, policy, { required: true });
    appendLibraryIssues(issues, metadataResult.issues, {
      code: 'changed_card_quality_metadata_invalid',
      card_id: changedCard.card_id,
      path: changedCard.path,
      message: 'Every added or modified card must carry complete, valid quality_metadata.',
    });

    const eliminationResult = validateEliminationIntegrity(
      changedCard.card,
      { requireLegacyMirror: true },
    );
    appendLibraryIssues(issues, eliminationResult.issues, {
      code: 'changed_card_elimination_integrity_invalid',
      card_id: changedCard.card_id,
      path: changedCard.path,
      message: 'Every added or modified elimination card must keep canonical items, the legacy mirror, and answer truth in sync.',
    });

    const matchingReviews = reviewsByCardId.get(changedCard.card_id) || [];
    const eligibleMatchingReviews = changedCard.added
      ? matchingReviews.filter(match => match.mode === 'standard_snapshot')
      : matchingReviews;
    const scopedMatchingReviews = eligibleMatchingReviews.filter(match =>
      match.scope_card_ids.has(changedCard.card_id)
    );
    if (
      changedCard.added &&
      matchingReviews.some(match => match.mode !== 'standard_snapshot')
    ) {
      issues.push({
        code: 'changed_added_card_requires_standard_sample_review',
        card_id: changedCard.card_id,
        review_paths: matchingReviews.map(match => match.path),
        review_modes: matchingReviews.map(match => match.mode),
        message: 'A newly added candidate card requires canonical three-card sample coverage; residual closure or aggregate evidence cannot authorize new generation.',
      });
    }
    if (eligibleMatchingReviews.length !== 1 || scopedMatchingReviews.length !== 1) {
      issues.push({
        code: 'changed_card_self_review_count_invalid',
        library_code: eligibleMatchingReviews.length === 0
          ? CARD_INTEGRITY_ISSUE_CODES.selfReviewMissing
          : 'candidate_self_review_ambiguous',
        card_id: changedCard.card_id,
        review_count: eligibleMatchingReviews.length,
        ineligible_review_count: matchingReviews.length - eligibleMatchingReviews.length,
        scoped_review_count: scopedMatchingReviews.length,
        review_paths: matchingReviews.map(match => match.path),
        review_modes: matchingReviews.map(match => match.mode),
        message: 'Every added or modified card must have exactly one changed review coverage: either one standard per-card snapshot or one valid full-track aggregate scope+coverage entry.',
      });
      continue;
    }

  }

  return {
    ok: issues.length === 0,
    skipped: false,
    merge_base: mergeBase,
    changed_card_ids: changedCards.map(card => card.card_id).sort(),
    changed_self_review_paths: reviewPaths,
    changed_full_track_review_paths: fullTrackReviewPaths.sort(),
    issues,
  };
}

function copyCurrentAuditHarness(worktreePath) {
  for (const relativePath of CURRENT_AUDIT_OVERLAY_PATHS) {
    const source = path.resolve(relativePath);
    const target = path.join(worktreePath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function materializeHeadCardCorpus(worktreePath, head) {
  const cardCorpusPath = path.join(worktreePath, 'card_boxes_json');
  fs.rmSync(cardCorpusPath, { recursive: true, force: true });
  runGit(
    ['--literal-pathspecs', 'checkout', head, '--', 'card_boxes_json'],
    { cwd: worktreePath },
  );
}

function runCurrentScopedAudit({ base, head, entries }) {
  if (!head) return { skipped: true, reason: 'head_ref_not_provided' };

  const cardBoxPaths = changedCardBoxPaths(entries);
  if (cardBoxPaths.length === 0) return { skipped: true, reason: 'no_changed_card_box_paths' };

  const scopeCardIds = changedScopeCardIds(entries, head);
  if (scopeCardIds.length === 0) {
    return {
      ok: false,
      code: 'content_sample_current_audit_scope_ids_missing',
      message: 'Content sample PRs with card JSON changes must include scoped evidence listing card_ids so the current audit can be replayed.',
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-pr-scope-audit-'));
  const worktreePath = path.join(tempRoot, 'worktree');
  const scopedReportPath = 'reviews/audit_scopes/__validate_pr_scope_current_audit.json';
  let worktreeAdded = false;

  try {
    addDetachedPointerWorktree(worktreePath, base);
    worktreeAdded = true;
    materializeHeadCardCorpus(worktreePath, head);
    copyCurrentAuditHarness(worktreePath);
    const output = runCommand(process.execPath, [
      'scripts/audit_card_quality.mjs',
      '--scope-card-ids',
      scopeCardIds.join(','),
      '--write-scope-report',
      scopedReportPath,
      '--max-examples',
      '20',
    ], { cwd: worktreePath });
    const summary = safeJsonParse(output);
    const report = readJsonFile(path.join(worktreePath, scopedReportPath));
    const hardBlockerCount = Number(report?.scope_summary?.by_severity?.hard_blocker || 0);
    return {
      ok: hardBlockerCount === 0,
      card_ids: scopeCardIds,
      changed_card_box_paths: cardBoxPaths,
      scope_summary: report?.scope_summary || summary?.scope_summary || null,
      scoped_hard_blocker_issues: report?.scoped_hard_blocker_issues || [],
    };
  } catch (error) {
    return {
      ok: false,
      code: 'content_sample_current_audit_failed',
      message: error.message,
      card_ids: scopeCardIds,
      changed_card_box_paths: cardBoxPaths,
    };
  } finally {
    if (worktreeAdded) {
      try {
        runGit(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Best-effort cleanup only; validation result must reflect the audit outcome.
      }
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function replayScopedAuditAtHead({base, head, scopeCardIds}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-scoped-audit-replay-'));
  const worktreePath = path.join(tempRoot, 'worktree');
  const scopedReportPath = 'reviews/audit_scopes/__validate_changed_scoped_audit.json';
  let worktreeAdded = false;
  try {
    addDetachedPointerWorktree(worktreePath, base);
    worktreeAdded = true;
    materializeHeadCardCorpus(worktreePath, head);
    copyCurrentAuditHarness(worktreePath);
    const execution = spawnSync(process.execPath, [
      'scripts/audit_card_quality.mjs',
      '--scope-card-ids',
      scopeCardIds.join(','),
      '--write-scope-report',
      scopedReportPath,
      '--max-examples',
      '20',
    ], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fullReportPath = path.join(worktreePath, scopedReportPath);
    if (!fs.existsSync(fullReportPath)) {
      return {
        ok: false,
        message: execution.stderr.trim() ||
          execution.stdout.trim() ||
          'Current scoped audit replay did not produce a report.',
      };
    }
    return {
      ok: true,
      report: readJsonFile(fullReportPath),
      exit_status: execution.status,
    };
  } catch (error) {
    return {ok: false, message: error.message};
  } finally {
    if (worktreeAdded) {
      try {
        runGit(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      fs.rmSync(tempRoot, {recursive: true, force: true});
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function immutableLegacyScopedAuditPathsAtCommit(head) {
  const policy = readChangedJson('spec/card-quality-audit.json', head);
  return new Set(
    (policy?.legacy_scoped_report_archive?.reports || [])
      .map(entry => entry?.path)
      .filter(hasText),
  );
}

function validateChangedScopedAuditReports({base, head, entries}) {
  const issues = [];
  const immutableLegacyPaths = immutableLegacyScopedAuditPathsAtCommit(head);
  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    const sourcePath = entry.paths[0];
    const changedLegacyPath = entry.paths.find(filePath =>
      immutableLegacyPaths.has(filePath)
    );
    if (changedLegacyPath) {
      issues.push({
        code: 'changed_legacy_scoped_audit_immutable',
        path: changedLegacyPath,
        status: entry.status,
        message: 'Archived legacy scoped-audit artifacts are byte-immutable; current evidence must use a new direct scoped-report path.',
      });
      continue;
    }
    if (
      (statusType === 'D' && isScopedAuditPath(entry.path)) ||
      (statusType === 'R' && isScopedAuditPath(sourcePath))
    ) {
      issues.push({
        code: 'changed_scoped_audit_deleted_or_renamed',
        path: sourcePath || entry.path,
        status: entry.status,
        message: 'Tracked scoped-audit evidence must not be deleted or renamed by a candidate PR.',
      });
    }
    if (statusType === 'D' || !isScopedAuditPath(entry.path)) continue;
    const filePath = entry.path;
    if (!isScopedQualityAuditReportPath(filePath)) {
      issues.push({
        code: 'changed_scoped_audit_path_noncanonical',
        path: filePath,
        status: entry.status,
        message: 'Scoped-audit evidence must be one direct JSON child of reviews/audit_scopes.',
      });
      continue;
    }
    if (!isRegularFileAtCommit(head, filePath)) {
      issues.push({
        code: 'changed_scoped_audit_not_regular_file',
        path: filePath,
        status: entry.status,
        message: 'Changed scoped-audit evidence must resolve to a regular Git blob at immutable HEAD.',
      });
      continue;
    }
    const report = readChangedJson(filePath, head);
    const scopeCardIds = Array.isArray(report?.scope?.card_ids)
      ? report.scope.card_ids
      : [];
    if (
      !report ||
      typeof report !== 'object' ||
      Array.isArray(report) ||
      scopeCardIds.length === 0 ||
      !scopeCardIds.every(hasText) ||
      new Set(scopeCardIds).size !== scopeCardIds.length
    ) {
      issues.push({
        code: 'changed_scoped_audit_invalid',
        path: filePath,
        message: 'A changed scoped-audit file must be a readable report with non-empty unique scope.card_ids.',
      });
      continue;
    }
    const replay = replayScopedAuditAtHead({base, head, scopeCardIds});
    if (!replay.ok) {
      issues.push({
        code: 'changed_scoped_audit_replay_failed',
        path: filePath,
        message: replay.message,
      });
      continue;
    }
    if (!isDeepStrictEqual(report, replay.report)) {
      issues.push({
        code: 'changed_scoped_audit_replay_mismatch',
        path: filePath,
        replay_exit_status: replay.exit_status,
        message: 'Changed scoped-audit evidence must exactly match a replay of the current audit against immutable HEAD for its declared scope.',
      });
    }
  }
  return issues;
}

function validateChangedReviewScopedAuditReferences({base, head, entries}) {
  const issues = [];
  const replayCache = new Map();
  const validateScopedReference = ({recordPath, record, auditRecord}) => {
    const reportPath = auditRecord?.report;
    if (!isScopedQualityAuditReportPath(reportPath)) {
      issues.push({
        code: 'changed_review_current_scoped_audit_required',
        path: recordPath,
        report: reportPath ?? null,
        message: 'Every changed self-review or approval record, and every self-review linked by a changed approval, must link one direct current scoped audit report.',
      });
      return;
    }
    if (!isRegularFileAtCommit(head, reportPath)) {
      issues.push({
        code: 'changed_review_scoped_audit_not_regular_file',
        path: recordPath,
        report: reportPath,
        message: 'A changed review must link a direct scoped-audit regular Git blob at immutable HEAD.',
      });
      return;
    }
    const scopeCardIds = Array.isArray(record.scope?.card_ids)
      ? record.scope.card_ids
      : [];
    if (
      scopeCardIds.length === 0 ||
      !scopeCardIds.every(hasText) ||
      new Set(scopeCardIds).size !== scopeCardIds.length
    ) {
      issues.push({
        code: 'changed_review_scope_card_ids_invalid',
        path: recordPath,
        message: 'A changed review must declare non-empty unique string scope.card_ids before its audit reference can be replayed.',
      });
      return;
    }
    const report = readChangedJson(reportPath, head);
    if (
      !report ||
      typeof report !== 'object' ||
      Array.isArray(report) ||
      !setsEqual(new Set(report.scope?.card_ids || []), new Set(scopeCardIds))
    ) {
      issues.push({
        code: 'changed_review_scoped_audit_scope_mismatch',
        path: recordPath,
        report: reportPath,
        expected_card_ids: [...scopeCardIds].sort(),
        actual_card_ids: [...(report?.scope?.card_ids || [])].sort(),
        message: 'A changed review scoped audit must cover exactly its declared scope.card_ids.',
      });
      return;
    }
    const replayKey = JSON.stringify([...scopeCardIds].sort());
    let replay = replayCache.get(replayKey);
    if (!replay) {
      replay = replayScopedAuditAtHead({base, head, scopeCardIds});
      replayCache.set(replayKey, replay);
    }
    if (!replay.ok) {
      issues.push({
        code: 'changed_review_scoped_audit_replay_failed',
        path: recordPath,
        report: reportPath,
        message: replay.message,
      });
      return;
    }
    if (!isDeepStrictEqual(report, replay.report)) {
      issues.push({
        code: 'changed_review_scoped_audit_replay_mismatch',
        path: recordPath,
        report: reportPath,
        replay_exit_status: replay.exit_status,
        message: 'Every changed review must link a scoped report that exactly matches the current immutable-HEAD audit replay for its declared scope.',
      });
    }
  };

  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;
    const filePath = entry.path;
    if (!isSelfReviewPath(filePath) && !isApprovedBatchPath(filePath)) continue;
    if (!isRegularFileAtCommit(head, filePath)) {
      issues.push({
        code: 'changed_review_not_regular_file',
        path: filePath,
        status: entry.status,
        message: 'Changed review and approval evidence must resolve to a regular Git blob at immutable HEAD.',
      });
      continue;
    }
    const record = readChangedJson(filePath, head);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push({
        code: 'changed_review_unreadable',
        path: filePath,
        message: 'Changed review and approval evidence must be a readable JSON object.',
      });
      continue;
    }

    if (isApprovedBatchPath(filePath)) {
      const linkedReviewPath = record.validation?.agent_self_review;
      if (!isSelfReviewPath(linkedReviewPath)) {
        issues.push({
          code: 'changed_approval_linked_self_review_path_invalid',
          path: filePath,
          linked_review: linkedReviewPath ?? null,
          message: 'A changed approval must link one direct canonical non-template record under reviews/agent_self_review.',
        });
      } else if (!isRegularFileAtCommit(head, linkedReviewPath)) {
        issues.push({
          code: 'changed_approval_linked_self_review_not_regular_file',
          path: filePath,
          linked_review: linkedReviewPath,
          message: 'A changed approval must link a regular self-review Git blob at immutable HEAD.',
        });
      } else {
        const linkedReview = readChangedJson(linkedReviewPath, head);
        if (
          !linkedReview ||
          typeof linkedReview !== 'object' ||
          Array.isArray(linkedReview)
        ) {
          issues.push({
            code: 'changed_approval_linked_self_review_unreadable',
            path: filePath,
            linked_review: linkedReviewPath,
          });
        } else {
          if (
            !setsEqual(
              new Set(linkedReview.scope?.card_ids || []),
              new Set(record.scope?.card_ids || []),
            ) ||
            !setsEqual(
              new Set(linkedReview.scope?.box_prefixes || []),
              new Set(record.scope?.box_prefixes || []),
            )
          ) {
            issues.push({
              code: 'changed_approval_linked_self_review_scope_mismatch',
              path: filePath,
              linked_review: linkedReviewPath,
            });
          }
          validateScopedReference({
            recordPath: linkedReviewPath,
            record: linkedReview,
            auditRecord: linkedReview.quality_audit,
          });
        }
      }
    }
    validateScopedReference({
      recordPath: filePath,
      record,
      auditRecord: isApprovedBatchPath(filePath)
        ? record.card_quality_audit
        : record.quality_audit,
    });
  }
  return issues;
}

function validateChangedControlledPilotRecords({base, head, entries}) {
  const issues = [];
  const changedPaths = new Set(entries.flatMap(entry => entry.paths));
  const changedReviews = new Map();
  const changedApprovals = new Map();

  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;
    const filePath = entry.path;
    if (!isControlledPilotReviewPath(filePath) && !isControlledPilotApprovalPath(filePath)) continue;
    if (!isRegularFileAtCommit(head, filePath)) {
      issues.push({
        code: 'changed_controlled_pilot_record_not_regular_file',
        path: filePath,
        message: 'Controlled-pilot review and approval evidence must be direct regular JSON blobs at immutable HEAD.',
      });
      continue;
    }
    const record = readChangedJson(filePath, head);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      issues.push({
        code: 'changed_controlled_pilot_record_unreadable',
        path: filePath,
        message: 'Controlled-pilot review and approval evidence must be readable JSON objects.',
      });
      continue;
    }
    if (isControlledPilotReviewPath(filePath)) changedReviews.set(filePath, record);
    else changedApprovals.set(filePath, record);
  }

  for (const [filePath, review] of changedReviews) {
    for (const message of validateControlledPilotReview(review)) {
      issues.push({code: 'changed_controlled_pilot_review_invalid', path: filePath, message});
    }
    const auditPath = review.source_records?.scoped_audit;
    if (!isScopedQualityAuditReportPath(auditPath) || !isRegularFileAtCommit(head, auditPath)) {
      issues.push({
        code: 'changed_controlled_pilot_review_scoped_audit_invalid',
        path: filePath,
        audit: auditPath ?? null,
        message: 'A controlled-pilot aggregate review must link one direct current scoped-audit blob at immutable HEAD.',
      });
    } else {
      const report = readChangedJson(auditPath, head);
      const replay = replayScopedAuditAtHead({base, head, scopeCardIds: review.scope?.card_ids || []});
      if (!replay.ok || !isDeepStrictEqual(report, replay.report)) {
        issues.push({
          code: 'changed_controlled_pilot_review_scoped_audit_replay_mismatch',
          path: filePath,
          audit: auditPath,
          message: replay.message || 'The controlled-pilot scoped audit must exactly match a current immutable-HEAD replay.',
        });
      }
    }
    for (const sourcePath of [
      review.source_records?.sample_confirmation,
      ...(review.source_records?.agent_self_reviews || []),
    ]) {
      if (!isRegularFileAtCommit(head, sourcePath)) {
        issues.push({
          code: 'changed_controlled_pilot_review_source_not_regular_file',
          path: filePath,
          source: sourcePath ?? null,
          message: 'Every confirmation and per-box review source must be a regular Git blob at immutable HEAD.',
        });
      }
    }
    if (review.status === 'user_approved') {
      const artifactPath = review.approval?.artifact_path;
      if (!isControlledPilotApprovalPath(artifactPath) || !changedPaths.has(artifactPath)) {
        issues.push({
          code: 'changed_controlled_pilot_review_approval_artifact_not_changed',
          path: filePath,
          artifact: artifactPath ?? null,
          message: 'An approved aggregate review and its product approval artifact must be changed together in one explicitly authorized PR.',
        });
      }
    }
  }

  for (const [filePath, artifact] of changedApprovals) {
    const matches = [...changedReviews.entries()].filter(([, review]) =>
      review.approval?.artifact_path === filePath
    );
    if (matches.length !== 1) {
      issues.push({
        code: 'changed_controlled_pilot_approval_review_missing',
        path: filePath,
        message: 'A product approval artifact requires exactly one matching changed aggregate review.',
      });
      continue;
    }
    for (const message of validateControlledPilotApproval(artifact, matches[0][1])) {
      issues.push({code: 'changed_controlled_pilot_approval_invalid', path: filePath, message});
    }
  }
  return issues;
}

function validateControlledPilotReview(review) {
  const errors = [];
  const exact120 = value => Array.isArray(value) && value.length === 120 &&
    value.every(hasText) && new Set(value).size === 120;
  if (
    review?.schema_version !== CONTROLLED_PILOT_REVIEW_SCHEMA ||
    review?.scope?.track !== 'cet4' ||
    review?.scope?.purpose !== 'controlled_pilot' ||
    review?.scope?.card_count !== 120 ||
    !exact120(review?.scope?.card_ids) ||
    !Array.isArray(review?.scope?.box_prefixes) ||
    review.scope.box_prefixes.length !== 14 ||
    new Set(review.scope.box_prefixes).size !== 14
  ) errors.push('controlled-pilot aggregate review scope is invalid');
  if (
    review?.coverage?.sample_cards !== 42 ||
    review?.coverage?.expansion_cards !== 78 ||
    review?.coverage?.reviewed_cards !== 120 ||
    !Array.isArray(review?.coverage?.boxes) ||
    review.coverage.boxes.length !== 14 ||
    !setsEqual(
      new Set(review.coverage.boxes.flatMap(box => box.reviewed_card_ids || [])),
      new Set(review?.scope?.card_ids || []),
    )
  ) errors.push('controlled-pilot aggregate review coverage is invalid');
  if (
    review?.quality?.hard_blockers !== 0 ||
    review?.quality?.content_risks !== 0 ||
    review?.quality?.review_gaps !== 0 ||
    review?.quality?.source_risks !== 120 ||
    review?.quality?.synthetic_source_cards !== 120
  ) errors.push('controlled-pilot aggregate review quality boundary is invalid');
  if (
    !SHA256_VALUE_RE.test(String(review?.content_version || '')) ||
    !SHA256_VALUE_RE.test(String(review?.source_records?.runtime_payload_sha256 || '')) ||
    !SHA256_VALUE_RE.test(String(review?.source_records?.scoped_audit_sha256 || '')) ||
    !Array.isArray(review?.source_records?.agent_self_reviews) ||
    review.source_records.agent_self_reviews.length !== 28 ||
    new Set(review.source_records.agent_self_reviews).size !== 28
  ) errors.push('controlled-pilot aggregate review source binding is invalid');
  if (
    review?.approval_boundary?.sample_confirmation_is_not_formal_approval !== true ||
    review?.approval_boundary?.audio_qc_required_separately !== true ||
    review?.approval_boundary?.pilot_release_required_separately !== true ||
    review?.approval_boundary?.gate_eligible !== false
  ) errors.push('controlled-pilot aggregate review boundary is invalid');
  if (review?.status === 'ready_for_user_approval') {
    if (
      review?.approval?.approved_by_user !== false ||
      review?.approval?.approved_at !== null ||
      review?.approval?.source !== null ||
      review?.approval?.artifact_path !== null
    ) errors.push('pending controlled-pilot review claims approval');
  } else if (review?.status === 'user_approved') {
    if (
      review?.approval?.approved_by_user !== true ||
      !TIMEZONE_ISO_RE.test(String(review?.approval?.approved_at || '')) ||
      !hasText(review?.approval?.source) ||
      !isControlledPilotApprovalPath(review?.approval?.artifact_path)
    ) errors.push('approved controlled-pilot review metadata is invalid');
  } else errors.push('controlled-pilot aggregate review status is invalid');
  return errors;
}

function validateControlledPilotApproval(artifact, review) {
  const errors = [];
  const exactKeys = [
    'approved_at', 'approved_by_user', 'card_ids', 'content_version',
    'pilot_id', 'schema_version', 'scope', 'status',
  ];
  const actualKeys = artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? Object.keys(artifact).sort()
    : [];
  if (!isDeepStrictEqual(actualKeys, exactKeys)) errors.push('controlled-pilot approval keys are not exact');
  if (
    artifact?.schema_version !== CONTROLLED_PILOT_APPROVAL_SCHEMA ||
    artifact?.scope !== 'controlled_pilot_120' ||
    artifact?.status !== 'approved' ||
    artifact?.approved_by_user !== true ||
    !TIMEZONE_ISO_RE.test(String(artifact?.approved_at || '')) ||
    !SHA256_VALUE_RE.test(String(artifact?.content_version || '')) ||
    !Array.isArray(artifact?.card_ids) || artifact.card_ids.length !== 120 ||
    new Set(artifact.card_ids).size !== 120
  ) errors.push('controlled-pilot approval shape is invalid');
  if (
    review?.status !== 'user_approved' ||
    artifact?.pilot_id !== review?.pilot_id ||
    artifact?.content_version !== review?.content_version ||
    artifact?.approved_at !== review?.approval?.approved_at ||
    !setsEqual(new Set(artifact?.card_ids || []), new Set(review?.scope?.card_ids || []))
  ) errors.push('controlled-pilot approval does not match aggregate review');
  return errors;
}

function readJsonFile(filePath) {
  return safeJsonParse(fs.readFileSync(filePath, 'utf8'));
}

function prefixesFromScope(scope = {}) {
  const prefixes = new Set();
  for (const prefix of scope.box_prefixes || []) {
    if (typeof prefix === 'string') prefixes.add(prefix);
  }
  for (const box of scope.boxes || []) {
    if (typeof box?.box_prefix === 'string') prefixes.add(box.box_prefix);
  }
  return prefixes;
}

function coversAllPrefixes(recordPrefixes, primaryPrefixes) {
  for (const prefix of primaryPrefixes) {
    if (!recordPrefixes.has(prefix)) return false;
  }
  return true;
}

function multiPrefixEvidenceRecords(entries, head, primaryPrefixes) {
  const evidence = [];

  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    if (statusType === 'D') continue;

    for (const filePath of entry.paths) {
      if (!isHandoffPath(filePath) && !isSelfReviewPath(filePath)) continue;

      const record = readChangedJson(filePath, head);
      if (!record) {
        evidence.push({
          path: filePath,
          accepted: false,
          reason: 'record_not_readable_as_json',
        });
        continue;
      }

      if (isHandoffPath(filePath)) {
        const scope = record.scope || {};
        const recordPrefixes = prefixesFromScope(scope);
        const allowedChangeType = MULTI_PREFIX_CONTENT_CHANGE_TYPES.has(scope.change_type);
        const explicitMultiPrefixUnit = scope.multi_prefix_review_unit === true &&
          typeof scope.scope_reason === 'string' &&
          scope.scope_reason.trim().length > 0;
        const accepted = coversAllPrefixes(recordPrefixes, primaryPrefixes) &&
          (allowedChangeType || explicitMultiPrefixUnit) &&
          record.merge_authority === CONTENT_NO_AUTO_MERGE_AUTHORITY;

        evidence.push({
          path: filePath,
          accepted,
          kind: 'git_handoff',
          change_type: scope.change_type || null,
          multi_prefix_review_unit: scope.multi_prefix_review_unit === true,
          prefixes: [...recordPrefixes].sort(),
          reason: accepted
            ? 'accepted_multi_prefix_handoff'
            : 'handoff_must_cover_all_prefixes_name_an_allowed_multi_prefix_scope_and_keep_content_no_auto_merge',
        });
        continue;
      }

      if (isSelfReviewPath(filePath)) {
        const samplePolicy = record.sample_policy || {};
        const recordPrefixes = prefixesFromScope(record.scope || {});
        const accepted = coversAllPrefixes(recordPrefixes, primaryPrefixes) &&
          samplePolicy.review_scope_type === 'residual_blocker_closure' &&
          samplePolicy.residual_blocker_closure === true &&
          samplePolicy.not_sample_approval === true &&
          record.batch_review?.status === 'documented_residual_closure';

        evidence.push({
          path: filePath,
          accepted,
          kind: 'agent_self_review',
          review_scope_type: samplePolicy.review_scope_type || null,
          prefixes: [...recordPrefixes].sort(),
          reason: accepted
            ? 'accepted_residual_blocker_closure_review'
            : 'self_review_must_be_documented_residual_blocker_closure_and_cover_all_prefixes',
        });
      }
    }
  }

  return evidence;
}

function isContentCandidateDiff(entries) {
  return entries.some(entry => entry.paths.some(filePath =>
    isCardBoxDirectoryPath(filePath) || isContentReviewPath(filePath)
  ));
}

function primaryScopePrefixes(entries) {
  const prefixes = new Set();

  for (const entry of entries) {
    const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
    for (const filePath of entry.paths) {
      const prefix = pathPrefix(filePath);
      if (!prefix) continue;
      if (
        isCardBoxPath(filePath) ||
        isDraftPath(filePath) ||
        isHandoffPath(filePath) ||
        isScopedAuditPath(filePath) ||
        (isSelfReviewPath(filePath) && statusType === 'A')
      ) {
        prefixes.add(prefix);
      }
    }
  }

  if (prefixes.size === 0) {
    for (const entry of entries) {
      for (const filePath of entry.paths) {
        if (isSelfReviewPath(filePath)) {
          const prefix = pathPrefix(filePath);
          if (prefix) prefixes.add(prefix);
        }
      }
    }
  }

  return prefixes;
}

function validate({ base, head }) {
  const resolvedHead = head ? resolveCommit(head) : null;
  const entries = changedEntries(base, resolvedHead);
  const issues = [];
  const warnings = [];
  const contentCandidate = isContentCandidateDiff(entries);
  const primaryPrefixes = primaryScopePrefixes(entries);
  let currentScopedAudit = null;
  let changedCardIntegrity = null;

  for (const entry of entries) {
    for (const filePath of entry.paths) {
      if (hasUnsafeGitPathCharacters(filePath)) {
        issues.push({
          code: 'git_diff_path_noncanonical',
          path: filePath,
          status: entry.status,
          message: 'Changed Git paths must not contain a literal backslash, control character, or Unicode line separator; path evidence is interpreted exactly and never rewritten.',
        });
      }
      if (filePath === PRE_CUTOVER_REPORT_INDEX) {
        issues.push({
          code: 'pre_cutover_report_index_immutable',
          path: filePath,
          status: entry.status,
          message: 'The pre-cutover report index is an immutable legacy archive boundary and must not be added, changed, deleted, or renamed by a current PR.',
        });
      }
    }
  }

  if (contentCandidate) {
    for (const entry of entries) {
      const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
      for (const filePath of entry.paths) {
        if (isNoncanonicalSelfReviewPath(filePath)) {
          issues.push({
            code: 'changed_self_review_path_noncanonical',
            path: filePath,
            status: entry.status,
            message: 'Agent self-review records must be direct JSON children of reviews/agent_self_review; nested records cannot authorize candidate coverage.',
          });
        }
        if (isNoncanonicalApprovedBatchPath(filePath)) {
          issues.push({
            code: 'changed_approval_path_noncanonical',
            path: filePath,
            status: entry.status,
            message: 'Approval records must be direct JSON children of reviews/approved_batches.',
          });
        }
        if (isNoncanonicalSampleConfirmationPath(filePath)) {
          issues.push({
            code: 'changed_sample_confirmation_path_noncanonical',
            path: filePath,
            status: entry.status,
            message: 'Sample-confirmation records must be direct JSON children of reviews/sample_confirmations.',
          });
        }
        if (isNoncanonicalControlledPilotReviewPath(filePath)) {
          issues.push({
            code: 'changed_controlled_pilot_review_path_noncanonical',
            path: filePath,
            status: entry.status,
            message: 'Controlled-pilot aggregate reviews must be direct JSON children of reviews/controlled_pilot_reviews.',
          });
        }
        if (isNoncanonicalControlledPilotApprovalPath(filePath)) {
          issues.push({
            code: 'changed_controlled_pilot_approval_path_noncanonical',
            path: filePath,
            status: entry.status,
            message: 'Controlled-pilot approval artifacts must be direct JSON children of reviews/controlled_pilot_approvals.',
          });
        }
        if (isCardBoxDirectoryPath(filePath) && !isCardBoxPath(filePath)) {
          issues.push({
            code: 'candidate_card_box_path_invalid',
            path: filePath,
            status: entry.status,
            message: 'Every file under card_boxes_json must use the canonical card_boxes_seed_<track>_<library>_<TLGB>.json path so no candidate can bypass corpus validation.',
          });
        }
      }
      const removesSelfReview = (
        statusType === 'D' && isSelfReviewPath(entry.path)
      ) || (
        statusType === 'R' &&
        isSelfReviewPath(entry.paths[0]) &&
        !isSelfReviewPath(entry.path)
      );
      if (removesSelfReview) {
        issues.push({
          code: 'changed_self_review_deleted',
          path: entry.paths[0] || entry.path,
          status: entry.status,
          message: 'Agent self-review evidence must not be deleted or renamed out of its governed directory by a candidate PR.',
        });
      }
      const removesApproval = (
        statusType === 'D' && isApprovedBatchPath(entry.path)
      ) || (
        statusType === 'R' &&
        isApprovedBatchPath(entry.paths[0]) &&
        !isApprovedBatchPath(entry.path)
      );
      if (removesApproval) {
        issues.push({
          code: 'changed_approval_deleted',
          path: entry.paths[0] || entry.path,
          status: entry.status,
          message: 'Formal approval evidence must not be deleted or renamed out of its governed directory.',
        });
      }
      const removesSampleConfirmation = (
        statusType === 'D' && isSampleConfirmationPath(entry.path)
      ) || (
        statusType === 'R' &&
        isSampleConfirmationPath(entry.paths[0]) &&
        !isSampleConfirmationPath(entry.path)
      );
      if (removesSampleConfirmation) {
        issues.push({
          code: 'changed_sample_confirmation_deleted',
          path: entry.paths[0] || entry.path,
          status: entry.status,
          message: 'Sample-confirmation evidence must not be deleted or renamed out of its governed directory.',
        });
      }
      const removesControlledPilotReview = (
        statusType === 'D' && isControlledPilotReviewPath(entry.path)
      ) || (
        statusType === 'R' &&
        isControlledPilotReviewPath(entry.paths[0]) &&
        !isControlledPilotReviewPath(entry.path)
      );
      if (removesControlledPilotReview) {
        issues.push({
          code: 'changed_controlled_pilot_review_deleted',
          path: entry.paths[0] || entry.path,
          status: entry.status,
          message: 'Controlled-pilot aggregate review evidence must not be deleted or renamed out of its governed directory.',
        });
      }
      const removesControlledPilotApproval = (
        statusType === 'D' && isControlledPilotApprovalPath(entry.path)
      ) || (
        statusType === 'R' &&
        isControlledPilotApprovalPath(entry.paths[0]) &&
        !isControlledPilotApprovalPath(entry.path)
      );
      if (removesControlledPilotApproval) {
        issues.push({
          code: 'changed_controlled_pilot_approval_deleted',
          path: entry.paths[0] || entry.path,
          status: entry.status,
          message: 'Controlled-pilot approval evidence must not be deleted or renamed out of its governed directory.',
        });
      }
    }

    if (!resolvedHead) {
      issues.push({
        code: 'content_candidate_explicit_head_required',
        message: 'Content-candidate scope validation requires --head <commit>; worktree-only mode cannot prove the complete HEAD corpus or current self-review parity.',
      });
    }

    if (resolvedHead) {
      for (const entry of entries) {
        const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
        if (statusType === 'D') continue;
        for (const filePath of entry.paths) {
          if (!isSampleConfirmationPath(filePath)) continue;
          if (!isRegularFileAtCommit(resolvedHead, filePath)) {
            issues.push({code: 'changed_sample_confirmation_not_regular_file', path: filePath, message: 'Sample-confirmation evidence must be a direct regular JSON blob at immutable HEAD.'});
            continue;
          }
          const record = readChangedJson(filePath, resolvedHead);
          issues.push(...validateSampleConfirmationSemantics(record, filePath));
        }
      }
      issues.push(...validateChangedScopedAuditReports({
        base,
        head: resolvedHead,
        entries,
      }));
      issues.push(...validateChangedReviewScopedAuditReferences({
        base,
        head: resolvedHead,
        entries,
      }));
      issues.push(...validateChangedControlledPilotRecords({
        base,
        head: resolvedHead,
        entries,
      }));
    }

    changedCardIntegrity = runChangedCardIntegrity({ base, head: resolvedHead, entries });
    issues.push(...(changedCardIntegrity.issues || []));

    for (const entry of entries) {
      for (const filePath of entry.paths) {
        if (GLOBAL_REPORT_PATHS.has(filePath)) {
          issues.push({
            code: 'content_sample_global_report_changed',
            path: filePath,
            status: entry.status,
            message: 'Content sample PRs must not carry global report refreshes; refresh reports in a merge-ordered report branch.',
          });
        }
      }
    }

    for (const entry of entries) {
      for (const filePath of entry.paths) {
        if (!isSelfReviewPath(filePath) && !isScopedAuditPath(filePath)) continue;
        const prefix = pathPrefix(filePath);
        if (prefix && primaryPrefixes.size > 0 && !primaryPrefixes.has(prefix)) {
          issues.push({
            code: isScopedAuditPath(filePath)
              ? 'content_sample_non_scope_scoped_audit_changed'
              : 'content_sample_non_scope_self_review_changed',
            path: filePath,
            status: entry.status,
            prefix,
            allowed_prefixes: [...primaryPrefixes].sort(),
            message: 'Content sample PRs must not refresh self-review records outside the current box scope.',
          });
        }
      }
    }

    if (primaryPrefixes.size > 1) {
      const evidence = multiPrefixEvidenceRecords(entries, resolvedHead, primaryPrefixes);
      const acceptedEvidence = evidence.filter(record => record.accepted);
      if (acceptedEvidence.length === 0) {
        issues.push({
          code: 'content_sample_multiple_scope_prefixes_missing_evidence',
          prefixes: [...primaryPrefixes].sort(),
          evidence,
          message: 'Multi-prefix content PRs must include explicit changed handoff or residual-closure evidence; a warning is not enough to prove a single review unit.',
        });
      } else {
        warnings.push({
          code: 'content_sample_multiple_scope_prefixes_documented',
          prefixes: [...primaryPrefixes].sort(),
          evidence: acceptedEvidence,
          message: 'Multiple box prefixes changed and are documented by explicit multi-prefix content evidence.',
        });
      }
    }

    const changedCardIds = changedCardIntegrity?.changed_card_ids || [];
    currentScopedAudit = changedCardIds.length > 0
      ? runCurrentScopedAudit({ base, head: resolvedHead, entries })
      : {skipped: true, reason: 'no_added_or_modified_card_objects'};
    if (currentScopedAudit?.ok === false) {
      issues.push({
        code: currentScopedAudit.code || 'content_sample_current_audit_scope_hard_blockers',
        card_ids: currentScopedAudit.card_ids || [],
        changed_card_box_paths: currentScopedAudit.changed_card_box_paths || [],
        scope_summary: currentScopedAudit.scope_summary || null,
        scoped_hard_blocker_issues: currentScopedAudit.scoped_hard_blocker_issues || [],
        message: currentScopedAudit.message || 'Content sample PRs must pass the current scoped card-quality audit; stale scoped audit evidence generated under older rules is not enough.',
      });
    }
  }

  return {
    ok: issues.length === 0,
    base,
    head,
    resolved_head: resolvedHead,
    content_candidate_diff: contentCandidate,
    primary_scope_prefixes: [...primaryPrefixes].sort(),
    changed_paths: entries.map(entry => ({
      status: entry.status,
      paths: entry.paths,
    })),
    current_scoped_audit: currentScopedAudit,
    changed_card_integrity: changedCardIntegrity,
    issues,
    warnings,
  };
}

const base = readOption('--base', DEFAULT_BASE);
const head = readOption('--head', null);

try {
  const result = validate({ base, head });
  result.head = head || 'WORKTREE';
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    base,
    head: head || 'WORKTREE',
    error: error.message,
  }, null, 2));
  process.exit(1);
}
