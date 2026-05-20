import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');
const SPEC_PATH = path.join(ROOT, 'spec', 'card-quality-audit.json');
const REPORT_PATH = path.join(ROOT, 'reports', 'card_quality_audit_report.json');
const SCOPED_REPORT_DIR = path.join(ROOT, 'reviews', 'audit_scopes');
const DEFAULT_MAX_EXAMPLES = 5;
const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const GENERIC_FRONT_PATTERNS = [
  /^任务：先听音频，完成.+训练。$/,
  /^【CET[46]专项语境】.*判断.*是否.*等值/,
  /^什么是.+？$/,
  /^根据提示完成.+训练。$/,
];

const TEMPLATE_ANALYSIS_PATTERNS = [
  /本卡聚焦.+关键词、限定词、句法位置或语义转折/,
  /这类题的本质不是记答案，而是建立稳定的判断顺序/,
  /这张卡的核心不在单个词义，而在.+对应的结构线索/,
  /先判断信息结构，再做答案选择，避免词面匹配先行/,
];

const ANSWER_LEAK_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'being',
  'between',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'or',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'was',
  'were',
  'with',
  'without',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.values(value).map(normalizeText).filter(Boolean).join(' ');
  }
  return String(value).trim();
}

function excerpt(value, maxLength = 120) {
  const text = normalizeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function textOf(...values) {
  return normalizeText(values.filter(value => value !== null && value !== undefined));
}

function extractFrontText(card) {
  return textOf(
    card.front?.text,
    card.front?.prompt,
    card.front?.task_prompt,
    card.front?.instruction,
    card.front?.question,
    card.front?.stem,
    card.front_content?.text,
    card.front_content?.prompt,
    card.front_content?.task_prompt,
    card.front_content?.instruction,
    card.front_content?.question,
    card.front_content?.stem
  );
}

function extractAnalysisText(card) {
  return textOf(
    card.analysis?.text,
    card.analysis?.value,
    card.analysis_content?.text,
    card.analysis_content?.value
  );
}

function normalizeOption(option) {
  if (typeof option === 'string') return normalizeText(option);
  return normalizeText(option?.text || option?.form || option?.label || option?.value || option);
}

function extractOptionRecords(card) {
  const candidates = [
    card.front?.options,
    card.front_content?.options,
    card.options,
    card.form_options,
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length > 0) {
      return value
        .map((option, index) => ({
          key: normalizeText(typeof option === 'object' ? option?.key ?? option?.option_key ?? OPTION_KEYS[index] : OPTION_KEYS[index]),
          text: normalizeOption(option),
          is_correct: typeof option === 'object' ? option?.is_correct === true : false,
        }))
        .filter(option => option.key || option.text);
    }
  }
  return [];
}

function extractAnswerRecord(card, optionRecords) {
  const explicitAnswer = card.answer_key?.correct_option
    ?? card.answer_key?.answer
    ?? card.answer_key?.correct_answer
    ?? card.correct_answer
    ?? card.analysis?.answer
    ?? card.back_content?.answer;
  const explicitText = normalizeText(explicitAnswer);
  if (explicitText) return { text: explicitText, source: 'explicit' };

  const correctOptions = optionRecords.filter(option => option.is_correct);
  if (correctOptions.length === 1) {
    return {
      text: correctOptions[0].key || correctOptions[0].text,
      source: 'option_is_correct',
    };
  }
  return { text: '', source: 'missing' };
}

function answerMatchesOptions(answerText, optionRecords) {
  return optionRecords.some(option => option.key === answerText || option.text === answerText);
}

function normalizeForSearch(value) {
  return normalizeText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchTokens(value) {
  return normalizeForSearch(value).split(' ').filter(Boolean);
}

function tokenAppears(normalizedText, token) {
  if (!normalizedText || !token) return false;
  if (/[\u4e00-\u9fff]/.test(token)) return normalizedText.includes(token);
  return normalizedText.split(' ').includes(token);
}

function containsSearchPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return false;
  if (normalizedPhrase.includes(' ')) {
    return normalizedText === normalizedPhrase ||
      normalizedText.startsWith(`${normalizedPhrase} `) ||
      normalizedText.endsWith(` ${normalizedPhrase}`) ||
      normalizedText.includes(` ${normalizedPhrase} `);
  }
  return tokenAppears(normalizedText, normalizedPhrase);
}

function isDistinctiveAnswerToken(token) {
  if (!token) return false;
  if (/^\d+$/.test(token)) return true;
  if (/[\u4e00-\u9fff]/.test(token)) return token.length >= 2;
  return token.length >= 3 && !ANSWER_LEAK_STOPWORDS.has(token);
}

function dedupeOptionRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const key = `${record.key}\0${record.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function extractCorrectOptionRecords(optionRecords, answer) {
  const answerText = normalizeText(answer.text);
  const normalizedAnswerText = normalizeForSearch(answerText);
  const byAnswer = answerText
    ? optionRecords.filter(option =>
      option.key === answerText ||
      option.text === answerText ||
      normalizeForSearch(option.text) === normalizedAnswerText
    )
    : [];
  const byFlag = optionRecords.filter(option => option.is_correct);
  return dedupeOptionRecords([...byAnswer, ...byFlag]);
}

function extractOptionAnswerHead(optionText) {
  const raw = normalizeText(optionText);
  if (!raw) return '';

  const hasPickPrefix = /^选\s+/.test(raw);
  const withoutPickPrefix = raw.replace(/^选\s+/, '').trim();
  const delimiterIndexes = ['：', ':', '（', '(']
    .map(delimiter => withoutPickPrefix.indexOf(delimiter))
    .filter(index => index > 0);
  if (delimiterIndexes.length > 0) {
    const head = withoutPickPrefix.slice(0, Math.min(...delimiterIndexes)).trim();
    if (hasPickPrefix || (head.length <= 30 && searchTokens(head).length <= 5 && !/[，。；;]/.test(head))) {
      return head;
    }
  }
  return withoutPickPrefix;
}

function isExplanatoryOptionText(optionText) {
  return /[\u4e00-\u9fff]/.test(optionText) &&
    /[，。；;]|空格|主语|谓语|应|需|需要|说明|优先|判断|搭配|后接|修饰|表示/.test(optionText);
}

function stripVisibleChoiceLists(frontText) {
  return normalizeText(frontText)
    .replace(/(?:word bank|词库|[\u4e00-\u9fff]*候选)[^。！？!?]*(?:[。！？!?]|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionLeakCandidateTexts(optionText) {
  const raw = normalizeText(optionText);
  const head = extractOptionAnswerHead(raw);
  if (head && head !== raw) return [head];
  if (isExplanatoryOptionText(raw)) return [];
  if (raw.length > 40 || searchTokens(raw).length > 8) return [];
  return raw ? [raw] : [];
}

function findFrontAnswerLeakFragments(frontText, optionRecords, answer) {
  const normalizedFront = normalizeForSearch(stripVisibleChoiceLists(frontText));
  if (!normalizedFront) return [];

  const fragments = new Set();
  for (const option of extractCorrectOptionRecords(optionRecords, answer)) {
    for (const optionText of optionLeakCandidateTexts(option.text)) {
      const normalizedOptionText = normalizeForSearch(optionText);
      if (!optionText || !normalizedOptionText) continue;

      if (
        (normalizedOptionText.length >= 3 || /[\u4e00-\u9fff]/.test(normalizedOptionText)) &&
        containsSearchPhrase(normalizedFront, normalizedOptionText)
      ) {
        fragments.add(optionText);
      }

      const tokens = searchTokens(optionText).filter(isDistinctiveAnswerToken);
      if (tokens.length === 1 && containsSearchPhrase(normalizedFront, tokens[0])) {
        fragments.add(tokens[0]);
      }
      for (let index = 0; index < tokens.length - 1; index += 1) {
        const phrase = `${tokens[index]} ${tokens[index + 1]}`;
        if (containsSearchPhrase(normalizedFront, phrase)) {
          fragments.add(phrase);
        }
      }
    }
  }
  return [...fragments];
}

function cardLocation(file, card) {
  const ref = card.knowledge_ref || {};
  const library = ref.library_name || ref.library || card.library_name || card.card_library_name || card.library;
  const group = ref.group_name || ref.group || card.group_name || card.card_group_name || card.group;
  const box = ref.box_name || ref.box || card.box_name || card.card_box_name || card.box;
  return {
    file,
    card_id: String(card.card_id || ''),
    track: card.track || ref.track || null,
    library: library ?? null,
    group: group ?? null,
    box: box ?? null,
    box_prefix: ref.box_prefix || card.card_box_code || null,
    interaction_id: card.interaction_id || null,
  };
}

function listCardFiles() {
  return fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();
}

function walkCards() {
  const files = listCardFiles();

  const rows = [];
  for (const file of files) {
    const data = readJson(path.join(CARD_DIR, file));
    if (!Array.isArray(data.cards)) continue;
    for (const card of data.cards) {
      rows.push({ file, card });
    }
  }
  return { files, rows };
}

function computeCorpusFingerprint(files, cardCount) {
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
    card_count: cardCount,
    digest: hash.digest('hex'),
  };
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function emptySeverityCounts() {
  return {
    hard_blocker: 0,
    content_risk: 0,
    review_gap: 0,
    source_risk: 0,
  };
}

function ensureRuleCounts(summary, rulesById) {
  for (const ruleId of rulesById.keys()) {
    if (!summary.by_rule[ruleId]) {
      summary.by_rule[ruleId] = {
        count: 0,
        severity: rulesById.get(ruleId).severity,
      };
    }
  }
}

function numericCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sortedUnique(values) {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))].sort();
}

function buildScopedAuditReport(audit, scopeCardIds) {
  const cardIds = sortedUnique(scopeCardIds);
  const ruleIds = Object.keys(audit.summary.by_rule || {}).sort();
  const scopedCardIssueIndex = {};
  const missingCardIds = [];
  const scopedIds = new Set(cardIds);
  const scopeSummary = {
    card_ids: cardIds,
    card_count: cardIds.length,
    issue_count: 0,
    by_severity: emptySeverityCounts(),
    by_rule: Object.fromEntries(ruleIds.map(ruleId => [ruleId, 0])),
  };

  for (const cardId of cardIds) {
    const record = audit.card_issue_index?.[cardId];
    if (!record) {
      missingCardIds.push(cardId);
      continue;
    }
    scopedCardIssueIndex[cardId] = record;
    scopeSummary.issue_count += numericCount(record.issue_count);
    for (const severity of Object.keys(scopeSummary.by_severity)) {
      scopeSummary.by_severity[severity] += numericCount(record.by_severity?.[severity]);
    }
    for (const ruleId of ruleIds) {
      scopeSummary.by_rule[ruleId] += numericCount(record.by_rule?.[ruleId]);
    }
  }

  const scopedHardBlockers = (audit.hard_blocker_issues || [])
    .filter(issue => scopedIds.has(issue.card_id));

  return {
    ok: missingCardIds.length === 0,
    audit_version: audit.audit_version,
    mode: audit.mode,
    report_type: 'scoped_card_quality_audit',
    corpus_fingerprint: audit.corpus_fingerprint,
    scope: {
      card_dir: audit.scope.card_dir,
      card_ids: cardIds,
      missing_card_ids: missingCardIds,
    },
    scope_summary: scopeSummary,
    scoped_card_issue_index: scopedCardIssueIndex,
    scoped_hard_blocker_issues: scopedHardBlockers,
  };
}

function addIssue(issues, rulesById, row, ruleId, message, frontText, analysisText) {
  const rule = rulesById.get(ruleId);
  if (!rule) throw new Error(`Rule is not declared in ${path.relative(ROOT, SPEC_PATH)}: ${ruleId}`);
  issues.push({
    rule_id: ruleId,
    severity: rule.severity,
    message,
    ...cardLocation(row.file, row.card),
    front_excerpt: excerpt(frontText),
    analysis_excerpt: excerpt(analysisText),
  });
}

function sourceTypesOf(card) {
  return [
    card.source_ref?.type,
    card.quality_metadata?.material?.text_source_type,
  ]
    .map(value => normalizeText(value))
    .filter(Boolean);
}

function buildCardIssueIndex(rows, issues) {
  const index = {};
  for (const row of rows) {
    const location = cardLocation(row.file, row.card);
    index[location.card_id] = {
      ...location,
      issue_count: 0,
      by_severity: emptySeverityCounts(),
      by_rule: {},
    };
  }

  for (const issue of issues) {
    if (!index[issue.card_id]) {
      index[issue.card_id] = {
        file: issue.file,
        card_id: issue.card_id,
        track: issue.track,
        library: issue.library,
        group: issue.group,
        box: issue.box,
        box_prefix: issue.box_prefix,
        interaction_id: issue.interaction_id,
        issue_count: 0,
        by_severity: emptySeverityCounts(),
        by_rule: {},
      };
    }
    const record = index[issue.card_id];
    record.issue_count += 1;
    increment(record.by_severity, issue.severity);
    increment(record.by_rule, issue.rule_id);
  }

  return index;
}

function buildAudit({ maxExamples }) {
  const spec = readJson(SPEC_PATH);
  const rulesById = new Map((spec.rules || []).map(rule => [rule.id, rule]));
  const { files, rows } = walkCards();
  const frontCounts = new Map();
  const analysisCounts = new Map();

  for (const row of rows) {
    const frontText = extractFrontText(row.card);
    const analysisText = extractAnalysisText(row.card);
    if (frontText) frontCounts.set(frontText, (frontCounts.get(frontText) || 0) + 1);
    if (analysisText) analysisCounts.set(analysisText, (analysisCounts.get(analysisText) || 0) + 1);
  }

  const issues = [];
  for (const row of rows) {
    const { card } = row;
    const frontText = extractFrontText(card);
    const analysisText = extractAnalysisText(card);
    const optionRecords = extractOptionRecords(card);
    const answer = extractAnswerRecord(card, optionRecords);

    if (card.interaction_id === 'multiple_choice') {
      if (optionRecords.length < 2) {
        addIssue(issues, rulesById, row, 'multiple_choice_no_options', 'Multiple-choice card has fewer than two visible options.', frontText, analysisText);
      } else if (!answer.text || !answerMatchesOptions(answer.text, optionRecords)) {
        addIssue(issues, rulesById, row, 'multiple_choice_answer_not_in_options', 'Multiple-choice answer key does not match a visible option key or text.', frontText, analysisText);
      } else {
        const leakedFragments = findFrontAnswerLeakFragments(frontText, optionRecords, answer);
        if (leakedFragments.length > 0) {
          addIssue(
            issues,
            rulesById,
            row,
            'front_leaks_correct_answer',
            `Front-side prompt names the correct option outside the visible option list: ${leakedFragments.slice(0, 3).join(', ')}.`,
            frontText,
            analysisText
          );
        }
      }
    }

    if (frontText.length < 12) {
      addIssue(issues, rulesById, row, 'front_missing_or_too_short', 'Front side is missing or shorter than 12 normalized characters.', frontText, analysisText);
    }

    if (analysisText.length < 90) {
      addIssue(issues, rulesById, row, 'analysis_missing_or_too_short', 'Analysis is missing or shorter than 90 normalized characters.', frontText, analysisText);
    }

    if (GENERIC_FRONT_PATTERNS.some(pattern => pattern.test(frontText))) {
      addIssue(issues, rulesById, row, 'generic_front_pattern', 'Front side matches a generic or template-like prompt pattern.', frontText, analysisText);
    }

    if (TEMPLATE_ANALYSIS_PATTERNS.some(pattern => pattern.test(analysisText))) {
      addIssue(issues, rulesById, row, 'template_analysis_pattern', 'Analysis matches a repeated generic explanation pattern.', frontText, analysisText);
    }

    if (frontText && (frontCounts.get(frontText) || 0) > 1) {
      addIssue(issues, rulesById, row, 'exact_repeated_front', 'Normalized front side is exactly repeated elsewhere in the corpus.', frontText, analysisText);
    }

    if (analysisText && (analysisCounts.get(analysisText) || 0) > 1) {
      addIssue(issues, rulesById, row, 'exact_repeated_analysis', 'Normalized analysis is exactly repeated elsewhere in the corpus.', frontText, analysisText);
    }

    if (!card.quality_metadata || Object.keys(card.quality_metadata).length === 0) {
      addIssue(issues, rulesById, row, 'missing_quality_metadata', 'Card has no quality_metadata block.', frontText, analysisText);
    }

    const provenanceStatus = card.source_ref?.provenance_status || 'missing';
    if (provenanceStatus === 'missing' || provenanceStatus === 'unverified') {
      addIssue(issues, rulesById, row, 'unverified_source', `Source provenance status is ${provenanceStatus}.`, frontText, analysisText);
    }

    const syntheticSourceTypes = sourceTypesOf(card)
      .filter(sourceType => /ai_generated|synthetic|simulation|simulated/.test(sourceType));
    if (syntheticSourceTypes.length > 0) {
      addIssue(issues, rulesById, row, 'synthetic_source', `Source type includes ${syntheticSourceTypes.join(', ')}.`, frontText, analysisText);
    }
  }

  const summary = {
    total_files: new Set(rows.map(row => row.file)).size,
    total_cards: rows.length,
    total_issues: issues.length,
    cards_with_issues: new Set(issues.map(issue => issue.card_id)).size,
    by_severity: {
      hard_blocker: 0,
      content_risk: 0,
      review_gap: 0,
      source_risk: 0,
    },
    by_rule: {},
    by_library: {},
    top_boxes: [],
  };
  const examples = {};
  const boxCounts = {};

  for (const issue of issues) {
    increment(summary.by_severity, issue.severity);
    if (!summary.by_rule[issue.rule_id]) {
      summary.by_rule[issue.rule_id] = {
        count: 0,
        severity: issue.severity,
      };
    }
    summary.by_rule[issue.rule_id].count += 1;

    const libraryKey = String(issue.library ?? 'unknown');
    if (!summary.by_library[libraryKey]) {
      summary.by_library[libraryKey] = {
        cards: 0,
        issues: 0,
        hard_blocker: 0,
        content_risk: 0,
        review_gap: 0,
        source_risk: 0,
      };
    }
    summary.by_library[libraryKey].issues += 1;
    increment(summary.by_library[libraryKey], issue.severity);

    const boxKey = [issue.track, issue.library, issue.group, issue.box_prefix, issue.box].filter(Boolean).join(' / ');
    increment(boxCounts, boxKey || 'unknown');

    if (!examples[issue.rule_id]) examples[issue.rule_id] = [];
    if (examples[issue.rule_id].length < maxExamples) {
      examples[issue.rule_id].push(issue);
    }
  }

  const seenCardsByLibrary = {};
  for (const row of rows) {
    const location = cardLocation(row.file, row.card);
    const libraryKey = String(location.library ?? 'unknown');
    if (!seenCardsByLibrary[libraryKey]) seenCardsByLibrary[libraryKey] = new Set();
    seenCardsByLibrary[libraryKey].add(location.card_id);
    if (!summary.by_library[libraryKey]) {
      summary.by_library[libraryKey] = {
        cards: 0,
        issues: 0,
        hard_blocker: 0,
        content_risk: 0,
        review_gap: 0,
        source_risk: 0,
      };
    }
  }
  for (const [libraryKey, cardIds] of Object.entries(seenCardsByLibrary)) {
    summary.by_library[libraryKey].cards = cardIds.size;
  }

  summary.top_boxes = Object.entries(boxCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([box, issue_count]) => ({ box, issue_count }));
  ensureRuleCounts(summary, rulesById);

  return {
    ok: true,
    audit_version: spec.version,
    mode: spec.mode,
    report_path: path.relative(ROOT, REPORT_PATH),
    corpus_fingerprint: computeCorpusFingerprint(files, rows.length),
    scope: {
      card_dir: path.relative(ROOT, CARD_DIR),
      files: summary.total_files,
      cards: summary.total_cards,
    },
    summary,
    card_issue_index: buildCardIssueIndex(rows, issues),
    hard_blocker_issues: issues.filter(issue => issue.severity === 'hard_blocker'),
    examples,
  };
}

function readOptionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  return process.argv[index + 1];
}

function readCsvOption(name) {
  const value = readOption(name, '');
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const writeReport = process.argv.includes('--write-report');
const scopeCardIds = readCsvOption('--scope-card-ids');
const scopedReportPath = readOption('--write-scope-report');
const maxExamples = readOptionValue('--max-examples', DEFAULT_MAX_EXAMPLES);
const audit = buildAudit({ maxExamples });

if (writeReport) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
}

let scopedReport = null;
let scopedReportRelativePath = null;
if (scopedReportPath) {
  if (scopeCardIds.length === 0) {
    throw new Error('--write-scope-report requires --scope-card-ids');
  }
  const fullScopedReportPath = path.resolve(ROOT, scopedReportPath);
  const relativeScopedReportPath = path.relative(ROOT, fullScopedReportPath);
  const scopedReportDir = path.relative(ROOT, SCOPED_REPORT_DIR);
  if (relativeScopedReportPath !== scopedReportDir && !relativeScopedReportPath.startsWith(`${scopedReportDir}${path.sep}`)) {
    throw new Error('--write-scope-report must be under reviews/audit_scopes/');
  }
  scopedReport = buildScopedAuditReport(audit, scopeCardIds);
  scopedReportRelativePath = relativeScopedReportPath;
  fs.mkdirSync(path.dirname(fullScopedReportPath), { recursive: true });
  fs.writeFileSync(fullScopedReportPath, `${JSON.stringify(scopedReport, null, 2)}\n`);
}

const topRules = Object.entries(audit.summary.by_rule)
  .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
  .slice(0, 10)
  .map(([rule_id, data]) => ({ rule_id, ...data }));

console.log(JSON.stringify({
  ok: audit.ok,
  mode: audit.mode,
  report_path: writeReport ? audit.report_path : null,
  scoped_report_path: scopedReportRelativePath,
  corpus_digest: audit.corpus_fingerprint.digest,
  cards: audit.summary.total_cards,
  total_issues: audit.summary.total_issues,
  by_severity: audit.summary.by_severity,
  scope_summary: scopedReport?.scope_summary || null,
  top_rules: topRules,
}, null, 2));

if (scopedReport && !scopedReport.ok) process.exit(1);
