#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'ai_tts', 'audio-lfs-manifest.json');
const SHA256_RE = /^[0-9a-f]{64}$/;
const errors = [];

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function lines(value) {
  return value ? value.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

if (!fs.existsSync(MANIFEST)) {
  errors.push('audio LFS manifest is missing');
} else {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const tracked = lines(execFileSync('git', ['ls-files'], {cwd: ROOT, encoding: 'utf8'}))
    .filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3'))
    .sort();
  const lfs = new Set(lines(execFileSync('git', ['lfs', 'ls-files', '--name-only'], {cwd: ROOT, encoding: 'utf8'})));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestPaths = entries.map(entry => entry.path).sort();
  if (manifest.schema_version !== 'audio-lfs-manifest.v1') errors.push('invalid schema_version');
  if (manifest.file_count !== entries.length) errors.push('file_count does not match files.length');
  if (JSON.stringify(tracked) !== JSON.stringify(manifestPaths)) errors.push('tracked MP3 paths do not match manifest');
  for (const entry of entries) {
    if (!SHA256_RE.test(String(entry.sha256 || ''))) errors.push(`${entry.path}: invalid SHA-256`);
    if (!Number.isInteger(entry.size_bytes) || entry.size_bytes < 0) errors.push(`${entry.path}: invalid size`);
    if (!lfs.has(entry.path)) errors.push(`${entry.path}: not managed by Git LFS`);
    const data = fs.readFileSync(path.join(ROOT, entry.path));
    const pointer = data.toString('utf8').match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/);
    const actualSha = pointer ? pointer[1] : sha256(data);
    const actualSize = pointer ? Number(pointer[2]) : data.byteLength;
    if (actualSha !== entry.sha256) errors.push(`${entry.path}: content SHA-256 mismatch`);
    if (actualSize !== entry.size_bytes) errors.push(`${entry.path}: content size mismatch`);
  }
}

const result = {schema_version: 'audio-lfs-validation.v1', ok: errors.length === 0, errors};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
