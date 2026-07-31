#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'card_boxes_json');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requireTrack(value) {
  if (!['cet4', 'cet6'].includes(value)) {
    throw new Error('--track must be cet4 or cet6.');
  }
  return value;
}

function cardFiles() {
  return fs.readdirSync(CARD_DIR)
    .filter(file => file.endsWith('.json'))
    .sort();
}

function readTrackCards(track) {
  const cards = [];
  for (const file of cardFiles()) {
    const record = JSON.parse(fs.readFileSync(path.join(CARD_DIR, file), 'utf8'));
    if (record.track !== track) continue;
    for (const card of record.cards || []) cards.push({file, card});
  }
  return cards.sort((left, right) => String(left.card.card_id).localeCompare(String(right.card.card_id)));
}

function buildAudit() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-track-remediation-'));
  const reportPath = path.join(tempDir, 'card-quality-audit.json');
  try {
    execFileSync(process.execPath, ['scripts/audit_card_quality.mjs', '--report-path', reportPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
}

function sumBySeverity(entries) {
  return entries.reduce((totals, entry) => {
    for (const key of ['hard_blocker', 'content_risk', 'review_gap', 'source_risk']) {
      totals[key] += Number(entry.by_severity?.[key] || 0);
    }
    return totals;
  }, {hard_blocker: 0, content_risk: 0, review_gap: 0, source_risk: 0});
}

function sumByRule(entries) {
  const totals = {};
  for (const entry of entries) {
    for (const [rule, count] of Object.entries(entry.by_rule || {})) {
      totals[rule] = (totals[rule] || 0) + Number(count || 0);
    }
  }
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)));
}

function buildBaseline(track) {
  const audit = buildAudit();
  const cards = readTrackCards(track);
  const issues = Object.values(audit.card_issue_index || {})
    .filter(entry => entry.track === track)
    .sort((left, right) => String(left.card_id).localeCompare(String(right.card_id)));
  const issueByCard = new Map(issues.map(entry => [String(entry.card_id), entry]));
  const boxes = new Map();
  const audioCardIds = [];

  for (const {file, card} of cards) {
    const prefix = String(card.knowledge_ref?.box_prefix || card.card_box_code || '');
    const box = boxes.get(prefix) || {
      box_prefix: prefix,
      library: card.knowledge_ref?.library_name || '',
      group: card.knowledge_ref?.group_name || '',
      box: card.knowledge_ref?.box_name || card.card_box_name || '',
      card_ids: [],
      issue_count: 0,
      hard_blocker_count: 0,
      review_status: 'pending_human_review',
      reviewer: null,
    };
    box.card_ids.push(String(card.card_id));
    const issue = issueByCard.get(String(card.card_id));
    box.issue_count += Number(issue?.issue_count || 0);
    box.hard_blocker_count += Number(issue?.by_severity?.hard_blocker || 0);
    boxes.set(prefix, box);
    if (card.audio?.path || card.audio?.url) audioCardIds.push(String(card.card_id));
    if (!issue) {
      throw new Error(`Quality audit is missing ${card.card_id} from ${file}.`);
    }
  }

  const bySeverity = sumBySeverity(issues);
  const byRule = sumByRule(issues);
  const blockingReasons = [];
  if (bySeverity.hard_blocker > 0) blockingReasons.push('hard_blockers_remain');
  if (bySeverity.content_risk > 0) blockingReasons.push('content_risks_remain');
  if (bySeverity.review_gap > 0) blockingReasons.push('quality_metadata_or_review_gaps_remain');
  if (bySeverity.source_risk > 0) blockingReasons.push('source_classification_risks_remain');
  blockingReasons.push('human_CET_review_not_recorded');
  blockingReasons.push('final_user_approval_not_recorded');

  return {
    schema_version: 'full-track-remediation-baseline.v1',
    generated_at: new Date().toISOString(),
    authority_boundary: 'candidate remediation planning only; this report does not approve content or audio',
    track,
    corpus_fingerprint: audit.corpus_fingerprint,
    scope: {
      box_prefixes: [...boxes.keys()].sort(),
      card_ids: cards.map(({card}) => String(card.card_id)),
    },
    summary: {
      card_count: cards.length,
      box_count: boxes.size,
      cards_with_hard_blockers: issues.filter(entry => Number(entry.by_severity?.hard_blocker || 0) > 0).length,
      audio_card_count: audioCardIds.length,
      issue_count: issues.reduce((total, entry) => total + Number(entry.issue_count || 0), 0),
      by_severity: bySeverity,
      by_rule: byRule,
    },
    audio_card_ids: audioCardIds.sort(),
    boxes: [...boxes.values()].sort((left, right) => left.box_prefix.localeCompare(right.box_prefix)),
    readiness: {
      ready_for_full_track_user_approval: false,
      blocking_reasons: blockingReasons,
    },
  };
}

const track = requireTrack(option('--track', 'cet4'));
const reportPath = option('--report-path', `exports/${track}-full-track-remediation-baseline.json`);
const absoluteReportPath = path.resolve(ROOT, reportPath);
const baseline = buildBaseline(track);
fs.mkdirSync(path.dirname(absoluteReportPath), {recursive: true});
fs.writeFileSync(absoluteReportPath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  report_path: path.relative(ROOT, absoluteReportPath),
  track,
  summary: baseline.summary,
  readiness: baseline.readiness,
}, null, 2));
