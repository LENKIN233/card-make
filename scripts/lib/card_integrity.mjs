import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

import {
  buildContentAuthorizationAdditionalBindings,
  buildModelAcceptanceInputSha256,
  deriveRuntimePayloadContentIdentity,
  isLegacyV1HumanAuthorityRecord,
  MODEL_ACCEPTANCE_SCHEMA,
  validateIndependentModelAcceptances,
  validateModelAcceptance,
} from './model_acceptance.mjs';

const REVIEW_STATUS_PARITY_EXCEPTION = Object.freeze({
  excluded_fields: ['review_status'],
  reason: 'card_authoring_status_and_self_review_snapshot_status_are_distinct; both remain independently schema-validated',
});
const CURRENT_APPROVAL_BLOCKER_FIELDS = [
  'logic_error',
  'language_error',
  'inappropriate_wording',
  'low_knowledge_density',
  'not_meeting_requirement',
  'reverse_engineered_front',
  'fake_source_claim',
  'low_quality_variation',
];

export function isHumanReviewerIdentity(value) {
  if (typeof value !== 'string') return false;
  const match = /^(?:github|team|external):(.+)$/u.exec(value);
  if (!match) return false;
  const reviewerId = match[1];
  if (
    Array.from(reviewerId).length > 64 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._@-]{0,63}$/u.test(reviewerId)
  ) {
    return false;
  }
  if (/(?:agent|bot|codex|automation)/iu.test(reviewerId)) return false;
  if (
    /(?:^|[._@-])ci(?:$|[._@-]|\d)/iu.test(reviewerId) ||
    /^ci(?:build|runner|job|pipeline|workflow)/iu.test(reviewerId)
  ) {
    return false;
  }
  return true;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasUniqueNonEmptyTextArray(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(hasText) &&
    new Set(value).size === value.length;
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return new Set(left).size === left.length && left.every(value => rightSet.has(value));
}

export function validateModelOwnedFullTrackReviewShape(
  review,
  {expectedBoxPrefixes = review?.scope?.box_prefixes, expectedCardIds = review?.scope?.card_ids} = {},
) {
  const issues = [];
  const add = code => issues.push({code});
  if (review?.schema_version !== 'model-owned-full-track-review.v2') {
    add('model_full_track_review_schema_invalid');
    return {issues, ok: false};
  }
  if (
    review.batch_review?.status !== 'ready_for_model_authorization' ||
    !hasText(review.batch_review?.summary) ||
    !hasText(review.batch_review?.next_step) ||
    !Array.isArray(review.batch_review?.remaining_risks) ||
    review.batch_review.remaining_risks.length !== 0
  ) add('model_full_track_review_batch_invalid');
  if (
    review.coverage?.expected_card_count !== expectedCardIds?.length ||
    !sameStringSet(review.coverage?.reviewed_card_ids, expectedCardIds)
  ) add('model_full_track_review_coverage_invalid');
  for (const field of [
    'answer_matches_card',
    'choice_or_bank_references_match_source',
    'distractor_labels_match_explanations',
  ]) {
    if (review.coverage?.analysis_reference_check?.[field] !== true) {
      issues.push({code: 'model_full_track_review_reference_check_invalid', field});
    }
  }
  const boxes = review.coverage?.boxes;
  if (
    !Array.isArray(boxes) ||
    !sameStringSet(boxes.map(box => box?.box_prefix), expectedBoxPrefixes) ||
    boxes.some(box => box?.status !== 'pass')
  ) add('model_full_track_review_boxes_invalid');
  if (
    !hasUniqueNonEmptyTextArray(review.representative_cards) ||
    !review.representative_cards.every(cardId => expectedCardIds?.includes(cardId))
  ) add('model_full_track_review_representatives_invalid');
  return {issues, ok: issues.length === 0};
}

function isDirectGovernedJsonPath(value, directory, templatePaths = []) {
  if (!hasText(value) || value.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return false;
  if (templatePaths.includes(value)) return false;
  if (path.posix.dirname(value) !== directory) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}._@-]*\.json$/u.test(
    path.posix.basename(value),
  );
}

export function isDirectApprovalRecordPath(value) {
  return isDirectGovernedJsonPath(
    value,
    'reviews/approved_batches',
    [
      'reviews/approved_batches/TEMPLATE.json',
      'reviews/approved_batches/FULL_TRACK_TEMPLATE.json',
    ],
  );
}

export function isDirectSelfReviewRecordPath(value) {
  return isDirectGovernedJsonPath(
    value,
    'reviews/agent_self_review',
    [
      'reviews/agent_self_review/TEMPLATE.json',
      'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
    ],
  );
}

export function isDirectScopedAuditRecordPath(value) {
  return isDirectGovernedJsonPath(value, 'reviews/audit_scopes');
}

export function isDirectRuntimePayloadPath(value) {
  return isDirectGovernedJsonPath(value, 'reviews/runtime_payloads');
}

export function computeCardCorpusFingerprint(root) {
  const cardDir = path.join(root, 'card_boxes_json');
  const files = fs.readdirSync(cardDir)
    .filter(file => file.endsWith('.json'))
    .sort();
  const hash = crypto.createHash('sha256');
  let cardCount = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(cardDir, file));
    hash.update(file);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
    const payload = JSON.parse(bytes.toString('utf8'));
    if (Array.isArray(payload.cards)) cardCount += payload.cards.length;
  }
  return {
    algorithm: 'sha256',
    card_dir: 'card_boxes_json',
    file_count: files.length,
    card_count: cardCount,
    digest: hash.digest('hex'),
  };
}

const currentAuditReportCache = new Map();

function loadCurrentCardQualityAudit(
  root,
  fingerprint,
  {
    requireCommittedAuthority = true,
    headRevision = 'HEAD',
    authoritySnapshots = null,
  } = {},
) {
  const auditScript = path.join(root, 'scripts', 'audit_card_quality.mjs');
  const auditSpec = path.join(root, 'spec', 'card-quality-audit.json');
  const authorities = [
    ['scripts/audit_card_quality.mjs', auditScript],
    ['spec/card-quality-audit.json', auditSpec],
  ].map(([relativePath, absolutePath]) => {
    const stats = fs.lstatSync(absolutePath);
    if (!stats.isFile()) {
      throw new Error(
        `current card-quality audit authority is not a regular file: ${relativePath}`,
      );
    }
    const bytes = fs.readFileSync(absolutePath);
    const mode = (stats.mode & 0o111) === 0 ? '100644' : '100755';
    authoritySnapshots?.set(relativePath, {bytes, mode});
    if (requireCommittedAuthority) {
      const gitState = committedGitFileState(
        root,
        relativePath,
        bytes,
        mode,
        headRevision,
      );
      if (!gitState.tracked || !gitState.committed) {
        throw new Error(
          `current card-quality audit authority is not committed at HEAD: ${relativePath}`,
        );
      }
    }
    return {relativePath, bytes, mode};
  });
  if (
    !isDeepStrictEqual(computeCardCorpusFingerprint(root), fingerprint)
  ) {
    throw new Error('card corpus changed before current audit replay');
  }
  const cacheKey = [
    path.resolve(root),
    fingerprint.digest,
    ...authorities.map(authority =>
      crypto
        .createHash('sha256')
        .update(authority.mode)
        .update('\0')
        .update(authority.bytes)
        .digest('hex')
    ),
  ].join('\0');
  if (currentAuditReportCache.has(cacheKey)) {
    if (
      !isDeepStrictEqual(computeCardCorpusFingerprint(root), fingerprint)
    ) {
      throw new Error('card corpus changed during cached audit replay');
    }
    return currentAuditReportCache.get(cacheKey);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-current-audit-'));
  const reportPath = path.join(tempDir, 'card_quality_audit_report.json');
  try {
    execFileSync(
      process.execPath,
      [auditScript, '--report-path', reportPath],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const report = readJson(reportPath);
    const policy = readJson(auditSpec);
    const policyRules = Array.isArray(policy.rules) ? policy.rules : [];
    const policyRuleIds = policyRules.map(rule => rule?.id);
    const reportRuleIds = Object.keys(report.summary?.by_rule || {});
    const cardIssueEntries = Object.entries(report.card_issue_index || {});
    if (
      report.ok !== true ||
      policy.status !== 'active' ||
      report.audit_version !== policy.version ||
      report.mode !== policy.mode ||
      !isDeepStrictEqual(report.corpus_fingerprint, fingerprint) ||
      report.scope?.card_dir !== 'card_boxes_json' ||
      report.scope?.files !== fingerprint.file_count ||
      report.scope?.cards !== fingerprint.card_count ||
      report.summary?.total_files !== fingerprint.file_count ||
      report.summary?.total_cards !== fingerprint.card_count ||
      !hasUniqueNonEmptyTextArray(policyRuleIds) ||
      !sameStringSet(reportRuleIds, policyRuleIds) ||
      policyRules.some(rule =>
        !Number.isInteger(report.summary?.by_rule?.[rule.id]?.count) ||
        report.summary.by_rule[rule.id].count < 0 ||
        report.summary.by_rule[rule.id].severity !== rule.severity
      ) ||
      !report.card_issue_index ||
      typeof report.card_issue_index !== 'object' ||
      Array.isArray(report.card_issue_index) ||
      cardIssueEntries.length !== fingerprint.card_count ||
      cardIssueEntries.some(([cardId, entry]) =>
        entry?.card_id !== cardId ||
        !Number.isInteger(entry?.issue_count) ||
        entry.issue_count < 0 ||
        !entry.by_severity ||
        typeof entry.by_severity !== 'object' ||
        Array.isArray(entry.by_severity) ||
        Object.values(entry.by_severity).some(
          count => !Number.isInteger(count) || count < 0,
        ) ||
        !entry.by_rule ||
        typeof entry.by_rule !== 'object' ||
        Array.isArray(entry.by_rule) ||
        Object.values(entry.by_rule).some(
          count => !Number.isInteger(count) || count < 0,
        )
      ) ||
      !Array.isArray(report.hard_blocker_issues)
    ) {
      throw new Error('current card-quality audit replay is structurally invalid');
    }
    if (
      !isDeepStrictEqual(computeCardCorpusFingerprint(root), fingerprint)
    ) {
      throw new Error('card corpus changed during current audit replay');
    }
    currentAuditReportCache.set(cacheKey, report);
    return report;
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
}

function numericCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function emptyAuditSeverityCounts() {
  return {
    hard_blocker: 0,
    content_risk: 0,
    review_gap: 0,
    source_risk: 0,
  };
}

function buildCurrentScopedAuditReplay(currentAudit, scopeCardIds) {
  const cardIds = [...new Set(
    (scopeCardIds || []).map(value => String(value).trim()).filter(Boolean),
  )].sort();
  const ruleIds = Object.keys(currentAudit.summary?.by_rule || {}).sort();
  const scopedCardIssueIndex = {};
  const missingCardIds = [];
  const scopedIds = new Set(cardIds);
  const scopeSummary = {
    card_ids: cardIds,
    card_count: cardIds.length,
    issue_count: 0,
    by_severity: emptyAuditSeverityCounts(),
    by_rule: Object.fromEntries(ruleIds.map(ruleId => [ruleId, 0])),
  };

  for (const cardId of cardIds) {
    const record = currentAudit.card_issue_index?.[cardId];
    if (!record) {
      missingCardIds.push(cardId);
      continue;
    }
    scopedCardIssueIndex[cardId] = record;
    scopeSummary.issue_count += numericCount(record.issue_count);
    for (const severity of Object.keys(scopeSummary.by_severity)) {
      scopeSummary.by_severity[severity] += numericCount(
        record.by_severity?.[severity],
      );
    }
    for (const ruleId of ruleIds) {
      scopeSummary.by_rule[ruleId] += numericCount(record.by_rule?.[ruleId]);
    }
  }

  const scopedHardBlockers = currentAudit.hard_blocker_issues
    .filter(issue => scopedIds.has(issue.card_id));
  return {
    ok: missingCardIds.length === 0 && scopedHardBlockers.length === 0,
    audit_version: currentAudit.audit_version,
    mode: currentAudit.mode,
    report_type: 'scoped_card_quality_audit',
    corpus_fingerprint: currentAudit.corpus_fingerprint,
    scope: {
      card_dir: currentAudit.scope.card_dir,
      card_ids: cardIds,
      missing_card_ids: missingCardIds,
    },
    scope_summary: scopeSummary,
    scoped_card_issue_index: scopedCardIssueIndex,
    scoped_hard_blocker_issues: scopedHardBlockers,
  };
}

function parseExactGitEntry(output, relativePath, kind) {
  const entries = output.split('\0').filter(Boolean);
  if (entries.length !== 1) return null;
  const separator = entries[0].indexOf('\t');
  if (separator < 0 || entries[0].slice(separator + 1) !== relativePath) {
    return null;
  }
  const fields = entries[0].slice(0, separator).split(' ');
  if (kind === 'index') {
    const [mode, objectId, stage] = fields;
    if (
      !['100644', '100755'].includes(mode) ||
      !/^[0-9a-f]{40}$/.test(objectId || '') ||
      stage !== '0'
    ) {
      return null;
    }
    return {mode, objectId};
  }
  const [mode, type, objectId] = fields;
  if (
    !['100644', '100755'].includes(mode) ||
    type !== 'blob' ||
    !/^[0-9a-f]{40}$/.test(objectId || '')
  ) {
    return null;
  }
  return {mode, objectId};
}

function captureGitAuthorizationSnapshot(root) {
  const headCommit = execFileSync(
    'git',
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    {cwd: root, encoding: 'utf8'},
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(headCommit)) {
    throw new Error('authorization HEAD commit is invalid');
  }
  const indexBytes = execFileSync(
    'git',
    ['ls-files', '--stage', '-z'],
    {cwd: root, maxBuffer: 50 * 1024 * 1024},
  );
  return {
    headCommit,
    indexDigest: crypto
      .createHash('sha256')
      .update(indexBytes)
      .digest('hex'),
  };
}

function committedGitFileState(
  root,
  relativePath,
  worktreeBytes,
  worktreeMode,
  headRevision = 'HEAD',
) {
  let indexEntry = null;
  let headEntry = null;
  try {
    indexEntry = parseExactGitEntry(
      execFileSync(
        'git',
        ['ls-files', '--stage', '-z', '--error-unmatch', '--', relativePath],
        {cwd: root, encoding: 'utf8'},
      ),
      relativePath,
      'index',
    );
  } catch {
    indexEntry = null;
  }
  try {
    headEntry = parseExactGitEntry(
      execFileSync(
        'git',
        ['ls-tree', '-z', headRevision, '--', relativePath],
        {cwd: root, encoding: 'utf8'},
      ),
      relativePath,
      'head',
    );
  } catch {
    headEntry = null;
  }
  if (!indexEntry || !headEntry) {
    return {
      tracked: indexEntry !== null,
      committed: false,
      worktree_mode: worktreeMode,
      index_mode: indexEntry?.mode || null,
      head_mode: headEntry?.mode || null,
    };
  }
  try {
    const headBytes = execFileSync(
      'git',
      ['cat-file', 'blob', headEntry.objectId],
      {cwd: root, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024},
    );
    return {
      tracked: true,
      committed:
        indexEntry.mode === headEntry.mode &&
        worktreeMode === headEntry.mode &&
        indexEntry.objectId === headEntry.objectId &&
        Buffer.isBuffer(worktreeBytes) &&
        worktreeBytes.equals(headBytes),
      worktree_mode: worktreeMode,
      index_mode: indexEntry.mode,
      head_mode: headEntry.mode,
    };
  } catch {
    return {
      tracked: true,
      committed: false,
      worktree_mode: worktreeMode,
      index_mode: indexEntry.mode,
      head_mode: headEntry.mode,
    };
  }
}

/**
 * Validates whether an immutable approval record can authorize the current
 * corpus. Historical records remain valid archive evidence. Current
 * authorization additionally requires committed worktree/index/HEAD-identical
 * approval, linked-review, and scoped-audit evidence plus exact replay of the
 * complete current card-quality audit.
 */
export function validateCurrentApprovalRecordReference({
  root,
  approvalPath,
  expectedCardIds = null,
  expectedBoxPrefixes = null,
  currentFingerprint = null,
  requireTracked = true,
  beforeFinalConsistencyCheck = null,
}) {
  const issues = [];
  const recordBytesByPath = new Map();
  const authorizationFileSnapshots = new Map();
  const add = (code, details = {}) => issues.push({code, ...details});
  let validationGitSnapshot = null;
  if (requireTracked) {
    try {
      validationGitSnapshot = captureGitAuthorizationSnapshot(root);
    } catch (error) {
      add('approval_git_snapshot_unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const checkRecordFile = (relativePath, validator, codePrefix) => {
    if (!validator(relativePath)) {
      add(`${codePrefix}_path_invalid`, {path: relativePath});
      return null;
    }
    let worktreeStats;
    try {
      worktreeStats = fs.lstatSync(path.join(root, relativePath));
    } catch {
      worktreeStats = null;
    }
    if (!worktreeStats?.isFile()) {
      add(`${codePrefix}_not_regular_file`, {path: relativePath});
      return null;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(root, relativePath));
    } catch {
      add(`${codePrefix}_unreadable`, {path: relativePath});
      return null;
    }
    recordBytesByPath.set(relativePath, bytes);
    const worktreeMode =
      (worktreeStats.mode & 0o111) === 0
        ? '100644'
        : '100755';
    authorizationFileSnapshots.set(relativePath, {
      bytes,
      mode: worktreeMode,
    });
    if (requireTracked) {
      const gitState = committedGitFileState(
        root,
        relativePath,
        bytes,
        worktreeMode,
        validationGitSnapshot?.headCommit || 'HEAD',
      );
      if (!gitState.tracked) {
        add(`${codePrefix}_not_tracked`, {path: relativePath});
      }
      if (!gitState.committed) {
        add(`${codePrefix}_not_committed_at_head`, {
          path: relativePath,
          worktree_mode: gitState.worktree_mode,
          index_mode: gitState.index_mode,
          head_mode: gitState.head_mode,
        });
      }
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      add(`${codePrefix}_unreadable`, {path: relativePath});
      return null;
    }
  };

  const approval = checkRecordFile(
    approvalPath,
    isDirectApprovalRecordPath,
    'approval_record',
  );
  if (!approval) return {ok: false, issues};
  const isModelOwned =
    approval.schema_version === 'model-owned-content-authorization.v2';
  const isFullTrackFinal = isModelOwned
    ? approval.authorization_mode === 'full_track'
    : approval.approval_mode === 'full_track_final';
  let authorizationAdditionalBindings = {};
  if (isModelOwned) {
    try {
      authorizationAdditionalBindings =
        buildContentAuthorizationAdditionalBindings({
          authorizationMode: approval.authorization_mode,
          contentVersion: approval.content_version,
        });
    } catch (error) {
      authorizationAdditionalBindings = null;
      add('approval_record_content_version_invalid', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (isModelOwned) {
    if (isLegacyV1HumanAuthorityRecord(approval)) {
      add('approval_record_person_authority_field_forbidden');
    }
    if (isFullTrackFinal) {
      const runtimePayloadPath = approval.validation?.runtime_payload;
      const runtimePayload = checkRecordFile(
        runtimePayloadPath,
        isDirectRuntimePayloadPath,
        'approval_runtime_payload',
      );
      const runtimePayloadBytes = recordBytesByPath.get(runtimePayloadPath);
      const runtimePayloadSha256 = runtimePayloadBytes
        ? `sha256:${crypto.createHash('sha256').update(runtimePayloadBytes).digest('hex')}`
        : null;
      if (
        runtimePayloadSha256 !== null &&
        approval.validation?.runtime_payload_sha256 !== runtimePayloadSha256
      ) {
        add('approval_runtime_payload_hash_mismatch');
      }
      if (runtimePayload) {
        try {
          const runtimeIdentity = deriveRuntimePayloadContentIdentity(
            runtimePayload,
          );
          if (
            runtimeIdentity.content_version !== approval.content_version ||
            runtimeIdentity.track !== approval.scope?.track ||
            !sameStringSet(
              runtimeIdentity.card_ids,
              approval.scope?.card_ids,
            )
          ) {
            add('approval_runtime_payload_identity_mismatch');
          }
        } catch (error) {
          add('approval_runtime_payload_invalid', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const acceptanceIssues = isFullTrackFinal
      ? validateIndependentModelAcceptances(approval.model_acceptances, {
          requiredCapabilities: ['content_authorization'],
        })
      : validateModelAcceptance(approval.model_acceptance, {
          requireAccepted: true,
          requiredCapabilities: ['content_authorization'],
        });
    for (const issue of acceptanceIssues) {
      add(issue.code, issue);
    }
    if (!hasText(approval.authorization_id)) {
      add('approval_record_id_missing');
    }
  } else {
    add('approval_record_legacy_archive_only', {
      schema_version: approval.schema_version ?? null,
      message: `${MODEL_ACCEPTANCE_SCHEMA} is required for current authorization`,
    });
    if (!hasText(approval.approval_id)) add('approval_record_id_missing');
    return {ok: false, issues};
  }
  const authorizationTime = isModelOwned
    ? approval.authorized_at
    : approval.approved_at;
  if (
    !hasText(authorizationTime) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      authorizationTime,
    ) ||
    Number.isNaN(Date.parse(authorizationTime))
  ) {
    add('approval_record_approved_at_invalid');
  }
  if (!hasText(approval.summary)) add('approval_record_summary_missing');
  if (!hasUniqueNonEmptyTextArray(approval.scope?.card_ids)) {
    add('approval_record_card_scope_invalid');
  }
  if (!hasUniqueNonEmptyTextArray(approval.scope?.box_prefixes)) {
    add('approval_record_box_scope_invalid');
  }
  if (
    expectedCardIds &&
    !sameStringSet(approval.scope?.card_ids, expectedCardIds)
  ) {
    add('approval_record_card_scope_mismatch');
  }
  if (
    expectedBoxPrefixes &&
    !sameStringSet(approval.scope?.box_prefixes, expectedBoxPrefixes)
  ) {
    add('approval_record_box_scope_mismatch');
  }
  if (isFullTrackFinal || isModelOwned) {
    if (!['cet4', 'cet6'].includes(approval.scope?.track)) {
      add('approval_record_track_invalid');
    }
  } else {
    for (const field of ['library', 'group', 'box']) {
      if (!hasText(approval.scope?.[field])) {
        add('approval_record_scope_field_missing', {field});
      }
    }
  }
  if (
    !hasUniqueNonEmptyTextArray(approval.representative_cards) ||
    !approval.representative_cards.every(cardId =>
      approval.scope?.card_ids?.includes(cardId)
    )
  ) {
    add('approval_record_representative_cards_invalid');
  }
  if (
    !Array.isArray(
      isModelOwned ? approval.authorization_limits : approval.approval_limits,
    ) ||
    (isModelOwned ? approval.authorization_limits : approval.approval_limits).length < 3 ||
    !(isModelOwned ? approval.authorization_limits : approval.approval_limits).every(hasText)
  ) {
    add('approval_record_limits_invalid');
  }
  for (const field of ['harness', 'cards', 'card_quality_audit']) {
    if (!hasText(approval.validation?.[field])) {
      add('approval_record_validation_missing', {field});
    }
  }
  if (!isModelOwned && approval.validation?.card_quality_audit_report !==
    'reports/card_quality_audit_report.json') {
    add('approval_record_validation_report_invalid');
  }

  const auditRecord = approval.card_quality_audit;
  const auditReport = checkRecordFile(
    auditRecord?.report,
    isDirectScopedAuditRecordPath,
    'approval_audit_report',
  );
  const computedFingerprint = computeCardCorpusFingerprint(root);
  if (
    currentFingerprint &&
    !isDeepStrictEqual(currentFingerprint, computedFingerprint)
  ) {
    add('approval_current_fingerprint_override_mismatch');
  }
  const activeFingerprint = computedFingerprint;
  let currentAudit = null;
  if (typeof beforeFinalConsistencyCheck === 'function') {
    try {
      beforeFinalConsistencyCheck();
    } catch (error) {
      add('approval_final_consistency_hook_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    currentAudit = loadCurrentCardQualityAudit(root, activeFingerprint, {
      requireCommittedAuthority: requireTracked,
      headRevision: validationGitSnapshot?.headCommit || 'HEAD',
      authoritySnapshots: authorizationFileSnapshots,
    });
  } catch (error) {
    add('approval_current_audit_replay_unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const currentCardEntries = [];
  try {
    const cardDir = path.join(root, 'card_boxes_json');
    for (const file of fs.readdirSync(cardDir)
      .filter(name => name.endsWith('.json'))
      .sort()) {
      const payload = readJson(path.join(cardDir, file));
      for (const card of payload.cards || []) {
        currentCardEntries.push({
          card,
          path: `card_boxes_json/${file}`,
        });
      }
    }
  } catch {
    add('approval_current_corpus_unreadable');
  }
  const currentScopeEntries = [];
  for (const cardId of approval.scope?.card_ids || []) {
    const matches = currentCardEntries.filter(entry => entry.card?.card_id === cardId);
    if (matches.length !== 1) {
      add('approval_current_corpus_card_identity_invalid', {
        card_id: cardId,
        matches: matches.length,
      });
    } else {
      currentScopeEntries.push(matches[0]);
    }
  }
  if (auditReport) {
    if (
      currentAudit &&
      !isDeepStrictEqual(
        auditReport,
        buildCurrentScopedAuditReplay(
          currentAudit,
          approval.scope?.card_ids,
        ),
      )
    ) {
      add('approval_audit_report_replay_mismatch');
    }
    const reportDigest = auditReport.corpus_fingerprint?.digest;
    if (
      !hasText(auditRecord?.corpus_fingerprint) ||
      auditRecord.corpus_fingerprint !== reportDigest
    ) {
      add('approval_audit_record_fingerprint_mismatch');
    }
    if (reportDigest !== activeFingerprint.digest) {
      add('approval_audit_report_not_current');
    }
    if (auditReport.report_type !== 'scoped_card_quality_audit') {
      add('approval_audit_report_type_invalid');
    }
    if (!sameStringSet(auditReport.scope?.card_ids, approval.scope?.card_ids)) {
      add('approval_audit_report_scope_mismatch');
    }
    if (
      !isDeepStrictEqual(auditRecord?.scope_summary, auditReport.scope_summary)
    ) {
      add('approval_audit_record_summary_mismatch');
    }
    if (
      !sameStringSet(
        auditRecord?.scope_summary?.card_ids,
        approval.scope?.card_ids,
      ) ||
      auditRecord?.scope_summary?.card_count !== approval.scope?.card_ids?.length
    ) {
      add('approval_audit_record_scope_summary_invalid');
    }
    if (
      auditRecord?.scope_has_no_hard_blockers !== true ||
      auditReport.ok !== true ||
      (auditReport.scope?.missing_card_ids || []).length !== 0 ||
      auditReport.scope_summary?.by_severity?.hard_blocker !== 0 ||
      (auditReport.scoped_hard_blocker_issues || []).length !== 0
    ) {
      add('approval_audit_scope_not_clear');
    }
    if (isFullTrackFinal || isModelOwned) {
      const expectedHash = `sha256:${crypto
        .createHash('sha256')
        .update(recordBytesByPath.get(auditRecord.report))
        .digest('hex')}`;
      if (auditRecord.report_sha256 !== expectedHash) {
        add('approval_audit_report_hash_mismatch');
      }
    }
  }

  const linkedReviewPath = isModelOwned
    ? approval.validation?.model_review
    : approval.validation?.agent_self_review;
  const linkedReview = checkRecordFile(
    linkedReviewPath,
    isDirectSelfReviewRecordPath,
    'approval_linked_self_review',
  );
  if (linkedReview) {
    const linkedReviewSha256 = `sha256:${crypto
      .createHash('sha256')
      .update(recordBytesByPath.get(linkedReviewPath))
      .digest('hex')}`;
    if (
      isModelOwned &&
      approval.validation?.model_review_sha256 !== linkedReviewSha256
    ) {
      add('approval_linked_model_review_hash_mismatch');
    }
    if (
      isModelOwned &&
      auditReport &&
      authorizationAdditionalBindings !== null
    ) {
      const auditSha256 = `sha256:${crypto
        .createHash('sha256')
        .update(recordBytesByPath.get(auditRecord.report))
        .digest('hex')}`;
      let expectedAcceptanceInput = null;
      try {
        expectedAcceptanceInput = buildModelAcceptanceInputSha256({
          decisionType: isFullTrackFinal
            ? 'full_track_content_authorization'
            : 'content_authorization',
          scope: approval.scope,
          corpusFingerprint: activeFingerprint.digest,
          auditSha256,
          linkedReviewIdentity: {
            path: linkedReviewPath,
            sha256: linkedReviewSha256,
          },
          additionalBindings: authorizationAdditionalBindings,
        });
      } catch (error) {
        add('model_acceptance_input_contract_invalid', {message: error.message});
      }
      const acceptances = isFullTrackFinal
        ? approval.model_acceptances || []
        : [approval.model_acceptance];
      if (
        expectedAcceptanceInput &&
        acceptances.some(acceptance =>
          acceptance?.evidence?.input_sha256 !== expectedAcceptanceInput
        )
      ) {
        add('model_acceptance_input_scope_mismatch', {
          expected: expectedAcceptanceInput,
        });
      }
    }
    const linkedReviewIsModelOwned = [
      'model-owned-card-review.v2',
      'model-owned-full-track-review.v2',
    ].includes(linkedReview.schema_version);
    if (isModelOwned) {
      if (!linkedReviewIsModelOwned) {
        add('approval_linked_self_review_legacy_archive_only');
      } else {
        const linkedAcceptanceIssues =
          linkedReview.schema_version === 'model-owned-full-track-review.v2'
            ? validateIndependentModelAcceptances(
                linkedReview.model_acceptances,
                {
                  requiredCapabilities: [
                    'card_semantic_review',
                    'source_provenance_review',
                  ],
                },
              )
            : validateModelAcceptance(linkedReview.model_acceptance, {
                requireAccepted: true,
                requiredCapabilities: [
                  'card_semantic_review',
                  'source_provenance_review',
                ],
              });
        for (const issue of linkedAcceptanceIssues) {
          add(`approval_linked_${issue.code}`, issue);
        }
      }
    }
    if (!hasText(linkedReview.review_id)) {
      add('approval_linked_self_review_id_missing');
    }
    if (
      !hasText(linkedReview.created_at) ||
      Number.isNaN(Date.parse(linkedReview.created_at))
    ) {
      add('approval_linked_self_review_created_at_invalid');
    }
    if (
      !Array.isArray(linkedReview.specs_read) ||
      linkedReview.specs_read.length === 0 ||
      !linkedReview.specs_read.every(hasText)
    ) {
      add('approval_linked_self_review_specs_missing');
    }
    if (!sameStringSet(linkedReview.scope?.card_ids, approval.scope?.card_ids)) {
      add('approval_linked_self_review_card_scope_mismatch');
    }
    if (!sameStringSet(
      linkedReview.scope?.box_prefixes,
      approval.scope?.box_prefixes,
    )) {
      add('approval_linked_self_review_box_scope_mismatch');
    }
    for (const field of (isFullTrackFinal || isModelOwned)
      ? ['track']
      : ['library', 'group', 'box']) {
      if (linkedReview.scope?.[field] !== approval.scope?.[field]) {
        add('approval_linked_self_review_scalar_scope_mismatch', {field});
      }
    }
    if (isModelOwned) {
      const fullTrackReview =
        linkedReview.schema_version === 'model-owned-full-track-review.v2';
      if (isFullTrackFinal !== fullTrackReview) {
        add('approval_linked_model_review_mode_mismatch');
      }
      if (fullTrackReview) {
        const shape = validateModelOwnedFullTrackReviewShape(linkedReview, {
          expectedBoxPrefixes: approval.scope?.box_prefixes,
          expectedCardIds: approval.scope?.card_ids,
        });
        for (const issue of shape.issues) {
          add(`approval_linked_${issue.code}`, issue);
        }
      }
      if (
        !fullTrackReview &&
        linkedReview.batch_review?.status !== 'model_accepted'
      ) {
        add('approval_linked_standard_review_batch_invalid');
      }
      const reviewedIds = fullTrackReview
        ? linkedReview.coverage?.reviewed_card_ids
        : (linkedReview.cards || []).map(card => card?.card_id);
      if (!sameStringSet(reviewedIds, approval.scope?.card_ids)) {
        add('approval_linked_model_review_coverage_invalid');
      }
      if (!fullTrackReview) {
        const cards = Array.isArray(linkedReview.cards)
          ? linkedReview.cards
          : [];
        const requiredMetadataFields = [
          'main_training_goal',
          'weak_point_tags',
          'difficulty',
          'card_prototype',
          'material',
          'exam_value',
          'box_progression_role',
          'review_status',
        ];
        if (cards.some(card =>
          card?.status !== 'pass' ||
          !card?.quality_metadata ||
          !card?.blocker_scan ||
          CURRENT_APPROVAL_BLOCKER_FIELDS.some(
            field => card.blocker_scan?.[field] !== false,
          )
        )) {
          add('approval_linked_standard_review_cards_invalid');
        }
        for (const currentEntry of currentScopeEntries) {
          const snapshot = cards.find(
            card => card?.card_id === currentEntry.card.card_id,
          );
          if (
            !snapshot ||
            snapshot.interaction_id !== currentEntry.card.interaction_id ||
            !isDeepStrictEqual(
              snapshot.knowledge_ref,
              currentEntry.card.knowledge_ref,
            ) ||
            requiredMetadataFields.some(
              field => !hasOwn(snapshot.quality_metadata, field),
            ) ||
            requiredMetadataFields.some(
              field => !hasOwn(currentEntry.card?.quality_metadata, field),
            ) ||
            !deepEqualQualityMetadata(
              currentEntry.card.quality_metadata,
              snapshot.quality_metadata,
            )
          ) {
            add('approval_linked_standard_review_current_corpus_mismatch', {
              card_id: currentEntry.card.card_id,
            });
          }
        }
      }
      if (
        Array.isArray(linkedReview.removed_cards) &&
        linkedReview.removed_cards.length > 0
      ) {
        add('approval_linked_review_contains_unresolved_removals');
      }
    } else if (isFullTrackFinal) {
      if (
        linkedReview.sample_policy?.review_scope_type !==
          'full_track_remediation' ||
        linkedReview.sample_policy?.is_three_card_sample_per_box !== false ||
        linkedReview.sample_policy?.full_track_remediation !== true ||
        linkedReview.sample_policy?.final_user_approval_required !== true ||
        hasOwn(linkedReview, 'cards')
      ) {
        add('approval_linked_full_track_review_policy_invalid');
      }
      if (
        linkedReview.batch_review?.status !==
          'ready_for_full_track_user_approval' ||
        !hasText(linkedReview.batch_review?.summary) ||
        !Array.isArray(linkedReview.batch_review?.remaining_risks) ||
        linkedReview.batch_review.remaining_risks.length !== 0 ||
        !hasText(linkedReview.batch_review?.next_step)
      ) {
        add('approval_linked_full_track_review_batch_invalid');
      }
      if (
        linkedReview.coverage?.expected_card_count !==
          approval.scope?.card_ids?.length ||
        !sameStringSet(
          linkedReview.coverage?.reviewed_card_ids,
          approval.scope?.card_ids,
        ) ||
        !isHumanReviewerIdentity(linkedReview.coverage?.human_reviewer)
      ) {
        add('approval_linked_full_track_review_coverage_invalid');
      }
      const boxes = linkedReview.coverage?.boxes;
      if (
        !Array.isArray(boxes) ||
        !sameStringSet(
          boxes.map(box => box?.box_prefix),
          approval.scope?.box_prefixes,
        ) ||
        boxes.some(box =>
          box?.status !== 'pass' ||
          box?.reviewer !== linkedReview.coverage?.human_reviewer
        )
      ) {
        add('approval_linked_full_track_review_boxes_invalid');
      }
      if (
        !hasUniqueNonEmptyTextArray(linkedReview.representative_cards) ||
        !linkedReview.representative_cards.every(cardId =>
          approval.scope?.card_ids?.includes(cardId)
        )
      ) {
        add('approval_linked_full_track_review_representatives_invalid');
      }
      const currentTrackEntries = currentCardEntries.filter(
        entry => entry.card?.track === approval.scope?.track,
      );
      const currentTrackCardIds = currentTrackEntries.map(
        entry => entry.card?.card_id,
      );
      const currentTrackBoxPrefixes = [
        ...new Set(currentTrackEntries.map(
          entry => entry.card?.knowledge_ref?.box_prefix,
        )),
      ];
      if (
        !hasUniqueNonEmptyTextArray(currentTrackCardIds) ||
        !sameStringSet(currentTrackCardIds, approval.scope?.card_ids) ||
        currentTrackBoxPrefixes.some(prefix => !hasText(prefix)) ||
        !sameStringSet(
          currentTrackBoxPrefixes,
          approval.scope?.box_prefixes,
        )
      ) {
        add('approval_linked_full_track_review_not_complete_current_track');
      }
    } else {
      if (
        linkedReview.sample_policy?.review_scope_type !==
          'three_card_sample_per_box' ||
        linkedReview.sample_policy?.is_three_card_sample_per_box !== true ||
        linkedReview.sample_policy?.batch_generation_requires_user_confirmation !==
          true
      ) {
        add('approval_linked_standard_review_policy_invalid');
      }
      const cards = linkedReview.cards;
      const snapshotIds = Array.isArray(cards)
        ? cards.map(card => card?.card_id)
        : [];
      if (
        !hasUniqueNonEmptyTextArray(snapshotIds) ||
        !sameStringSet(snapshotIds, approval.scope?.card_ids) ||
        cards.some(card =>
          card?.status !== 'pass' ||
          !card?.quality_metadata ||
          !card?.blocker_scan ||
          CURRENT_APPROVAL_BLOCKER_FIELDS.some(
            field => card.blocker_scan?.[field] !== false,
          )
        )
      ) {
        add('approval_linked_standard_review_cards_invalid');
      } else {
        const requiredMetadataFields = [
          'main_training_goal',
          'weak_point_tags',
          'difficulty',
          'card_prototype',
          'material',
          'exam_value',
          'box_progression_role',
          'review_status',
        ];
        for (const currentEntry of currentScopeEntries) {
          const snapshot = cards.find(
            card => card.card_id === currentEntry.card.card_id,
          );
          if (
            !snapshot ||
            snapshot.interaction_id !== currentEntry.card.interaction_id ||
            !isDeepStrictEqual(
              snapshot.knowledge_ref,
              currentEntry.card.knowledge_ref,
            ) ||
            requiredMetadataFields.some(
              field => !hasOwn(snapshot.quality_metadata, field),
            ) ||
            requiredMetadataFields.some(
              field => !hasOwn(currentEntry.card?.quality_metadata, field),
            ) ||
            !deepEqualQualityMetadata(
              currentEntry.card.quality_metadata,
              snapshot.quality_metadata,
            )
          ) {
            add('approval_linked_standard_review_current_corpus_mismatch', {
              card_id: currentEntry.card.card_id,
            });
          }
        }
        for (const boxPrefix of approval.scope.box_prefixes) {
          if (
            cards.filter(
              card => card?.knowledge_ref?.box_prefix === boxPrefix,
            ).length !== 3
          ) {
            add('approval_linked_standard_review_box_sample_invalid', {
              box_prefix: boxPrefix,
            });
          }
        }
      }
      if (
        linkedReview.batch_review?.status !== 'recommend_user_confirmation' ||
        !hasText(linkedReview.batch_review?.box_progression) ||
        !Array.isArray(linkedReview.batch_review?.repetition_or_gap_risks) ||
        !hasUniqueNonEmptyTextArray(
          linkedReview.batch_review?.representative_cards,
        ) ||
        !linkedReview.batch_review.representative_cards.every(cardId =>
          approval.scope?.card_ids?.includes(cardId)
        ) ||
        !hasText(linkedReview.batch_review?.next_step)
      ) {
        add('approval_linked_standard_review_batch_invalid');
      }
    }
    const linkedAudit = linkedReview.quality_audit;
    const linkedReport = checkRecordFile(
      linkedAudit?.report,
      isDirectScopedAuditRecordPath,
      'approval_linked_self_review_audit',
    );
    if (linkedReport) {
      const linkedAuditSha256 = `sha256:${crypto
        .createHash('sha256')
        .update(recordBytesByPath.get(linkedAudit.report))
        .digest('hex')}`;
      if (
        isModelOwned &&
        linkedAudit?.report_sha256 !== linkedAuditSha256
      ) {
        add('approval_linked_model_review_audit_hash_mismatch');
      }
      if (isModelOwned && linkedReviewIsModelOwned) {
        const fullTrackReview =
          linkedReview.schema_version === 'model-owned-full-track-review.v2';
        let expectedReviewInput = null;
        try {
          expectedReviewInput = buildModelAcceptanceInputSha256({
            decisionType: fullTrackReview ? 'full_track_review' : 'card_review',
            scope: linkedReview.scope,
            corpusFingerprint: activeFingerprint.digest,
            auditSha256: linkedAuditSha256,
          });
        } catch (error) {
          add('approval_linked_model_acceptance_input_contract_invalid', {
            message: error.message,
          });
        }
        const reviewAcceptances = fullTrackReview
          ? linkedReview.model_acceptances || []
          : [linkedReview.model_acceptance];
        if (
          expectedReviewInput &&
          reviewAcceptances.some(acceptance =>
            acceptance?.evidence?.input_sha256 !== expectedReviewInput
          )
        ) {
          add('approval_linked_model_acceptance_input_scope_mismatch');
        }
      }
      if (
        currentAudit &&
        !isDeepStrictEqual(
          linkedReport,
          buildCurrentScopedAuditReplay(
            currentAudit,
            linkedReview.scope?.card_ids,
          ),
        )
      ) {
        add('approval_linked_self_review_audit_replay_mismatch');
      }
      const linkedDigest = linkedReport.corpus_fingerprint?.digest;
      if (
        !hasText(linkedAudit?.corpus_fingerprint) ||
        linkedAudit.corpus_fingerprint !== linkedDigest
      ) {
        add('approval_linked_self_review_fingerprint_mismatch');
      }
      if (linkedDigest !== activeFingerprint.digest) {
        add('approval_linked_self_review_not_current');
      }
      if (!sameStringSet(
        linkedReport.scope?.card_ids,
        linkedReview.scope?.card_ids,
      )) {
        add('approval_linked_self_review_audit_scope_mismatch');
      }
      if (
        linkedAudit?.scope_has_no_hard_blockers !== true ||
        linkedReport.ok !== true ||
        linkedReport.scope_summary?.by_severity?.hard_blocker !== 0 ||
        (linkedReport.scoped_hard_blocker_issues || []).length !== 0 ||
        !isDeepStrictEqual(
          linkedAudit?.scope_summary,
          linkedReport.scope_summary,
        )
      ) {
        add('approval_linked_self_review_audit_not_clear');
      }
    }
  }

  try {
    if (
      !isDeepStrictEqual(
        computeCardCorpusFingerprint(root),
        activeFingerprint,
      )
    ) {
      add('approval_current_corpus_changed_during_validation');
    }
  } catch (error) {
    add('approval_current_corpus_changed_during_validation', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (requireTracked && validationGitSnapshot) {
    try {
      const finalGitSnapshot = captureGitAuthorizationSnapshot(root);
      if (
        !isDeepStrictEqual(finalGitSnapshot, validationGitSnapshot)
      ) {
        add('approval_git_snapshot_changed_during_validation', {
          expected_head: validationGitSnapshot.headCommit,
          actual_head: finalGitSnapshot.headCommit,
        });
      }
    } catch (error) {
      add('approval_git_snapshot_changed_during_validation', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const [relativePath, captured] of authorizationFileSnapshots) {
    try {
      const finalStats = fs.lstatSync(path.join(root, relativePath));
      const finalMode =
        (finalStats.mode & 0o111) === 0 ? '100644' : '100755';
      const finalBytes = finalStats.isFile()
        ? fs.readFileSync(path.join(root, relativePath))
        : null;
      if (
        !finalStats.isFile() ||
        finalMode !== captured.mode ||
        !Buffer.isBuffer(finalBytes) ||
        !captured.bytes.equals(finalBytes)
      ) {
        add('approval_authorization_file_changed_during_validation', {
          path: relativePath,
        });
      }
    } catch {
      add('approval_authorization_file_changed_during_validation', {
        path: relativePath,
      });
    }
  }

  return {
    ok: issues.length === 0,
    approval: approval || null,
    current_fingerprint: activeFingerprint,
    issues,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values)];
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return unique(left.filter(value => rightSet.has(value)));
}

function issue(code, card, details = {}) {
  return {
    code,
    card_id: typeof card?.card_id === 'string' ? card.card_id : null,
    ...details,
  };
}

function schemaEnum(schema, pathParts) {
  let value = schema;
  for (const part of pathParts) value = value?.[part];
  return Array.isArray(value?.enum) ? value.enum : [];
}

/**
 * Loads the active schema and content-quality contract into a serializable policy.
 * Shared enums are intersected so a candidate must satisfy both authorities.
 */
export function loadIntegrityPolicy(root) {
  const schemaPath = path.join(root, 'spec', 'card-metadata.schema.json');
  const qualityPath = path.join(root, 'spec', 'content-quality-contract.json');
  const schema = readJson(schemaPath);
  const quality = readJson(qualityPath);
  const metadataSchema = schema.properties?.quality_metadata || {};
  const metadataProperties = metadataSchema.properties || {};

  const schemaWeakPointTags = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'weak_point_tags', 'items',
  ]);
  const schemaDifficulties = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'difficulty', 'properties', 'primary',
  ]);
  const schemaPrototypes = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'card_prototype',
  ]);
  const schemaSourceTypes = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'material', 'properties', 'text_source_type',
  ]);

  return {
    schema_paths: {
      card_metadata: path.relative(root, schemaPath).replaceAll('\\', '/'),
      content_quality: path.relative(root, qualityPath).replaceAll('\\', '/'),
    },
    card_required_fields: [...(schema.required || [])],
    quality_metadata_required_fields: [...(metadataSchema.required || [])],
    difficulty_required_fields: [...(metadataProperties.difficulty?.required || [])],
    material_required_fields: [...(metadataProperties.material?.required || [])],
    constraints: {
      card_id_pattern: schema.properties?.card_id?.pattern || null,
      main_training_goal_min_length: metadataProperties.main_training_goal?.minLength || 0,
      exam_value_min_length: metadataProperties.exam_value?.minLength || 0,
      weak_point_tags_min_items: metadataProperties.weak_point_tags?.minItems || 0,
    },
    allowed: {
      tracks: [...(schema.properties?.track?.enum || [])],
      interactions: [...(schema.properties?.interaction_id?.enum || [])],
      weak_point_tags: intersect(
        schemaWeakPointTags,
        quality.default_user_model?.weak_point_tags || [],
      ),
      difficulties: intersect(
        schemaDifficulties,
        quality.difficulty_policy?.tiers || [],
      ),
      card_prototypes: intersect(
        schemaPrototypes,
        quality.allowed_card_prototypes || [],
      ),
      text_source_types: intersect(
        schemaSourceTypes,
        quality.source_policy?.allowed_text_source_types || [],
      ),
      box_progression_roles: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'box_progression_role',
      ]),
      review_statuses: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'review_status',
      ]),
      audio_generation_methods: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'material', 'properties', 'audio_generation_method',
      ]),
    },
  };
}

function pushInvalidMetadata(issues, card, pathName, reason, actual, extra = {}) {
  issues.push(issue('candidate_quality_metadata_invalid', card, {
    path: pathName,
    reason,
    actual,
    ...extra,
  }));
}

function validateOptionalString(issues, card, object, field, pathName) {
  if (hasOwn(object, field) && typeof object[field] !== 'string') {
    pushInvalidMetadata(issues, card, pathName, 'must_be_string', object[field]);
  }
}

function validateOptionalBoolean(issues, card, object, field, pathName) {
  if (hasOwn(object, field) && typeof object[field] !== 'boolean') {
    pushInvalidMetadata(issues, card, pathName, 'must_be_boolean', object[field]);
  }
}

/**
 * Validates the card-metadata schema envelope and quality_metadata content.
 * Legacy cards without quality_metadata are skipped unless required=true.
 */
export function validateQualityMetadata(card, policy, {required = false} = {}) {
  const issues = [];
  const metadataPresent = hasOwn(card, 'quality_metadata');

  if (!metadataPresent) {
    if (required) {
      issues.push(issue('candidate_quality_metadata_missing', card, {
        path: 'quality_metadata',
        required,
      }));
    }
    return {ok: issues.length === 0, issues, present: false, skipped: !required};
  }

  for (const field of policy.card_required_fields || []) {
    if (!hasOwn(card, field)) {
      issues.push(issue('candidate_card_schema_required_field_missing', card, {
        path: field,
        field,
      }));
    }
  }

  if (typeof card.card_id !== 'string' || (
    policy.constraints?.card_id_pattern &&
    !(new RegExp(policy.constraints.card_id_pattern)).test(card.card_id)
  )) {
    issues.push(issue('candidate_card_id_invalid', card, {
      path: 'card_id',
      actual: card.card_id,
      pattern: policy.constraints?.card_id_pattern || null,
    }));
  }

  if (!(policy.allowed?.tracks || []).includes(card.track)) {
    issues.push(issue('candidate_track_invalid', card, {
      path: 'track',
      actual: card.track,
      allowed: policy.allowed?.tracks || [],
    }));
  }

  if (!isObject(card.knowledge_ref)) {
    issues.push(issue('candidate_knowledge_ref_invalid', card, {
      path: 'knowledge_ref',
      reason: 'must_be_object',
      actual: card.knowledge_ref,
    }));
  }

  if (!(policy.allowed?.interactions || []).includes(card.interaction_id)) {
    issues.push(issue('candidate_interaction_id_invalid', card, {
      path: 'interaction_id',
      actual: card.interaction_id,
      allowed: policy.allowed?.interactions || [],
    }));
  }

  const metadata = card.quality_metadata;
  if (!isObject(metadata)) {
    pushInvalidMetadata(issues, card, 'quality_metadata', 'must_be_object', metadata);
    return {ok: false, issues, present: true, skipped: false};
  }

  for (const field of policy.quality_metadata_required_fields || []) {
    if (!hasOwn(metadata, field)) {
      issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
        path: `quality_metadata.${field}`,
        field,
      }));
    }
  }

  const mainGoalMinimum = policy.constraints?.main_training_goal_min_length || 0;
  if (typeof metadata.main_training_goal !== 'string') {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.main_training_goal',
      'must_be_string',
      metadata.main_training_goal,
    );
  } else if (metadata.main_training_goal.length < mainGoalMinimum) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.main_training_goal',
      'min_length',
      metadata.main_training_goal,
      {minimum: mainGoalMinimum},
    );
  }

  if (hasOwn(metadata, 'secondary_training_goals')) {
    if (!Array.isArray(metadata.secondary_training_goals)) {
      pushInvalidMetadata(
        issues,
        card,
        'quality_metadata.secondary_training_goals',
        'must_be_array',
        metadata.secondary_training_goals,
      );
    } else {
      metadata.secondary_training_goals.forEach((goal, index) => {
        if (typeof goal !== 'string') {
          pushInvalidMetadata(
            issues,
            card,
            `quality_metadata.secondary_training_goals[${index}]`,
            'must_be_string',
            goal,
          );
        }
      });
    }
  }

  const weakTags = metadata.weak_point_tags;
  if (!Array.isArray(weakTags)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.weak_point_tags',
      'must_be_array',
      weakTags,
    );
  } else {
    const minimum = policy.constraints?.weak_point_tags_min_items || 0;
    if (weakTags.length < minimum) {
      pushInvalidMetadata(
        issues,
        card,
        'quality_metadata.weak_point_tags',
        'min_items',
        weakTags,
        {minimum},
      );
    }
    weakTags.forEach((tag, index) => {
      if (!(policy.allowed?.weak_point_tags || []).includes(tag)) {
        issues.push(issue('invalid_weak_point_tag', card, {
          path: `quality_metadata.weak_point_tags[${index}]`,
          tag,
          allowed: policy.allowed?.weak_point_tags || [],
        }));
      }
    });
  }

  const difficulty = metadata.difficulty;
  if (!isObject(difficulty)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.difficulty',
      'must_be_object',
      difficulty,
    );
  } else {
    for (const field of policy.difficulty_required_fields || []) {
      if (!hasOwn(difficulty, field)) {
        issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
          path: `quality_metadata.difficulty.${field}`,
          field,
        }));
      }
    }
    if (!(policy.allowed?.difficulties || []).includes(difficulty.primary)) {
      issues.push(issue('invalid_difficulty', card, {
        path: 'quality_metadata.difficulty.primary',
        difficulty: difficulty.primary,
        allowed: policy.allowed?.difficulties || [],
      }));
    }
    if (hasOwn(difficulty, 'secondary')) {
      if (!Array.isArray(difficulty.secondary)) {
        pushInvalidMetadata(
          issues,
          card,
          'quality_metadata.difficulty.secondary',
          'must_be_array',
          difficulty.secondary,
        );
      } else {
        difficulty.secondary.forEach((tier, index) => {
          if (!(policy.allowed?.difficulties || []).includes(tier)) {
            issues.push(issue('invalid_difficulty', card, {
              path: `quality_metadata.difficulty.secondary[${index}]`,
              difficulty: tier,
              allowed: policy.allowed?.difficulties || [],
            }));
          }
        });
      }
    }
    validateOptionalString(
      issues,
      card,
      difficulty,
      'advanced_in_foundation_reason',
      'quality_metadata.difficulty.advanced_in_foundation_reason',
    );
  }

  if (!(policy.allowed?.card_prototypes || []).includes(metadata.card_prototype)) {
    issues.push(issue('invalid_card_prototype', card, {
      path: 'quality_metadata.card_prototype',
      card_prototype: metadata.card_prototype,
      allowed: policy.allowed?.card_prototypes || [],
    }));
  }

  const material = metadata.material;
  if (!isObject(material)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.material',
      'must_be_object',
      material,
    );
  } else {
    for (const field of policy.material_required_fields || []) {
      if (!hasOwn(material, field)) {
        issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
          path: `quality_metadata.material.${field}`,
          field,
        }));
      }
    }
    if (!(policy.allowed?.text_source_types || []).includes(material.text_source_type)) {
      issues.push(issue('invalid_text_source_type', card, {
        path: 'quality_metadata.material.text_source_type',
        text_source_type: material.text_source_type,
        allowed: policy.allowed?.text_source_types || [],
      }));
    }
    validateOptionalString(
      issues,
      card,
      material,
      'source_note',
      'quality_metadata.material.source_note',
    );
    if (
      hasOwn(material, 'audio_generation_method') &&
      !(policy.allowed?.audio_generation_methods || []).includes(material.audio_generation_method)
    ) {
      issues.push(issue('invalid_audio_generation_method', card, {
        path: 'quality_metadata.material.audio_generation_method',
        audio_generation_method: material.audio_generation_method,
        allowed: policy.allowed?.audio_generation_methods || [],
      }));
    }
    validateOptionalBoolean(
      issues,
      card,
      material,
      'tts_text_reviewed',
      'quality_metadata.material.tts_text_reviewed',
    );
    validateOptionalBoolean(
      issues,
      card,
      material,
      'tts_audio_reviewed',
      'quality_metadata.material.tts_audio_reviewed',
    );
  }

  const examValueMinimum = policy.constraints?.exam_value_min_length || 0;
  if (typeof metadata.exam_value !== 'string') {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.exam_value',
      'must_be_string',
      metadata.exam_value,
    );
  } else if (metadata.exam_value.length < examValueMinimum) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.exam_value',
      'min_length',
      metadata.exam_value,
      {minimum: examValueMinimum},
    );
  }

  if (!(policy.allowed?.box_progression_roles || []).includes(metadata.box_progression_role)) {
    issues.push(issue('invalid_box_progression_role', card, {
      path: 'quality_metadata.box_progression_role',
      box_progression_role: metadata.box_progression_role,
      allowed: policy.allowed?.box_progression_roles || [],
    }));
  }

  if (!(policy.allowed?.review_statuses || []).includes(metadata.review_status)) {
    issues.push(issue('invalid_review_status', card, {
      path: 'quality_metadata.review_status',
      review_status: metadata.review_status,
      allowed: policy.allowed?.review_statuses || [],
    }));
  }

  return {ok: issues.length === 0, issues, present: true, skipped: false};
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Validates the runtime elimination payload, the local preview projection, and
 * answer truth. Runtime identity is elimination_items[].id and correct_items
 * contains those IDs. Untouched corpus migrations may opt into the explicit
 * text/is_correct compatibility mode; changed candidates must not.
 */
export function validateEliminationIntegrity(
  card,
  {
    requireLegacyMirror = true,
    allowLegacyContract = false,
  } = {},
) {
  const issues = [];
  if (card?.interaction_id !== 'elimination') {
    return {ok: true, issues, applicable: false};
  }

  const canonical = card.elimination_items;
  const canonicalIsNonEmptyArray = Array.isArray(canonical) && canonical.length > 0;
  if (!canonicalIsNonEmptyArray) {
    issues.push(issue(
      canonical === undefined || canonical === null || (Array.isArray(canonical) && canonical.length === 0)
        ? 'elimination_items_missing'
        : 'elimination_items_invalid',
      card,
      {
        path: 'elimination_items',
        reason: Array.isArray(canonical) ? 'must_not_be_empty' : 'must_be_non_empty_array',
      },
    ));
  }

  const legacyCompatibilityShape = canonicalIsNonEmptyArray && canonical.every(item =>
    isObject(item) &&
    (typeof item.id !== 'string' || item.id.trim().length === 0) &&
    typeof item.text === 'string' &&
    item.text.trim().length > 0 &&
    typeof item.is_correct === 'boolean'
  );
  const compatibilityMode = allowLegacyContract && legacyCompatibilityShape;
  const mode = compatibilityMode
    ? 'legacy_text_answer_compatibility'
    : 'runtime_id_contract';

  const validCanonicalItems = [];
  if (Array.isArray(canonical)) {
    canonical.forEach((item, index) => {
      if (!isObject(item)) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}]`,
          reason: 'must_be_object',
        }));
        return;
      }
      if (typeof item.text !== 'string' || item.text.trim().length === 0) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].text`,
          reason: 'must_be_non_empty_string',
          actual: item.text,
        }));
      }
      if (compatibilityMode && typeof item.is_correct !== 'boolean') {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].is_correct`,
          reason: 'must_be_boolean',
          actual: item.is_correct,
        }));
      }
      if (!compatibilityMode && (typeof item.id !== 'string' || item.id.trim().length === 0)) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].id`,
          reason: 'runtime_contract_requires_non_empty_string_id',
          actual: item.id,
        }));
      }
      if (
        typeof item.text === 'string' &&
        item.text.trim().length > 0 &&
        (
          compatibilityMode
            ? typeof item.is_correct === 'boolean'
            : typeof item.id === 'string' && item.id.trim().length > 0
        )
      ) {
        validCanonicalItems.push(item);
      }
    });
  }

  const duplicateCanonicalIdentities = duplicateValues(
    (Array.isArray(canonical) ? canonical : []).map(item => {
      if (compatibilityMode) {
        return typeof item?.text === 'string' ? item.text.trim() : null;
      }
      return typeof item?.id === 'string' ? item.id.trim() : null;
    }),
  );
  if (duplicateCanonicalIdentities.length > 0) {
    issues.push(issue('elimination_duplicate_item_identity', card, {
      path: 'elimination_items',
      identities: duplicateCanonicalIdentities,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  const legacyMirror = card.eliminable_items;
  if (requireLegacyMirror && (!Array.isArray(legacyMirror) || legacyMirror.length === 0)) {
    issues.push(issue('elimination_legacy_mirror_missing', card, {
      path: 'eliminable_items',
      reason: 'local_preview_compatibility_requires_non_empty_mirror',
    }));
  }

  const validLegacyItems = [];
  if (Array.isArray(legacyMirror)) {
    legacyMirror.forEach((item, index) => {
      if (!isObject(item)) {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}]`,
          reason: 'must_be_object',
        }));
        return;
      }
      if (typeof item.text !== 'string' || item.text.trim().length === 0) {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}].text`,
          reason: 'must_be_non_empty_string',
          actual: item.text,
        }));
      }
      if (typeof item.is_correct !== 'boolean') {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}].is_correct`,
          reason: 'must_be_boolean',
          actual: item.is_correct,
        }));
      }
      if (
        typeof item.text === 'string' &&
        item.text.trim().length > 0 &&
        typeof item.is_correct === 'boolean'
      ) {
        validLegacyItems.push(item);
      }
    });
  }

  if (Array.isArray(legacyMirror) && Array.isArray(canonical)) {
    if (compatibilityMode) {
      if (!isDeepStrictEqual(legacyMirror, canonical)) {
        issues.push(issue('elimination_legacy_mirror_mismatch', card, {
          path: 'eliminable_items',
          canonical_path: 'elimination_items',
          reason: 'legacy_compatibility_requires_exact_mirror',
        }));
      }
    } else {
      const projectionMismatches = [];
      if (legacyMirror.length !== canonical.length) {
        projectionMismatches.push({
          reason: 'length_mismatch',
          canonical_length: canonical.length,
          legacy_length: legacyMirror.length,
        });
      }
      const sharedLength = Math.min(legacyMirror.length, canonical.length);
      for (let index = 0; index < sharedLength; index += 1) {
        if (legacyMirror[index]?.text !== canonical[index]?.text) {
          projectionMismatches.push({
            index,
            reason: 'text_mismatch',
            canonical_text: canonical[index]?.text,
            legacy_text: legacyMirror[index]?.text,
          });
        }
      }
      if (projectionMismatches.length > 0) {
        issues.push(issue('elimination_legacy_mirror_mismatch', card, {
          path: 'eliminable_items',
          canonical_path: 'elimination_items',
          reason: 'legacy_preview_must_project_canonical_items_by_position',
          mismatches: projectionMismatches,
        }));
      }
    }
  }

  const correctItems = card.answer_key?.correct_items;
  const correctItemsIsNonEmptyArray = Array.isArray(correctItems) && correctItems.length > 0;
  if (!correctItemsIsNonEmptyArray) {
    issues.push(issue('elimination_correct_items_missing', card, {
      path: 'answer_key.correct_items',
      reason: Array.isArray(correctItems) ? 'must_not_be_empty' : 'must_be_non_empty_array',
    }));
  }

  const validCorrectItems = [];
  if (Array.isArray(correctItems)) {
    correctItems.forEach((value, index) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        issues.push(issue('elimination_correct_items_invalid', card, {
          path: `answer_key.correct_items[${index}]`,
          reason: 'must_be_non_empty_string',
          actual: value,
        }));
      } else {
        validCorrectItems.push(value);
      }
    });
  }

  const duplicateCorrectIdentities = duplicateValues(validCorrectItems.map(value => value.trim()));
  if (duplicateCorrectIdentities.length > 0) {
    issues.push(issue('elimination_duplicate_item_identity', card, {
      path: 'answer_key.correct_items',
      identities: duplicateCorrectIdentities,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  const canonicalIdentities = new Set(validCanonicalItems.map(item =>
    compatibilityMode ? item.text : item.id
  ));
  const staleCorrectItems = unique(validCorrectItems.filter(value => !canonicalIdentities.has(value)));
  if (staleCorrectItems.length > 0) {
    issues.push(issue('elimination_correct_items_not_in_items', card, {
      path: 'answer_key.correct_items',
      values: staleCorrectItems,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  if (correctItemsIsNonEmptyArray && canonicalIsNonEmptyArray) {
    let expected = [];
    let truthComparable = false;
    if (compatibilityMode) {
      expected = unique(validCanonicalItems.filter(item => item.is_correct).map(item => item.text));
      truthComparable = validCanonicalItems.length === canonical.length;
    } else if (
      Array.isArray(legacyMirror) &&
      legacyMirror.length === canonical.length &&
      validLegacyItems.length === legacyMirror.length
    ) {
      expected = unique(canonical
        .filter((_item, index) => legacyMirror[index].is_correct)
        .map(item => item.id)
        .filter(value => typeof value === 'string' && value.trim().length > 0));
      truthComparable = validCanonicalItems.length === canonical.length;
    }
    const actual = unique(validCorrectItems);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter(value => !actualSet.has(value));
    const unexpected = actual.filter(value => !expectedSet.has(value));
    if (
      truthComparable &&
      (missing.length > 0 || unexpected.length > 0 || duplicateCorrectIdentities.length > 0)
    ) {
      issues.push(issue('elimination_correct_items_truth_mismatch', card, {
        path: 'answer_key.correct_items',
        expected,
        actual: validCorrectItems,
        missing,
        unexpected,
        comparison: 'order_independent_set_with_unique_identities',
        identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
      }));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    applicable: true,
    mode,
    legacy_compatible: compatibilityMode,
  };
}

export function metadataParityProjection(metadata) {
  if (!isObject(metadata)) return metadata;
  const {review_status: _reviewStatus, ...comparable} = metadata;
  return comparable;
}

export function deepEqualQualityMetadata(left, right) {
  return isDeepStrictEqual(metadataParityProjection(left), metadataParityProjection(right));
}

function differencePaths(left, right, currentPath = 'quality_metadata') {
  if (isDeepStrictEqual(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) return [currentPath];
  if (isObject(left) && isObject(right)) {
    const keys = unique([...Object.keys(left), ...Object.keys(right)]).sort();
    return keys.flatMap(key => differencePaths(left[key], right[key], `${currentPath}.${key}`));
  }
  return [currentPath];
}

function normalizeChangedCards(input) {
  const normalized = [];
  for (const item of asArray(input)) {
    if (Array.isArray(item?.cards)) {
      for (const card of item.cards) normalized.push({card, path: item.path || null});
      continue;
    }
    if (isObject(item?.card)) {
      normalized.push({card: item.card, path: item.path || item.file || null});
      continue;
    }
    normalized.push({card: item, path: item?.path || item?.file || null});
  }
  return normalized;
}

function normalizeReviewCards(input) {
  const normalized = [];
  for (const item of asArray(input)) {
    const source = isObject(item?.record) ? item.record : item;
    const sourcePath = item?.path || item?.file || item?.source || null;
    if (Array.isArray(source?.cards)) {
      for (const reviewCard of source.cards) normalized.push({reviewCard, path: sourcePath});
      continue;
    }
    if (isObject(source?.card)) {
      normalized.push({reviewCard: source.card, path: sourcePath});
      continue;
    }
    normalized.push({reviewCard: source, path: sourcePath});
  }
  return normalized;
}

/**
 * Validates changed cards against changed self-review snapshots without any Git
 * or filesystem coupling. Every metadata field is compared deeply except the
 * explicitly documented review_status lifecycle boundary.
 */
export function validateChangedCardSelfReviewParity(
  changedCards,
  changedReviewRecords,
  policy,
  {required = true} = {},
) {
  const issues = [];
  const cards = normalizeChangedCards(changedCards);
  const reviewCards = normalizeReviewCards(changedReviewRecords);
  const matchesByCardId = new Map();

  for (const entry of reviewCards) {
    const cardId = entry.reviewCard?.card_id;
    if (typeof cardId !== 'string') continue;
    const matches = matchesByCardId.get(cardId) || [];
    matches.push(entry);
    matchesByCardId.set(cardId, matches);
  }

  const stats = {
    changed_cards: cards.length,
    changed_self_review_cards: reviewCards.length,
    matched: 0,
    missing: 0,
    ambiguous: 0,
    metadata_mismatches: 0,
    parity_exception: REVIEW_STATUS_PARITY_EXCEPTION,
  };

  for (const entry of cards) {
    const card = entry.card;
    const cardValidation = validateQualityMetadata(card, policy, {required});
    issues.push(...cardValidation.issues.map(record => ({
      ...record,
      artifact: 'candidate_card',
      card_path: entry.path,
    })));

    const matches = matchesByCardId.get(card?.card_id) || [];
    if (matches.length === 0) {
      stats.missing += 1;
      if (required) {
        issues.push(issue('candidate_self_review_missing', card, {
          card_path: entry.path,
          message: 'Changed candidate cards require one changed self-review snapshot with the same card_id.',
        }));
      }
      continue;
    }
    if (matches.length > 1) {
      stats.ambiguous += 1;
      issues.push(issue('candidate_self_review_ambiguous', card, {
        card_path: entry.path,
        review_paths: matches.map(match => match.path),
        match_count: matches.length,
      }));
      continue;
    }

    stats.matched += 1;
    const match = matches[0];
    const reviewCard = match.reviewCard;
    const reviewCandidate = {...card};
    if (hasOwn(reviewCard, 'quality_metadata')) {
      reviewCandidate.quality_metadata = reviewCard.quality_metadata;
    } else {
      delete reviewCandidate.quality_metadata;
    }
    const reviewValidation = validateQualityMetadata(reviewCandidate, policy, {required});
    issues.push(...reviewValidation.issues.map(record => ({
      ...record,
      artifact: 'candidate_self_review',
      review_path: match.path,
    })));

    if (
      isObject(card?.quality_metadata) &&
      isObject(reviewCard?.quality_metadata) &&
      !deepEqualQualityMetadata(card.quality_metadata, reviewCard.quality_metadata)
    ) {
      stats.metadata_mismatches += 1;
      const cardComparable = metadataParityProjection(card.quality_metadata);
      const reviewComparable = metadataParityProjection(reviewCard.quality_metadata);
      issues.push(issue('candidate_self_review_metadata_mismatch', card, {
        card_path: entry.path,
        review_path: match.path,
        differing_paths: differencePaths(cardComparable, reviewComparable),
        parity_exception: REVIEW_STATUS_PARITY_EXCEPTION,
      }));
    }
  }

  return {ok: issues.length === 0, issues, stats};
}
