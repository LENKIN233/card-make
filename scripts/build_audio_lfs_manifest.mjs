#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const output = path.resolve(ROOT, option('--output', 'ai_tts/audio-lfs-manifest.json'));
const expectedCount = Number(option('--expected-count', '0'));
const files = execFileSync('git', ['ls-files', '-z'], {cwd: ROOT})
  .toString()
  .split('\0')
  .filter(file => file.startsWith('ai_tts/') && file.endsWith('.mp3'))
  .sort();

if (expectedCount > 0 && files.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} MP3 files, found ${files.length}`);
}

const entries = files.map(file => {
  const data = fs.readFileSync(path.join(ROOT, file));
  return {path: file, size_bytes: data.byteLength, sha256: sha256(data)};
});
const payload = {
  schema_version: 'audio-lfs-manifest.v1',
  source_commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim(),
  file_count: entries.length,
  files: entries,
};

fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({output: path.relative(ROOT, output), file_count: entries.length}, null, 2));
