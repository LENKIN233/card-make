import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
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
const MULTI_PREFIX_CONTENT_CHANGE_TYPES = new Set([
  'content_candidate_front_answer_leak_queue',
  'content_candidate_residual_blocker_closure',
]);
const CONTENT_NO_AUTO_MERGE_AUTHORITY = 'no_auto_merge_content_candidate_user_confirmation_required';
const REVIEW_TEMPLATE_PATHS = new Set([
  'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json',
  'reviews/agent_self_review/TEMPLATE.json',
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

function resolveCommit(ref) {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
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
      .slice(index, index + pathCount)
      .map(normalizePath);
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
  return /^card_boxes_json\/card_boxes_seed_(?:cet4|cet6)_[a-z0-9_]+_\d{4}\.json$/.test(filePath);
}

function isCardBoxDirectoryPath(filePath) {
  return filePath.startsWith('card_boxes_json/');
}

function isReviewTemplatePath(filePath) {
  return REVIEW_TEMPLATE_PATHS.has(filePath);
}

function isDraftPath(filePath) {
  return /^reviews\/drafts\/.+\.json$/.test(filePath) &&
    !isReviewTemplatePath(filePath);
}

function isSelfReviewPath(filePath) {
  return /^reviews\/agent_self_review\/.+\.json$/.test(filePath) &&
    !isReviewTemplatePath(filePath);
}

function isHandoffPath(filePath) {
  return /^reviews\/git_handoffs\/.+\.json$/.test(filePath) &&
    !filePath.endsWith('/TEMPLATE.json');
}

function isScopedAuditPath(filePath) {
  return /^reviews\/audit_scopes\/.+\.json$/.test(filePath) &&
    !isReviewTemplatePath(filePath);
}

function isContentReviewPath(filePath) {
  if (isDraftPath(filePath) || isSelfReviewPath(filePath) || isScopedAuditPath(filePath)) {
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
  return runGit(['ls-tree', '-r', '--name-only', commit, '--', 'card_boxes_json'])
    .split('\n')
    .map(filePath => normalizePath(filePath.trim()))
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
        changedCards.push({ card_id: cardId, ...headOccurrences[0] });
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

      const matches = reviewsByCardId.get(cardId) || [];
      matches.push({
        review,
        path: filePath,
        review_index: index,
        scope_card_ids: scopeCardIds,
        mode: 'standard_snapshot',
      });
      reviewsByCardId.set(cardId, matches);

      if (!scopeCardIds.has(cardId)) {
        issues.push({
          code: 'changed_self_review_card_missing_from_scope',
          card_id: cardId,
          path: filePath,
          message: 'A changed self-review card entry must also be named in that record\'s scope.card_ids.',
        });
      }

      const corpusOccurrences = headCorpus.cardsById.get(cardId) || [];
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
    const snapshotMatches = matches.filter(match => match.mode === 'standard_snapshot');
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
    const scopedMatchingReviews = matchingReviews.filter(match => match.scope_card_ids.has(changedCard.card_id));
    if (matchingReviews.length !== 1 || scopedMatchingReviews.length !== 1) {
      issues.push({
        code: 'changed_card_self_review_count_invalid',
        library_code: matchingReviews.length === 0
          ? CARD_INTEGRITY_ISSUE_CODES.selfReviewMissing
          : 'candidate_self_review_ambiguous',
        card_id: changedCard.card_id,
        review_count: matchingReviews.length,
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
    runGit(['worktree', 'add', '--detach', worktreePath, base]);
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

  if (contentCandidate) {
    for (const entry of entries) {
      const statusType = entry.status[0] === '?' ? 'A' : entry.status[0];
      for (const filePath of entry.paths) {
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
    }

    if (!resolvedHead) {
      issues.push({
        code: 'content_candidate_explicit_head_required',
        message: 'Content-candidate scope validation requires --head <commit>; worktree-only mode cannot prove the complete HEAD corpus or current self-review parity.',
      });
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
