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

const SEMANTIC_ANSWER_GLOSS_GROUPS = [
  {
    id: 'probability_class',
    triggers: [
      'probability',
      'probabilities',
      'likelihood',
      'likelihoods',
      'risk',
      'risks',
      '概率',
      '可能性',
      '风险',
    ],
    leak_texts: [
      '发生可能性',
      '发生概率',
      '发生风险',
      '可能性类',
      '概率类',
      '风险程度',
    ],
  },
  {
    id: 'strong_evidence_class',
    triggers: [
      'strong',
      'compelling',
      'forceful',
      '有力',
    ],
    leak_texts: [
      '证据强度',
      '有力证据',
      '有力的证据',
      '足以支撑',
      '支撑结论',
      '支撑论点',
    ],
  },
  {
    id: 'practical_class',
    triggers: [
      'practical',
      'practicable',
      'feasible',
      'viable',
      '可行',
    ],
    leak_texts: [
      '可执行',
      '可落地',
      '落地性',
      '实用方案',
      '切实可行',
    ],
  },
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
  const seen = new Set();
  const uniqueValues = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    uniqueValues.push(text);
  }
  return normalizeText(uniqueValues);
}

function extractFrontText(card) {
  return textOf(
    card.front?.text,
    card.front?.prompt,
    card.front?.task_prompt,
    card.front?.instruction,
    card.front?.question,
    card.front?.stem,
    card.front?.task_schema?.action,
    card.front?.task_schema?.focus,
    card.front?.task_schema?.success_criteria,
    card.front_content?.text,
    card.front_content?.prompt,
    card.front_content?.task_prompt,
    card.front_content?.instruction,
    card.front_content?.question,
    card.front_content?.stem,
    card.front_content?.task_schema?.action,
    card.front_content?.task_schema?.focus,
    card.front_content?.task_schema?.success_criteria
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
    const hasMultipleRoleLabels = /^[\u4e00-\u9fff]{1,8}$/.test(head) && /[；;].*[:：]/.test(withoutPickPrefix);
    if (hasMultipleRoleLabels) return '';
    if (hasPickPrefix || (head.length <= 30 && searchTokens(head).length <= 5 && !/[，。；;]/.test(head))) {
      return head;
    }
  }
  return withoutPickPrefix;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flexibleTextPattern(value) {
  return normalizeText(value)
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');
}

function isExplanatoryOptionText(optionText) {
  return /[\u4e00-\u9fff]/.test(optionText) &&
    /[，。；;]|空格|主语|谓语|应|需|需要|说明|优先|判断|搭配|后接|修饰|表示/.test(optionText);
}

function extractOptionExampleTexts(optionText) {
  const raw = normalizeText(optionText);
  if (!raw) return [];

  const examples = [];
  const addExample = value => {
    const cleaned = normalizeText(value)
      .replace(/^如\s*/u, '')
      .replace(/^(?:e\.g\.|for example)\s*/iu, '')
      .trim();
    if (!/^[A-Za-z][A-Za-z0-9 -]{2,40}$/.test(cleaned)) return;
    if (searchTokens(cleaned).some(isDistinctiveAnswerToken)) examples.push(cleaned);
  };

  for (const match of raw.matchAll(/[（(]([^）)]*[A-Za-z][^）)]*)[）)]/gu)) {
    addExample(match[1]);
  }
  for (const match of raw.matchAll(/(?:^|[\s，,；;])(?:如|e\.g\.|for example)\s+([A-Za-z][A-Za-z0-9 -]{2,40})/giu)) {
    addExample(match[1]);
  }

  return [...new Set(examples)];
}

function extractSemanticAnswerGlossTexts(optionText) {
  const raw = normalizeText(optionText);
  if (!raw) return [];

  const normalizedRaw = normalizeForSearch(raw);
  const leakTexts = [];
  for (const group of SEMANTIC_ANSWER_GLOSS_GROUPS) {
    const matched = group.triggers.some(trigger =>
      containsSearchPhrase(normalizedRaw, normalizeForSearch(trigger))
    );
    if (matched) leakTexts.push(...group.leak_texts);
  }
  return [...new Set(leakTexts)];
}

function visibleOptionRowPattern(option) {
  const key = normalizeText(option.key);
  const optionText = normalizeText(option.text);
  if (!key || !optionText) return '';
  return `${escapeRegExp(key)}\\s*[\\).．、]\\s*${flexibleTextPattern(optionText)}`;
}

function stripVisibleChoiceLists(frontText, optionRecords = []) {
  let text = normalizeText(frontText);
  const optionRowPatterns = optionRecords.map(visibleOptionRowPattern).filter(Boolean);
  if (optionRowPatterns.length >= 2) {
    const visibleOptionListPattern = new RegExp(
      `(^|\\s)${optionRowPatterns.join('\\s+')}(?=\\s|$)`,
      'giu'
    );
    text = text.replace(visibleOptionListPattern, ' ');
  }
  for (const option of optionRecords) {
    const rowPattern = visibleOptionRowPattern(option);
    if (!rowPattern) continue;
    const visibleOptionPattern = new RegExp(
      `(^|\\s)${rowPattern}(?=\\s+[A-Z]\\s*[\\).．、]|\\s*$)`,
      'giu'
    );
    text = text.replace(visibleOptionPattern, ' ');
  }
  return normalizeText(text)
    .replace(/(?:word bank|词库|[\u4e00-\u9fff]*候选)[^。！？!?]*(?:[。！？!?]|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLabeledMaterialSegments(frontText) {
  let text = normalizeText(frontText);
  const promptBoundaries = [
    '改写',
    '题干',
    '问题',
    '以下',
    '下列',
    '哪一项',
    '哪项',
    '哪个',
    '哪一个',
    '这里',
    '这组',
    '为什么',
    '请选择',
    '判断',
    '回答',
    '本题',
  ].join('|');
  const materialLabels = [
    '阅读片段',
    '对话片段',
    '原文片段',
    '原文',
    '改写',
    '材料',
    '语境',
    '句子',
    '例句',
  ].join('|');

  const materialSegmentPattern = new RegExp(
    `(^|\\s)(?:${materialLabels})\\s*[:：]\\s*.*?(?=\\s*(?:${promptBoundaries})\\s*[:：]?)`,
    'giu'
  );
  text = text.replace(materialSegmentPattern, ' ');

  const quotedMaterialPattern = new RegExp(
    `(^|\\s)(?:${materialLabels})\\s*[:：]\\s*[\"“][^\"”]+[\"”]`,
    'giu'
  );
  text = text.replace(quotedMaterialPattern, ' ');

  text = text.replace(
    /(^|\s)["“][^"”]*_{2,}[^"”]*["”]/giu,
    ' '
  );
  text = text.replace(
    /(^|\s)[^。！？!?]*_{2,}[^。！？!?]*(?=\s*(?:空格|哪|为何|为什么|这里|下列|以下|请选择|判断|回答|本题))/giu,
    ' '
  );

  return normalizeText(text);
}

function optionTextAppearsInSetHint(normalizedSetHint, optionText) {
  const normalizedOptionText = normalizeForSearch(optionText);
  if (containsSearchPhrase(normalizedSetHint, normalizedOptionText)) return true;
  const distinctiveTokens = searchTokens(optionText).filter(isDistinctiveAnswerToken);
  return distinctiveTokens.length > 0 &&
    distinctiveTokens.every(token => containsSearchPhrase(normalizedSetHint, token));
}

function stripOptionSetHints(frontText, optionRecords = []) {
  const optionTexts = optionRecords
    .map(option => normalizeText(option.text))
    .filter(Boolean);
  if (optionTexts.length < 2) return normalizeText(frontText);

  return normalizeText(frontText).replace(
    /[a-z][a-z\s]*(?:\s*(?:\/|vs\.?|versus)\s*[a-z][a-z\s]*)+/giu,
    match => {
      const normalizedMatch = normalizeForSearch(match);
      const matchedOptions = optionTexts.filter(optionText =>
        optionTextAppearsInSetHint(normalizedMatch, optionText)
      );
      return matchedOptions.length >= 2 ? ' ' : match;
    }
  );
}

function stripNonPromptAnswerLeakText(frontText, optionRecords = []) {
  return stripOptionSetHints(
    stripLabeledMaterialSegments(stripVisibleChoiceLists(frontText, optionRecords)),
    optionRecords
  );
}

function optionLeakCandidateTexts(optionText) {
  const raw = normalizeText(optionText);
  const exampleTexts = extractOptionExampleTexts(raw);
  const semanticGlossTexts = extractSemanticAnswerGlossTexts(raw);
  const head = extractOptionAnswerHead(raw);
  if (head && head !== raw) return [...new Set([head, ...exampleTexts, ...semanticGlossTexts])];
  if (isExplanatoryOptionText(raw)) return [...new Set([...exampleTexts, ...semanticGlossTexts])];
  if (raw.length > 40 || searchTokens(raw).length > 8) return [];
  return raw ? [...new Set([raw, ...exampleTexts, ...semanticGlossTexts])] : [...new Set([...exampleTexts, ...semanticGlossTexts])];
}

function findFrontAnswerLeakFragments(frontText, optionRecords, answer) {
  const normalizedFront = normalizeForSearch(stripNonPromptAnswerLeakText(frontText, optionRecords));
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

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTest() {
  const visibleOptionList = {
    frontText: '句子填空：The committee has yet to decide _____ the project should be scaled down or completely restructured. 选择正确的连接词： A. that B. what C. whether D. which',
    optionRecords: [
      { key: 'A', text: 'that' },
      { key: 'B', text: 'what' },
      { key: 'C', text: 'whether' },
      { key: 'D', text: 'which' },
    ],
    answer: { text: 'C' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(visibleOptionList.frontText, visibleOptionList.optionRecords, visibleOptionList.answer).length === 0,
    'Visible A/B/C/D option lists must not be treated as front-answer leakage.'
  );

  const leakedPrompt = {
    frontText: '播放音频后，选出最需要用弱读还原的片段。重点听 have to：to 很轻，不会像单独读单词时那么完整。',
    optionRecords: [
      { key: 'A', text: 'have to' },
      { key: 'B', text: 'finance office' },
      { key: 'C', text: 'data proposal' },
      { key: 'D', text: 'before midnight' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(leakedPrompt.frontText, leakedPrompt.optionRecords, leakedPrompt.answer).includes('have to'),
    'Prompt text outside the visible option list must still trigger front-answer leakage.'
  );

  const visibleListAndLeak = {
    frontText: '重点听 have to 的弱读。 A. have to B. finance office C. data proposal D. before midnight',
    optionRecords: leakedPrompt.optionRecords,
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(visibleListAndLeak.frontText, visibleListAndLeak.optionRecords, visibleListAndLeak.answer).includes('have to'),
    'Stripping a visible option row must not hide the same answer leaked elsewhere in the prompt.'
  );

  const visibleTaskSchemaGuideLeakCard = {
    front_content: {
      text: '播放音频后，选出最需要用弱读还原的片段。',
      task_schema: {
        action: '定位弱读片段',
        focus: 'have to 的弱读',
        success_criteria: '能根据听感判断弱读功能词',
      },
      options: [
        { key: 'A', text: 'have to' },
        { key: 'B', text: 'finance office' },
        { key: 'C', text: 'data proposal' },
        { key: 'D', text: 'before midnight' },
      ],
    },
    answer_key: { correct_option: 'A' },
  };
  const visibleTaskSchemaGuideLeakOptions = extractOptionRecords(visibleTaskSchemaGuideLeakCard);
  const visibleTaskSchemaGuideLeakAnswer = extractAnswerRecord(visibleTaskSchemaGuideLeakCard, visibleTaskSchemaGuideLeakOptions);
  assertSelfTest(
    findFrontAnswerLeakFragments(
      extractFrontText(visibleTaskSchemaGuideLeakCard),
      visibleTaskSchemaGuideLeakOptions,
      visibleTaskSchemaGuideLeakAnswer
    ).includes('have to'),
    'Preview-rendered task_schema guide text must be audited as visible front-side prompt text.'
  );

  const visibleOptionExampleListOnly = {
    frontText: 'When bond yields rise abruptly, investors usually ___ their exposure to long-duration assets. 空格处应先判断哪种词性？ A. 动词（如 reduce） B. 名词（如 reduction） C. 形容词（如 reduced） D. 介词（如 despite）',
    optionRecords: [
      { key: 'A', text: '动词（如 reduce）' },
      { key: 'B', text: '名词（如 reduction）' },
      { key: 'C', text: '形容词（如 reduced）' },
      { key: 'D', text: '介词（如 despite）' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(
      visibleOptionExampleListOnly.frontText,
      visibleOptionExampleListOnly.optionRecords,
      visibleOptionExampleListOnly.answer
    ).length === 0,
    'Example words inside the visible option list itself must not be treated as prompt leakage.'
  );

  const optionExampleLeakedGuideCard = {
    front_content: {
      text: 'When bond yields rise abruptly, investors usually ___ their exposure to long-duration assets. 空格处应先判断哪种词性？',
      task_schema: {
        action: '判断空格词性',
        focus: '用主语 investors、频度副词 usually 和宾语 exposure 判断谓语位置',
        success_criteria: '能先判定空格需要谓语动作词，再代回检查搭配 reduce exposure to 是否成立',
      },
      options: visibleOptionExampleListOnly.optionRecords,
    },
    answer_key: { correct_option: 'A' },
  };
  const optionExampleLeakedGuideOptions = extractOptionRecords(optionExampleLeakedGuideCard);
  const optionExampleLeakedGuideAnswer = extractAnswerRecord(optionExampleLeakedGuideCard, optionExampleLeakedGuideOptions);
  assertSelfTest(
    findFrontAnswerLeakFragments(
      extractFrontText(optionExampleLeakedGuideCard),
      optionExampleLeakedGuideOptions,
      optionExampleLeakedGuideAnswer
    ).includes('reduce'),
    'A correct option example word leaked through task_schema guide text must trigger front-answer leakage.'
  );

  const semanticGlossLeakedGuideCard = {
    front_content: {
      text: '"Scenario planning reduced the ___ of systemic failure by forcing institutions to test extreme assumptions." 先判断空格名词要表达哪类可量化对象。',
      task_schema: {
        action: '选择名词位答案',
        focus: '用 reduce 和 of systemic failure 判断空格名词的语义类型',
        success_criteria: '能说明空格需要可量化的发生可能性类名词，而不是抽象叙事或形容词',
      },
      options: [
        { key: 'A', text: 'architecture' },
        { key: 'B', text: '选 probability：与 reduce 搭配自然，且可直接接 of systemic failure 表示发生概率' },
        { key: 'C', text: 'narrative' },
        { key: 'D', text: 'adaptable' },
      ],
    },
    answer_key: { correct_option: 'B' },
  };
  const semanticGlossLeakedGuideOptions = extractOptionRecords(semanticGlossLeakedGuideCard);
  const semanticGlossLeakedGuideAnswer = extractAnswerRecord(semanticGlossLeakedGuideCard, semanticGlossLeakedGuideOptions);
  assertSelfTest(
    findFrontAnswerLeakFragments(
      extractFrontText(semanticGlossLeakedGuideCard),
      semanticGlossLeakedGuideOptions,
      semanticGlossLeakedGuideAnswer
    ).includes('发生可能性'),
    'A correct option semantic gloss leaked through task_schema guide text must trigger front-answer leakage.'
  );

  const strongEvidenceGlossLeakedGuide = {
    front_content: {
      text: '"The conclusion should be based on ___ evidence rather than personal preference." 从四个选项中选择最自然修饰 evidence 的词。',
      task_schema: {
        action: '选择形容词+名词搭配',
        focus: '判断 evidence 前的形容词是否表达足以支撑结论的证据强度',
        success_criteria: '能根据 evidence 的语域和句内对比关系选出自然修饰词',
      },
      options: [
        { key: 'A', text: 'powerful' },
        { key: 'B', text: 'strong' },
        { key: 'C', text: 'hard' },
        { key: 'D', text: 'solidly' },
      ],
    },
    answer_key: { correct_option: 'B' },
  };
  const strongEvidenceGlossLeakedGuideOptions = extractOptionRecords(strongEvidenceGlossLeakedGuide);
  const strongEvidenceGlossLeakedGuideAnswer = extractAnswerRecord(
    strongEvidenceGlossLeakedGuide,
    strongEvidenceGlossLeakedGuideOptions
  );
  const strongEvidenceGlossFragments = findFrontAnswerLeakFragments(
    extractFrontText(strongEvidenceGlossLeakedGuide),
    strongEvidenceGlossLeakedGuideOptions,
    strongEvidenceGlossLeakedGuideAnswer
  );
  assertSelfTest(
    strongEvidenceGlossFragments.includes('证据强度') &&
      strongEvidenceGlossFragments.includes('足以支撑') &&
      strongEvidenceGlossFragments.includes('支撑结论'),
    'A strength/evidence semantic gloss leaked through task_schema guide text must trigger front-answer leakage.'
  );

  const practicalGlossLeakedGuide = {
    front_content: {
      text: '"A ___ solution should reduce confusion without adding extra steps." 从四个选项中选择最自然修饰 solution 的词。',
      task_schema: {
        action: '选择形容词+名词搭配',
        focus: '判断 solution 前的修饰词是否表达可执行、可落地的方案性质',
        success_criteria: '能区分形容词、名词和副词选项，并选择自然搭配',
      },
      options: [
        { key: 'A', text: 'practical' },
        { key: 'B', text: 'comfort' },
        { key: 'C', text: 'conveniently' },
        { key: 'D', text: 'practically' },
      ],
    },
    answer_key: { correct_option: 'A' },
  };
  const practicalGlossLeakedGuideOptions = extractOptionRecords(practicalGlossLeakedGuide);
  const practicalGlossLeakedGuideAnswer = extractAnswerRecord(
    practicalGlossLeakedGuide,
    practicalGlossLeakedGuideOptions
  );
  const practicalGlossFragments = findFrontAnswerLeakFragments(
    extractFrontText(practicalGlossLeakedGuide),
    practicalGlossLeakedGuideOptions,
    practicalGlossLeakedGuideAnswer
  );
  assertSelfTest(
    practicalGlossFragments.includes('可执行') && practicalGlossFragments.includes('可落地'),
    'A practicality semantic gloss leaked through task_schema guide text must trigger front-answer leakage.'
  );

  const duplicatedVisibleList = {
    frontText: '综合辨析：哪一项最可能是中文直译导致的不规范听力词汇表达？ A. ask for an extension B. over my budget C. make an appointment D. do a schedule change thing 综合辨析：哪一项最可能是中文直译导致的不规范听力词汇表达？ A. ask for an extension B. over my budget C. make an appointment D. do a schedule change thing',
    optionRecords: [
      { key: 'A', text: 'ask for an extension' },
      { key: 'B', text: 'over my budget' },
      { key: 'C', text: 'make an appointment' },
      { key: 'D', text: 'do a schedule change thing' },
    ],
    answer: { text: 'D' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(duplicatedVisibleList.frontText, duplicatedVisibleList.optionRecords, duplicatedVisibleList.answer).length === 0,
    'A duplicated migrated front with a visible option list must not be treated as front-answer leakage.'
  );

  const sourceMaterialOnly = {
    frontText: '阅读片段：I am a historian who surveyed women engineers in the 1970s. 问题：如果只保留这句的主干，下列哪项最准确？',
    optionRecords: [
      { key: 'A', text: 'I am a historian.' },
      { key: 'B', text: 'I surveyed women engineers.' },
      { key: 'C', text: 'Women engineers were historians.' },
      { key: 'D', text: 'My colleagues graduated.' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(sourceMaterialOnly.frontText, sourceMaterialOnly.optionRecords, sourceMaterialOnly.answer).length === 0,
    'Source material on the front side is task input, not prompt-side answer leakage.'
  );

  const materialAndLeakedPrompt = {
    frontText: '句子："Most learners are familiar ___ the basic pattern but ignore exceptions." 这里为什么填 with？',
    optionRecords: [
      { key: 'A', text: 'on' },
      { key: 'B', text: 'for' },
      { key: 'C', text: 'at' },
      { key: 'D', text: 'with' },
    ],
    answer: { text: 'D' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(materialAndLeakedPrompt.frontText, materialAndLeakedPrompt.optionRecords, materialAndLeakedPrompt.answer).includes('with'),
    'Removing source material must not hide a prompt that names the correct option.'
  );

  const dialogueMaterialOnly = {
    frontText: "对话片段：M: I'd love to join the trip, but it's over my budget. W: You can apply for a student discount. 这里最应优先识别的高频词是：",
    optionRecords: [
      { key: 'A', text: 'available' },
      { key: 'B', text: 'budget' },
      { key: 'C', text: 'recommend' },
      { key: 'D', text: 'deadline' },
    ],
    answer: { text: 'B' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(dialogueMaterialOnly.frontText, dialogueMaterialOnly.optionRecords, dialogueMaterialOnly.answer).length === 0,
    'Dialogue material on the front side is task input, not prompt-side answer leakage.'
  );

  const clozeMaterialOnly = {
    frontText: 'After the downgrade, portfolio managers turned cautious despite otherwise ___ market sentiment in equity benchmarks. 哪组形容词+名词搭配更自然？',
    optionRecords: [
      { key: 'A', text: 'positive market sentiment' },
      { key: 'B', text: 'goodly market sentiment' },
      { key: 'C', text: 'happy market sentiment' },
      { key: 'D', text: 'simple market sentiment' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(clozeMaterialOnly.frontText, clozeMaterialOnly.optionRecords, clozeMaterialOnly.answer).length === 0,
    'Cloze context around a blank is task input, not prompt-side answer leakage.'
  );

  const roleLabelOption = {
    frontText: '阅读片段：The impact of social media on adolescent mental health has become one of the most debated topics in public health circles. 问题：该句的系动词和表语分别是什么？',
    optionRecords: [
      { key: 'A', text: '系动词：has become；表语：over the past decade' },
      { key: 'B', text: '系动词：is；表语：the most debated' },
      { key: 'C', text: '系动词：has become；表语：one of the most debated topics in public health circles' },
      { key: 'D', text: '系动词：has；表语：become one of the most debated topics' },
    ],
    answer: { text: 'C' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(roleLabelOption.frontText, roleLabelOption.optionRecords, roleLabelOption.answer).length === 0,
    'A grammatical role label in an explanatory option must not be treated as the answer head.'
  );

  const optionSetTopicHint = {
    frontText: '【状语从句 T1】because / since / as 的语气强弱 句子：_____ the equipment had failed twice, the director stopped the experiment. 哪项最合适？',
    optionRecords: [
      { key: 'A', text: 'Because' },
      { key: 'B', text: 'Since' },
      { key: 'C', text: 'As' },
      { key: 'D', text: 'Lest' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(optionSetTopicHint.frontText, optionSetTopicHint.optionRecords, optionSetTopicHint.answer).length === 0,
    'A topic label listing multiple answer candidates must not be treated as naming the correct option.'
  );

  const compressedOptionSetTopicHint = {
    frontText: '[定语从句 T8] quantifier + of which/whom The committee reviewed ten proposals, three _____ were selected for further evaluation.',
    optionRecords: [
      { key: 'A', text: 'of which' },
      { key: 'B', text: 'of whom' },
      { key: 'C', text: 'in which' },
      { key: 'D', text: 'for which' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(compressedOptionSetTopicHint.frontText, compressedOptionSetTopicHint.optionRecords, compressedOptionSetTopicHint.answer).length === 0,
    'A compressed slash topic label that lists multiple answer candidates must not be treated as naming the correct option.'
  );

  const constructionTitleLeak = {
    frontText: '【固定句型 T8】would rather ... than ... The editor would rather postpone publication _____ release weak conclusions.',
    optionRecords: [
      { key: 'A', text: 'than' },
      { key: 'B', text: 'instead' },
      { key: 'C', text: 'but' },
      { key: 'D', text: 'while' },
    ],
    answer: { text: 'A' },
  };
  assertSelfTest(
    findFrontAnswerLeakFragments(constructionTitleLeak.frontText, constructionTitleLeak.optionRecords, constructionTitleLeak.answer).includes('than'),
    'A construction title that uniquely names the correct completion must remain a front-answer leak.'
  );

  return {
    ok: true,
    cases: [
      'visible_option_list_only_is_not_leak',
      'prompt_answer_text_is_leak',
      'visible_option_list_does_not_mask_prompt_leak',
      'visible_task_schema_guide_is_audited',
      'visible_option_example_list_only_is_not_leak',
      'visible_option_example_guide_leak_is_audited',
      'semantic_answer_gloss_guide_leak_is_audited',
      'strong_evidence_gloss_guide_leak_is_audited',
      'practical_gloss_guide_leak_is_audited',
      'duplicated_visible_option_list_only_is_not_leak',
      'source_material_only_is_not_leak',
      'material_strip_does_not_mask_prompt_leak',
      'dialogue_material_only_is_not_leak',
      'cloze_material_only_is_not_leak',
      'role_label_option_head_is_not_leak',
      'option_set_topic_hint_is_not_leak',
      'compressed_option_set_topic_hint_is_not_leak',
      'construction_title_still_leaks_answer',
    ],
  };
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

if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify(runSelfTest(), null, 2));
  process.exit(0);
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
