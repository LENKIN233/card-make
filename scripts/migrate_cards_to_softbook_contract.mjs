import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');

const MIGRATION_VERSION = 'softbook-card-contract-2026-07-31-elimination-ids';

const TRACKS = {
  0: 'cet4',
  1: 'cet6',
  cet4: 'cet4',
  cet6: 'cet6',
};

const LIBRARY_NAMES = {
  0: '听力',
  1: '仔细阅读',
  2: '选词填空',
  3: '写作',
  4: '翻译',
  5: '词汇',
  6: '语法',
};

const INTERACTION_MAP = {
  0: { id: 'flip', autoScoring: false, reason: 'legacy flip card maps directly to flip' },
  1: { id: 'multiple_choice', autoScoring: true, reason: 'legacy four-option card maps directly to multiple_choice' },
  2: { id: 'flip', autoScoring: false, reason: 'legacy timing click is kept as local preview behavior and downcast to flip for product contract' },
  3: { id: 'flip', autoScoring: false, reason: 'legacy hold-release is kept as local preview behavior and downcast to flip for product contract' },
  4: { id: 'elimination', autoScoring: true, reason: 'legacy elimination card maps directly to elimination' },
  5: { id: 'flip', autoScoring: false, reason: 'legacy hint-only card is kept as hint_layer on a flip card' },
  6: { id: 'lock', autoScoring: true, reason: 'legacy word-bank blank filling maps to lock because all slots must be correct' },
  7: { id: 'swipe', autoScoring: true, reason: 'legacy true/false judgment maps to swipe' },
  8: { id: 'multiple_choice', autoScoring: true, reason: 'legacy tense-form choice maps to multiple_choice' },
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function trackName(value) {
  return TRACKS[value] || String(value || '');
}

function cleanVisibleText(value) {
  if (typeof value !== 'string') return value;

  return value
    .replace(/【CET6独立语料】/g, '【CET6专项语境】')
    .replace(/【CET4独立语料】/g, '【CET4专项语境】')
    .replace(/第\d+卡标准答案与示例/g, '标准答案与示例')
    .replace(/第\d+卡答案/g, '答案')
    .replace(/第\d+卡参考答案/g, '参考答案')
    .replace(/第\d+卡：/g, '：')
    .replace(/第\d+卡/g, '')
    .replace(/当前素材中可优先关注“[^”]+”。?/g, '优先抓题面中的限定词、句法位置或语义转折。')
    .replace(/回到本题可用“[^”]+”进行结果核对。?/g, '回到题面逐项核对对象、关系和限定范围。')
    .replace(/补充：本题第\d+卡按\d+盒任务要求组织解析。?/g, '')
    .replace(/按\d+盒任务要求组织解析/g, '按本盒知识点要求组织解析')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== 'object') return cleanVisibleText(value);

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = cleanObject(child);
  }
  return next;
}

function hasTemplateLeak(card) {
  const text = JSON.stringify({
    front_content: card.front_content,
    back_content: card.back_content,
    analysis_content: card.analysis_content,
  });
  return /第\d+卡|当前素材中可优先关注|盒任务要求组织解析|CET[46]独立语料/.test(text);
}

function normalizeSourceRef(sourceRef) {
  const source = sourceRef && typeof sourceRef === 'object' ? { ...sourceRef } : null;

  if (!source) {
    return {
      type: 'legacy_unverified',
      provenance_status: 'unverified',
      note: 'source_ref_missing_before_contract_migration',
    };
  }

  const hasTrace =
    Boolean(source.paper_id) ||
    Boolean(source.question_id) ||
    Boolean(source.passage_id) ||
    Boolean(source.note);

  if (!source.provenance_status) {
    if (source.type === 'exam' && source.paper_id) {
      source.provenance_status = source.question_id || source.passage_id ? 'verified' : 'partial';
    } else if (source.type === 'ai_generated') {
      source.provenance_status = 'synthetic';
    } else if (!hasTrace) {
      source.provenance_status = 'unverified';
    } else {
      source.provenance_status = 'documented';
    }
  }

  if (!hasTrace) {
    source.note = source.note || 'untraced_content_pool_from_legacy_card_make_batch';
  }

  if (source.type === 'ai_generated' && !source.model) {
    source.model = 'unknown';
  }

  return source;
}

function buildKnowledgeRef(card, fileMeta) {
  const library = card.library ?? fileMeta.library;
  const group = card.group ?? fileMeta.group;
  const box = card.box ?? fileMeta.box;

  return {
    track: trackName(card.track ?? fileMeta.track),
    library_id: String(library),
    library_name: LIBRARY_NAMES[library] || String(library),
    group_id: String(group),
    group_name: card.card_group_name || fileMeta.card_group_name || '',
    box_id: String(box),
    box_name: card.card_box_name || fileMeta.card_box_name || '',
    box_prefix: String(card.card_box_code || fileMeta.card_box_code || '').padStart(4, '0'),
  };
}

function buildFront(card) {
  const front = card.front_content || {};
  return {
    text: front.text || '',
    task_prompt: front.task_prompt || front.text || '',
    audio_first: Boolean(front.audio_first || front.display_mode === 'audio_first'),
    display_mode: front.display_mode || (front.audio_first ? 'audio_first' : 'text_first'),
    highlight_ranges: Array.isArray(front.highlight_ranges) ? front.highlight_ranges : [],
    task_schema: front.task_schema || null,
  };
}

function buildAnalysis(card) {
  const analysis = card.analysis_content || {};
  return {
    text: analysis.text || card.back_content?.explanation || card.back_content?.text || '',
    tips: Array.isArray(analysis.tips) ? analysis.tips : [],
  };
}

export function buildEliminationContract(eliminableItems) {
  const items = Array.isArray(eliminableItems) ? eliminableItems : [];
  const usedIds = new Set();
  const eliminationItems = items.map((item, index) => {
    const preferredId = typeof item?.id === 'string' && item.id.trim().length > 0
      ? item.id.trim()
      : `item_${index + 1}`;
    let id = preferredId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${preferredId}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return {
      id,
      text: typeof item?.text === 'string' ? item.text : '',
    };
  });

  return {
    elimination_items: eliminationItems,
    answer_key: {
      correct_items: eliminationItems
        .filter((_item, index) => items[index]?.is_correct === true)
        .map(item => item.id),
    },
  };
}

function buildAnswerKey(card, interactionId) {
  if (interactionId === 'multiple_choice') {
    if (Array.isArray(card.options)) {
      const correct = card.options.find(opt => opt && opt.is_correct);
      return correct ? { correct_option: correct.key || correct.text } : null;
    }
    if (Array.isArray(card.form_options)) {
      const correctIndex = card.form_options.findIndex(opt => opt && opt.is_correct);
      return correctIndex >= 0
        ? { correct_option: String.fromCharCode(65 + correctIndex), correct_value: card.form_options[correctIndex].form }
        : null;
    }
  }

  if (interactionId === 'elimination' && Array.isArray(card.eliminable_items)) {
    return buildEliminationContract(card.eliminable_items).answer_key;
  }

  if (interactionId === 'lock' && Array.isArray(card.blank_answers)) {
    return { lock_pattern: card.blank_answers };
  }

  if (interactionId === 'swipe') {
    return { correct_state: card.correct_answer };
  }

  return null;
}

function buildContractFields(card, fileMeta) {
  const legacyType = Number(card.interaction_type);
  const mapping = INTERACTION_MAP[legacyType] || INTERACTION_MAP[0];
  const sourceRef = normalizeSourceRef(card.source_ref);
  const qualityFlags = new Set(Array.isArray(card.quality_flags) ? card.quality_flags : []);
  qualityFlags.delete('template_text_needs_review');

  if (sourceRef.provenance_status === 'unverified') qualityFlags.add('unverified_source');
  if (sourceRef.provenance_status === 'synthetic') qualityFlags.add('synthetic_source');
  if (hasTemplateLeak(card)) qualityFlags.add('template_text_needs_review');

  const contractFields = {
    contract_version: 'softbook-card-v1',
    track: trackName(card.track ?? fileMeta.track),
    knowledge_ref: buildKnowledgeRef(card, fileMeta),
    interaction_id: mapping.id,
    front: buildFront(card),
    analysis: buildAnalysis(card),
    auto_scoring: Boolean(mapping.autoScoring),
    source_ref: sourceRef,
    legacy_interaction: {
      type: legacyType,
      label: `T${legacyType}`,
      product_mapping_reason: mapping.reason,
    },
    quality_flags: [...qualityFlags].sort(),
    production_status: qualityFlags.size ? 'needs_review' : 'contract_ready',
    contract_migration: {
      version: MIGRATION_VERSION,
    },
  };

  const answerKey = buildAnswerKey(card, mapping.id);
  if (answerKey) contractFields.answer_key = answerKey;

  if (mapping.id === 'lock' && Array.isArray(card.blank_answers)) {
    contractFields.lock_slots = card.blank_answers.map((answer, index) => ({
      id: `slot_${index + 1}`,
      expected: answer,
    }));
  }

  if (mapping.id === 'elimination' && Array.isArray(card.eliminable_items)) {
    contractFields.elimination_items = buildEliminationContract(
      card.eliminable_items,
    ).elimination_items;
  }

  if (mapping.id === 'swipe') {
    contractFields.swipe_states = [
      { id: false, label: 'False' },
      { id: true, label: 'True' },
    ];
  }

  if (Number(card.interaction_type) === 5 && card.front_content?.hint_content) {
    contractFields.hint_layer = {
      content: card.front_content.hint_content,
      reveal_gesture: 'attached_to_flip_card',
    };
  }

  return contractFields;
}

export function migrateFile(filePath) {
  const data = readJson(filePath);
  const fileMeta = { ...data };

  if (data.track !== undefined) {
    data.track_index = Number.isFinite(Number(data.track)) ? Number(data.track) : data.track_index;
    data.track = trackName(data.track);
  }

  data.contract_version = 'softbook-card-file-v1';
  data.contract_migration = { version: MIGRATION_VERSION };

  data.cards = (data.cards || []).map(card => {
    const originalTrack = card.track;
    const cleaned = cleanObject(card);
    if (originalTrack !== undefined && cleaned.track_index === undefined) {
      cleaned.track_index = Number.isFinite(Number(originalTrack)) ? Number(originalTrack) : undefined;
    }

    return {
      ...cleaned,
      ...buildContractFields(cleaned, fileMeta),
    };
  });

  writeJson(filePath, data);
}

function runCli() {
  const files = fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => path.join(CARD_DIR, file));

  for (const file of files) {
    migrateFile(file);
  }

  console.log(`Migrated ${files.length} card box files to ${MIGRATION_VERSION}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
