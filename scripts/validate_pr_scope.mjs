import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_BASE = 'origin/fix/review-findings-card-contract';
const GLOBAL_REPORT_PATHS = new Set([
  'reports/card_quality_audit_report.json',
  'reports/card_validation_report.json',
]);

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`;
    throw new Error(message);
  }
  return result.stdout;
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
      warnings.push({
        code: 'content_sample_multiple_scope_prefixes',
        prefixes: [...primaryPrefixes].sort(),
        message: 'Multiple box prefixes changed; confirm this is intentional and still a single review unit.',
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
