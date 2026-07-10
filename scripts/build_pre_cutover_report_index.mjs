#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATHS = ['reports/card_quality_audit_report.json', 'reports/card_validation_report.json'];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const archivePath = option('--archive-path');
const archiveUrl = option('--archive-url');
const output = path.resolve(ROOT, option('--output', 'reports/pre-cutover-report-index.json'));
if (!archivePath || !archiveUrl) throw new Error('--archive-path and --archive-url are required');

const reports = REPORT_PATHS.map(reportPath => {
  const data = fs.readFileSync(path.join(ROOT, reportPath));
  const payload = JSON.parse(data.toString('utf8'));
  return {
    path: reportPath,
    sha256: sha256(data),
    size_bytes: data.byteLength,
    corpus_fingerprint: payload.corpus_fingerprint?.digest || null,
  };
});
const reviewFiles = fs.readdirSync(path.join(ROOT, 'reviews', 'agent_self_review'))
  .filter(file => file.endsWith('.json') && file !== 'TEMPLATE.json')
  .sort();
const legacyReferences = [];
for (const file of reviewFiles) {
  const recordPath = `reviews/agent_self_review/${file}`;
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, recordPath), 'utf8'));
  const audit = record.quality_audit || record.card_quality_audit;
  if (REPORT_PATHS.includes(audit?.report)) {
    legacyReferences.push({
      record: recordPath,
      report: audit.report,
      corpus_fingerprint: audit.corpus_fingerprint,
      audit_record_sha256: sha256(JSON.stringify(audit)),
    });
  }
}
const archiveData = fs.readFileSync(archivePath);
const payload = {
  schema_version: 'pre-cutover-report-index.v1',
  cutover_id: 'history-cutover-2026-07-10',
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim(),
  archive: {
    url: archiveUrl,
    asset_name: path.basename(new URL(archiveUrl).pathname),
    sha256: sha256(archiveData),
    size_bytes: archiveData.byteLength,
  },
  reports,
  legacy_references: legacyReferences,
};

fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({output: path.relative(ROOT, output), reports: reports.length, legacy_references: legacyReferences.length}, null, 2));
