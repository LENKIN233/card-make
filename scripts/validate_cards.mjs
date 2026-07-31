import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadIntegrityPolicy,
  validateEliminationIntegrity,
  validateQualityMetadata,
} from './lib/card_integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'reports', 'card_validation_report.json');

const REQUIRED_FIELDS = ['card_id', 'track', 'knowledge_ref', 'interaction_id', 'front', 'analysis', 'source_ref'];
const SOURCE_REQUIRED_FIELDS = ['type', 'provenance_status'];
const CORE_INTERACTIONS = new Set(['flip', 'multiple_choice', 'lock', 'elimination', 'swipe']);
const TEMPLATE_LEAK_RE = /第\d+卡|当前素材中可优先关注|盒任务要求组织解析|CET[46]独立语料/;
const INTEGRITY_POLICY = loadIntegrityPolicy(ROOT);
const CARD_BOX_FILE_RE = /^card_boxes_seed_(?:cet4|cet6)_[a-z0-9_]+_\d{4}\.json$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkCards() {
  const files = fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();

  const cards = [];
  for (const file of files) {
    if (!CARD_BOX_FILE_RE.test(file)) {
      cards.push({file, card: null, issue: 'invalid_card_box_filename'});
      continue;
    }
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
    source_type: {},
    material_text_source_type: {},
    quality_flags: {},
    derived_quality_flags: {},
    integrity: {
      quality_metadata_present: 0,
      quality_metadata_absent: 0,
      quality_metadata_valid: 0,
      quality_metadata_invalid: 0,
      elimination_cards: 0,
      elimination_valid: 0,
      elimination_invalid: 0,
      elimination_runtime_id_contract: 0,
      elimination_legacy_compatible: 0,
    },
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

    if (hasValue(card.source_ref)) {
      for (const field of SOURCE_REQUIRED_FIELDS) {
        if (!hasValue(card.source_ref[field])) {
          errors.push({ file, card_id: card.card_id, code: 'missing_source_ref_field', field });
        }
      }
    }

    if (card.interaction_id === 'hint_layer') {
      errors.push({ file, card_id: card.card_id, code: 'hint_layer_as_standalone_interaction' });
    } else if (!CORE_INTERACTIONS.has(card.interaction_id)) {
      errors.push({ file, card_id: card.card_id, code: 'invalid_interaction_id', interaction_id: card.interaction_id });
    }

    if (card.audio?.url && !fs.existsSync(path.join(ROOT, card.audio.url))) {
      errors.push({ file, card_id: card.card_id, code: 'missing_audio_file', audio_url: card.audio.url });
    }

    const metadataIntegrity = validateQualityMetadata(card, INTEGRITY_POLICY, {required: false});
    if (metadataIntegrity.present) {
      stats.integrity.quality_metadata_present += 1;
      if (metadataIntegrity.ok) stats.integrity.quality_metadata_valid += 1;
      else stats.integrity.quality_metadata_invalid += 1;
    } else {
      stats.integrity.quality_metadata_absent += 1;
    }
    errors.push(...metadataIntegrity.issues.map(integrityIssue => ({
      file,
      ...integrityIssue,
    })));

    const eliminationIntegrity = validateEliminationIntegrity(card, {
      requireLegacyMirror: true,
      allowLegacyContract: true,
    });
    if (eliminationIntegrity.applicable) {
      stats.integrity.elimination_cards += 1;
      if (eliminationIntegrity.mode === 'runtime_id_contract') {
        stats.integrity.elimination_runtime_id_contract += 1;
      }
      if (eliminationIntegrity.legacy_compatible) {
        stats.integrity.elimination_legacy_compatible += 1;
      }
      if (eliminationIntegrity.ok) stats.integrity.elimination_valid += 1;
      else stats.integrity.elimination_invalid += 1;
    }
    errors.push(...eliminationIntegrity.issues.map(integrityIssue => ({
      file,
      ...integrityIssue,
    })));

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

    const interaction = card.interaction_id || 'missing';
    stats.interactions[interaction] = (stats.interactions[interaction] || 0) + 1;

    const production = card.production_status || 'missing';
    stats.production_status[production] = (stats.production_status[production] || 0) + 1;

    const provenance = card.source_ref?.provenance_status || 'missing';
    stats.provenance_status[provenance] = (stats.provenance_status[provenance] || 0) + 1;

    const sourceType = card.source_ref?.type || 'missing';
    stats.source_type[sourceType] = (stats.source_type[sourceType] || 0) + 1;

    const materialSourceType = card.quality_metadata?.material?.text_source_type || 'missing';
    stats.material_text_source_type[materialSourceType] = (stats.material_text_source_type[materialSourceType] || 0) + 1;

    for (const flag of card.quality_flags || []) {
      stats.quality_flags[flag] = (stats.quality_flags[flag] || 0) + 1;
    }
    if (provenance === 'missing' || provenance === 'unverified') {
      stats.derived_quality_flags.unverified_source = (stats.derived_quality_flags.unverified_source || 0) + 1;
    }
    if (
      /ai_generated|synthetic|simulation|simulated/.test(String(sourceType)) ||
      /ai_generated|synthetic|simulation|simulated/.test(String(materialSourceType))
    ) {
      stats.derived_quality_flags.synthetic_source = (stats.derived_quality_flags.synthetic_source || 0) + 1;
    }
  }

  stats.files = files.size;

  return { ok: errors.length === 0, stats, errors, warnings };
}

const report = validate();

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path`);
  return process.argv[index + 1];
}

const reportPathOption = readOption('--report-path');
const reportPath = reportPathOption ? path.resolve(ROOT, reportPathOption) : DEFAULT_REPORT_PATH;
const writeReport = process.argv.includes('--write-report') || reportPathOption !== null;

if (writeReport) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({
  ok: report.ok,
  stats: report.stats,
  errors: report.errors.length,
  warnings: report.warnings.length,
  report_path: writeReport ? reportPath : null,
  first_errors: report.errors.slice(0, 10),
  first_warnings: report.warnings.slice(0, 10),
}, null, 2));

if (!report.ok) process.exit(1);
