import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');
const REPORT_PATH = path.join(ROOT, 'reports', 'card_validation_report.json');

const REQUIRED_FIELDS = ['card_id', 'track', 'knowledge_ref', 'interaction_id', 'front', 'analysis'];
const ALLOWED_INTERACTIONS = new Set(['flip', 'multiple_choice', 'lock', 'elimination', 'swipe', 'hint_layer']);
const TEMPLATE_LEAK_RE = /第\d+卡|当前素材中可优先关注|盒任务要求组织解析|CET[46]独立语料/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkCards() {
  const files = fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();

  const cards = [];
  for (const file of files) {
    const filePath = path.join(CARD_DIR, file);
    const data = readJson(filePath);
    if (!Array.isArray(data.cards)) {
      cards.push({ file, card: null, issue: 'file_missing_cards_array' });
      continue;
    }
    for (const card of data.cards) cards.push({ file, card });
  }
  return cards;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function validate() {
  const errors = [];
  const warnings = [];
  const stats = {
    files: 0,
    cards: 0,
    interactions: {},
    production_status: {},
    provenance_status: {},
    quality_flags: {},
  };

  const files = new Set();
  const seenIds = new Set();
  const rows = walkCards();

  for (const row of rows) {
    files.add(row.file);
    if (!row.card) {
      errors.push({ file: row.file, code: row.issue });
      continue;
    }

    const { file, card } = row;
    stats.cards += 1;

    if (seenIds.has(card.card_id)) {
      errors.push({ file, card_id: card.card_id, code: 'duplicate_card_id' });
    }
    seenIds.add(card.card_id);

    for (const field of REQUIRED_FIELDS) {
      if (!hasValue(card[field])) {
        errors.push({ file, card_id: card.card_id, code: 'missing_required_field', field });
      }
    }

    if (!ALLOWED_INTERACTIONS.has(card.interaction_id)) {
      errors.push({ file, card_id: card.card_id, code: 'invalid_interaction_id', interaction_id: card.interaction_id });
    }

    if (card.audio?.url && !fs.existsSync(path.join(ROOT, card.audio.url))) {
      errors.push({ file, card_id: card.card_id, code: 'missing_audio_file', audio_url: card.audio.url });
    }

    const visibleText = JSON.stringify({
      front_content: card.front_content,
      back_content: card.back_content,
      analysis_content: card.analysis_content,
      front: card.front,
      analysis: card.analysis,
    });
    if (TEMPLATE_LEAK_RE.test(visibleText)) {
      warnings.push({ file, card_id: card.card_id, code: 'visible_template_text' });
    }

    if (!card.source_ref?.provenance_status) {
      warnings.push({ file, card_id: card.card_id, code: 'missing_provenance_status' });
    }

    const interaction = card.interaction_id || 'missing';
    stats.interactions[interaction] = (stats.interactions[interaction] || 0) + 1;

    const production = card.production_status || 'missing';
    stats.production_status[production] = (stats.production_status[production] || 0) + 1;

    const provenance = card.source_ref?.provenance_status || 'missing';
    stats.provenance_status[provenance] = (stats.provenance_status[provenance] || 0) + 1;

    for (const flag of card.quality_flags || []) {
      stats.quality_flags[flag] = (stats.quality_flags[flag] || 0) + 1;
    }
  }

  stats.files = files.size;

  return { ok: errors.length === 0, stats, errors, warnings };
}

const report = validate();

if (process.argv.includes('--write-report')) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({
  ok: report.ok,
  stats: report.stats,
  errors: report.errors.length,
  warnings: report.warnings.length,
  first_errors: report.errors.slice(0, 10),
  first_warnings: report.warnings.slice(0, 10),
}, null, 2));

if (!report.ok) process.exit(1);
