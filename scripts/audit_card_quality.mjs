import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');
const SPEC_PATH = path.join(ROOT, 'spec', 'card-quality-audit.json');
const REPORT_PATH = path.join(ROOT, 'reports', 'card_quality_audit_report.json');
const DEFAULT_MAX_EXAMPLES = 5;

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
  return textOf(card.front?.text, card.front?.prompt, card.front_content?.text, card.front_content?.task_prompt);
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
  return normalizeText(option?.text || option?.label || option?.value || option);
}

function extractOptions(card) {
  const candidates = [
    card.front?.options,
    card.front_content?.options,
    card.options,
    card.form_options,
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length > 0) {
      return value.map(normalizeOption).filter(Boolean);
    }
  }
  return [];
}

function extractAnswerText(card) {
  const answer = card.analysis?.answer
    ?? card.answer_key?.answer
    ?? card.answer_key?.correct_answer
    ?? card.correct_answer
    ?? card.back_content?.answer;
  return normalizeText(answer);
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

function walkCards() {
  const files = fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();

  const rows = [];
  for (const file of files) {
    const data = readJson(path.join(CARD_DIR, file));
    if (!Array.isArray(data.cards)) continue;
    for (const card of data.cards) {
      rows.push({ file, card });
    }
  }
  return rows;
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
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

function buildAudit({ maxExamples }) {
  const spec = readJson(SPEC_PATH);
  const rulesById = new Map((spec.rules || []).map(rule => [rule.id, rule]));
  const rows = walkCards();
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
    const options = extractOptions(card);
    const answerText = extractAnswerText(card);

    if (card.interaction_id === 'multiple_choice') {
      if (options.length < 2) {
        addIssue(issues, rulesById, row, 'multiple_choice_no_options', 'Multiple-choice card has fewer than two visible options.', frontText, analysisText);
      } else if (answerText && !options.some(option => option === answerText)) {
        addIssue(issues, rulesById, row, 'multiple_choice_answer_not_in_options', 'Multiple-choice answer is not one of the visible options.', frontText, analysisText);
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

    const sourceType = card.source_ref?.type || card.quality_metadata?.material?.text_source_type || '';
    if (/ai_generated|synthetic|simulation|simulated/.test(String(sourceType))) {
      addIssue(issues, rulesById, row, 'synthetic_source', `Source type is ${sourceType}.`, frontText, analysisText);
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
    scope: {
      card_dir: path.relative(ROOT, CARD_DIR),
      files: summary.total_files,
      cards: summary.total_cards,
    },
    summary,
    examples,
  };
}

function readOptionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const writeReport = process.argv.includes('--write-report');
const maxExamples = readOptionValue('--max-examples', DEFAULT_MAX_EXAMPLES);
const audit = buildAudit({ maxExamples });

if (writeReport) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
}

const topRules = Object.entries(audit.summary.by_rule)
  .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
  .slice(0, 10)
  .map(([rule_id, data]) => ({ rule_id, ...data }));

console.log(JSON.stringify({
  ok: audit.ok,
  mode: audit.mode,
  report_path: writeReport ? audit.report_path : null,
  cards: audit.summary.total_cards,
  total_issues: audit.summary.total_issues,
  by_severity: audit.summary.by_severity,
  top_rules: topRules,
}, null, 2));
