import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WORKTREE_NAME = '.card-make-front-leak-queue-audit';
const FRONT_LEAK_RULE_ID = 'front_leaks_correct_answer';
const QUALITY_AUDIT_REPORT_PATH = path.join('reports', 'card_quality_audit_report.json');

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  return process.argv[index + 1];
}

function readCsvOption(name) {
  return (readOption(name, '') || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function run(command, args, { cwd = ROOT, allowFailure = false } = {}) {
  const startedAt = Date.now();
  const result = cp.spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const record = {
    command: [command, ...args].join(' '),
    cwd,
    ok: result.status === 0,
    status: result.status,
    duration_ms: Date.now() - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
  if (!record.ok && !allowFailure) {
    const error = new Error(`Command failed: ${record.command}`);
    error.record = record;
    throw error;
  }
  return record;
}

function parseJsonOutput(record) {
  try {
    return JSON.parse(record.stdout);
  } catch {
    return null;
  }
}

function summarizeCommand(record) {
  const tail = value => value.length > 3000 ? value.slice(-3000) : value;
  return {
    command: record.command,
    ok: record.ok,
    status: record.status,
    duration_ms: record.duration_ms,
    stdout_tail: tail(record.stdout.trim()),
    stderr_tail: tail(record.stderr.trim()),
  };
}

function safeRemoveWorktree(worktreeDir) {
  const base = path.basename(worktreeDir);
  if (!base.includes('card-make-front-leak-queue-audit')) {
    throw new Error(`Refusing to remove non-audit worktree path: ${worktreeDir}`);
  }
  if (!fs.existsSync(worktreeDir)) return;
  run('git', ['worktree', 'remove', worktreeDir, '--force'], { allowFailure: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

function readQualityReport(worktreeDir) {
  const reportPath = path.join(worktreeDir, QUALITY_AUDIT_REPORT_PATH);
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function preserveQualityReport(worktreeDir) {
  const reportPath = path.join(worktreeDir, QUALITY_AUDIT_REPORT_PATH);
  if (!fs.existsSync(reportPath)) return null;
  return fs.readFileSync(reportPath, 'utf8');
}

function restoreQualityReport(worktreeDir, content) {
  const reportPath = path.join(worktreeDir, QUALITY_AUDIT_REPORT_PATH);
  if (content === null) {
    fs.rmSync(reportPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, content);
}

function readJson(worktreeDir, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(worktreeDir, relativePath), 'utf8'));
}

function writeJson(worktreeDir, relativePath, value) {
  fs.writeFileSync(path.join(worktreeDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function listJsonFiles(worktreeDir, relativeDir) {
  const fullDir = path.join(worktreeDir, relativeDir);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];
  return fs.readdirSync(fullDir)
    .filter(file => file.endsWith('.json') && file !== 'TEMPLATE.json')
    .sort()
    .map(file => `${relativeDir}/${file}`);
}

function isScopedAuditReportPath(reportPath) {
  return typeof reportPath === 'string' &&
    reportPath.startsWith('reviews/audit_scopes/') &&
    reportPath.endsWith('.json') &&
    !reportPath.slice('reviews/audit_scopes/'.length).includes('/');
}

function scopeCardIdsForReview(record) {
  const scopeIds = Array.isArray(record.scope?.card_ids) ? record.scope.card_ids : [];
  if (scopeIds.length > 0) return scopeIds.map(String).filter(Boolean);
  return (Array.isArray(record.cards) ? record.cards : [])
    .map(card => card?.card_id)
    .map(String)
    .filter(Boolean);
}

function sameStringSet(leftValues, rightValues) {
  const left = new Set(leftValues.map(String));
  const right = new Set(rightValues.map(String));
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function refreshScopedEvidence(worktreeDir) {
  const reviewFiles = listJsonFiles(worktreeDir, 'reviews/agent_self_review');
  const refreshedReports = new Map();
  const commands = [];
  const changedReviewRecords = [];
  const failures = [];
  const skipped = [];

  for (const reviewFile of reviewFiles) {
    const reviewRecord = readJson(worktreeDir, reviewFile);
    const auditRecord = reviewRecord.quality_audit;
    if (!auditRecord || !isScopedAuditReportPath(auditRecord.report)) continue;

    const cardIds = scopeCardIdsForReview(reviewRecord);
    if (cardIds.length === 0) {
      skipped.push({ review: reviewFile, reason: 'no_scope_card_ids' });
      continue;
    }

    const existingRefresh = refreshedReports.get(auditRecord.report);
    if (existingRefresh && !sameStringSet(existingRefresh.card_ids, cardIds)) {
      failures.push({
        review: reviewFile,
        report: auditRecord.report,
        reason: 'same_scoped_report_used_for_different_card_ids',
      });
      continue;
    }

    if (!existingRefresh) {
      const refreshRecord = run('node', [
        'scripts/audit_card_quality.mjs',
        '--scope-card-ids',
        cardIds.join(','),
        '--write-scope-report',
        auditRecord.report,
      ], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      commands.push(refreshRecord);
      if (!refreshRecord.ok) {
        failures.push({
          review: reviewFile,
          report: auditRecord.report,
          reason: 'scoped_audit_refresh_command_failed',
        });
        continue;
      }
      refreshedReports.set(auditRecord.report, {
        card_ids: cardIds,
        report: readJson(worktreeDir, auditRecord.report),
      });
    }

    const scopedReport = refreshedReports.get(auditRecord.report)?.report;
    if (!scopedReport?.corpus_fingerprint?.digest || !scopedReport.scope_summary) {
      failures.push({
        review: reviewFile,
        report: auditRecord.report,
        reason: 'refreshed_scoped_report_missing_required_fields',
      });
      continue;
    }

    const before = JSON.stringify(auditRecord);
    auditRecord.corpus_fingerprint = scopedReport.corpus_fingerprint.digest;
    auditRecord.scope_has_no_hard_blockers = Number(scopedReport.scope_summary.by_severity?.hard_blocker || 0) === 0;
    auditRecord.scope_summary = scopedReport.scope_summary;
    if (JSON.stringify(auditRecord) !== before) {
      writeJson(worktreeDir, reviewFile, reviewRecord);
      changedReviewRecords.push(reviewFile);
    }
  }

  return {
    ok: failures.length === 0,
    refreshed_scoped_reports: [...refreshedReports.keys()],
    changed_review_records: changedReviewRecords,
    skipped,
    failures,
    commands,
  };
}

function frontLeakCount(report) {
  return Number(report.summary?.by_rule?.[FRONT_LEAK_RULE_ID]?.count || 0);
}

function main() {
  const base = readOption('--base', 'origin/main');
  const branches = readCsvOption('--branches');
  const keepWorktree = hasFlag('--keep-worktree');
  const requireHarness = hasFlag('--require-harness');
  const refreshEvidence = hasFlag('--refresh-scoped-evidence');
  const allowFrontLeaks = hasFlag('--allow-front-leaks');
  const worktreeDir = path.resolve(
    readOption('--worktree-dir', path.join(path.dirname(ROOT), DEFAULT_WORKTREE_NAME))
  );

  if (branches.length === 0) {
    throw new Error('--branches is required, comma-separated branch or ref names');
  }

  const commands = [];
  let mergeRecord = null;
  let auditRecord = null;
  let cardsRecord = null;
  let audioRecord = null;
  let harnessRecord = null;
  let scopedEvidenceRefresh = null;
  let globalReportRestored = false;
  let report = null;
  let setupOk = false;

  try {
    safeRemoveWorktree(worktreeDir);
    commands.push(run('git', ['worktree', 'add', '--detach', worktreeDir, base]));
    setupOk = true;

    mergeRecord = run('git', ['merge', '--no-edit', ...branches], {
      cwd: worktreeDir,
      allowFailure: true,
    });
    commands.push(mergeRecord);

    if (mergeRecord.ok) {
      const originalQualityReport = preserveQualityReport(worktreeDir);
      auditRecord = run('node', ['scripts/audit_card_quality.mjs', '--write-report'], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      if (auditRecord.ok) report = readQualityReport(worktreeDir);
      if (auditRecord.ok && refreshEvidence) {
        scopedEvidenceRefresh = refreshScopedEvidence(worktreeDir);
        commands.push(...scopedEvidenceRefresh.commands);
        restoreQualityReport(worktreeDir, originalQualityReport);
        globalReportRestored = true;
      }
      cardsRecord = run('node', ['scripts/validate_cards.mjs'], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      audioRecord = run('node', ['scripts/validate_audio_qc.mjs'], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      harnessRecord = run('node', ['scripts/validate_harness.mjs'], {
        cwd: worktreeDir,
        allowFailure: true,
      });
      commands.push(auditRecord, cardsRecord, audioRecord, harnessRecord);
    }
  } finally {
    if (!keepWorktree && setupOk) {
      safeRemoveWorktree(worktreeDir);
    }
  }

  const auditJson = auditRecord ? parseJsonOutput(auditRecord) : null;
  const cardsJson = cardsRecord ? parseJsonOutput(cardsRecord) : null;
  const audioJson = audioRecord ? parseJsonOutput(audioRecord) : null;
  const harnessJson = harnessRecord ? parseJsonOutput(harnessRecord) : null;
  const leaks = report ? frontLeakCount(report) : null;
  const blockingFailures = [];

  if (!mergeRecord?.ok) blockingFailures.push('merge_failed');
  if (!auditRecord?.ok) blockingFailures.push('quality_audit_failed');
  if (!cardsJson?.ok) blockingFailures.push('card_validation_failed');
  if (!audioJson?.ok) blockingFailures.push('audio_qc_failed');
  if (refreshEvidence && !scopedEvidenceRefresh?.ok) blockingFailures.push('scoped_evidence_refresh_failed');
  if (!allowFrontLeaks && leaks !== 0) blockingFailures.push('front_answer_leaks_remain');
  if (requireHarness && !harnessJson?.ok) blockingFailures.push('harness_failed');

  const result = {
    ok: blockingFailures.length === 0,
    base,
    branches,
    worktree_dir: keepWorktree ? worktreeDir : null,
    front_answer_leaks: leaks,
    quality_audit: auditJson ? {
      ok: auditJson.ok,
      corpus_digest: auditJson.corpus_digest,
      total_issues: auditJson.total_issues,
      by_severity: auditJson.by_severity,
      front_leaks: leaks,
    } : null,
    card_validation: cardsJson ? {
      ok: cardsJson.ok,
      errors: cardsJson.errors,
      warnings: cardsJson.warnings,
      stats: cardsJson.stats,
    } : null,
    audio_qc: audioJson ? {
      ok: audioJson.ok,
      errors: audioJson.errors,
      warnings: audioJson.warnings,
      records_checked: audioJson.records_checked,
    } : null,
    scoped_evidence_refresh: refreshEvidence ? {
      ok: scopedEvidenceRefresh?.ok === true,
      refreshed_scoped_reports: scopedEvidenceRefresh?.refreshed_scoped_reports || [],
      changed_review_records: scopedEvidenceRefresh?.changed_review_records || [],
      skipped: scopedEvidenceRefresh?.skipped || [],
      failures: scopedEvidenceRefresh?.failures || [],
      global_report_restored_before_harness: globalReportRestored,
    } : null,
    harness: harnessJson ? {
      ok: harnessJson.ok,
      error_count: Array.isArray(harnessJson.errors) ? harnessJson.errors.length : null,
      warning_count: Array.isArray(harnessJson.warnings) ? harnessJson.warnings.length : null,
      first_errors: Array.isArray(harnessJson.errors) ? harnessJson.errors.slice(0, 5) : [],
      first_warnings: Array.isArray(harnessJson.warnings) ? harnessJson.warnings.slice(0, 5) : [],
    } : null,
    blocking_failures: blockingFailures,
    commands: commands.map(summarizeCommand),
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  const result = {
    ok: false,
    error: error.message,
    command: error.record ? summarizeCommand(error.record) : null,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}
