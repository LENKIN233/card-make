import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE = 'origin/fix/review-findings-card-contract';
const GLOBAL_REPORT_PATHS = new Set([
  'reports/card_quality_audit_report.json',
  'reports/card_validation_report.json',
]);
const MULTI_PREFIX_CONTENT_CHANGE_TYPES = new Set([
  'content_candidate_front_answer_leak_queue',
  'content_candidate_residual_blocker_closure',
]);
const CONTENT_NO_AUTO_MERGE_AUTHORITY = 'no_auto_merge_content_candidate_user_confirmation_required';
const CURRENT_AUDIT_OVERLAY_PATHS = [
  'scripts/audit_card_quality.mjs',
  'spec/card-quality-audit.json',
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

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function parseDiffLine(line) {
  const [status, ...fields] = line.split('\t');
  const paths = fields.map(normalizePath);
  return {
    status,
    paths,
    path: paths[paths.length - 1] || '',
  };
}

function changedEntries(base, head) {
  const range = head ? `${base}...${head}` : base;
  const output = runGit(['diff', '--name-status', '--find-renames', range, '--']);
  const entries = output
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(parseDiffLine);
  if (!head) {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(filePath => ({
        status: '??',
        paths: [normalizePath(filePath)],
        path: normalizePath(filePath),
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
  return /^card_boxes_json\/card_boxes_seed_.+_\d{4}\.json$/.test(filePath);
}

function isDraftPath(filePath) {
  return /^reviews\/drafts\/.+\.json$/.test(filePath);
}

function isSelfReviewPath(filePath) {
  return /^reviews\/agent_self_review\/.+\.json$/.test(filePath) &&
    !filePath.endsWith('/TEMPLATE.json');
}

function isHandoffPath(filePath) {
  return /^reviews\/git_handoffs\/.+\.json$/.test(filePath) &&
    !filePath.endsWith('/TEMPLATE.json');
}

function isScopedAuditPath(filePath) {
  return /^reviews\/audit_scopes\/.+\.json$/.test(filePath);
}

function isContentReviewPath(filePath) {
  return Boolean(pathPrefix(filePath)) &&
    (isDraftPath(filePath) || isSelfReviewPath(filePath) || isHandoffPath(filePath) || isScopedAuditPath(filePath));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
    for (const filePath of entry.paths) {
      if (isCardBoxPath(filePath)) paths.add(filePath);
    }
  }
  return [...paths].sort();
}

function copyCurrentAuditHarness(worktreePath) {
  for (const relativePath of CURRENT_AUDIT_OVERLAY_PATHS) {
    const source = path.resolve(relativePath);
    const target = path.join(worktreePath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
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
    runGit(['worktree', 'add', '--detach', worktreePath, base]);
    worktreeAdded = true;
    copyCurrentAuditHarness(worktreePath);
    runGit(['checkout', head, '--', ...cardBoxPaths], { cwd: worktreePath });
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
    isCardBoxPath(filePath) || isContentReviewPath(filePath)
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
  const entries = changedEntries(base, head);
  const issues = [];
  const warnings = [];
  const contentCandidate = isContentCandidateDiff(entries);
  const primaryPrefixes = primaryScopePrefixes(entries);
  let currentScopedAudit = null;

  if (contentCandidate) {
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
      const evidence = multiPrefixEvidenceRecords(entries, head, primaryPrefixes);
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

    currentScopedAudit = runCurrentScopedAudit({ base, head, entries });
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
    content_candidate_diff: contentCandidate,
    primary_scope_prefixes: [...primaryPrefixes].sort(),
    changed_paths: entries.map(entry => ({
      status: entry.status,
      paths: entry.paths,
    })),
    current_scoped_audit: currentScopedAudit,
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
