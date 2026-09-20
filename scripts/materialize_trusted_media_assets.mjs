#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const scopes = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/trusted-media-run-producer.json'))).execution.exact_scopes;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function directPath(root, relative) {
  const parts = relative.split('/');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('media root is a symlink');
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('media path is a symlink');
  }
  if (!fs.statSync(current).isFile()) throw new Error('media path is not a regular file');
  return current;
}

export function materializeTrustedMediaAssets({sourceRoot, destinationRoot, document, track}) {
  if (!Object.hasOwn(scopes, track) || document?.track !== track) throw new Error('media scope is not registered or does not match');
  const scope = scopes[track];
  const entries = document.schema_version === 'audio-perceptual-worklist.v3'
    ? document.entries?.map(entry => ({card_id: entry.card_id, ...entry.audio}))
    : document.schema_version === 'trusted-media-audio-manifest.v1' && document.asset_count === scope.audio_asset_count
    ? document.assets : null;
  if (!Array.isArray(entries) || entries.length !== scope.audio_asset_count) throw new Error('media scope has the wrong asset count');
  const ids = new Set(); const paths = new Set();
  const staged = entries.map(entry => {
    const id = entry.card_id;
    const relative = entry.asset_path;
    if (typeof id !== 'string' || !/^[0-9]{6}$/.test(id) || !id.startsWith(track === 'cet4' ? '0' : '1') || ids.has(id)) throw new Error('invalid or repeated media card');
    if (typeof relative !== 'string' || !new RegExp(`^ai_tts/${track}/${id.slice(0, 4)}/${id}(?:-[A-Za-z0-9._-]+)?\\.mp3$`).test(relative) || paths.has(relative)) throw new Error('invalid or repeated media path');
    if (!/^[a-f0-9]{64}$/.test(entry.file_sha256) || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 1) throw new Error('invalid media byte identity');
    ids.add(id); paths.add(relative);
    const source = directPath(sourceRoot, relative);
    const destination = directPath(destinationRoot, relative);
    const tree = execFileSync('git', ['ls-tree', '-z', 'HEAD', '--', relative], {cwd: destinationRoot, encoding: 'utf8'});
    if (!tree.startsWith('100644 blob ') || !tree.endsWith(`\t${relative}\0`)) throw new Error('media destination is not one tracked regular blob');
    const pointer = execFileSync('git', ['show', `HEAD:${relative}`], {cwd: destinationRoot, encoding: 'utf8'});
    if (pointer !== `version https://git-lfs.github.com/spec/v1\noid sha256:${entry.file_sha256}\nsize ${entry.size_bytes}\n`) throw new Error('media identity differs from the immutable LFS pointer');
    const bytes = fs.readFileSync(source);
    if (bytes.length !== entry.size_bytes || digest(bytes) !== entry.file_sha256) throw new Error('source media bytes do not match the bound identity');
    return {destination, bytes};
  });
  for (const {destination, bytes} of staged) fs.writeFileSync(destination, bytes);
  return {track, materialized_assets: staged.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const names = {'--source-root':'sourceRoot','--destination-root':'destinationRoot','--document':'documentPath','--track':'track'};
  for (let i=2;i<process.argv.length;i+=2) {
    const name=names[process.argv[i]];
    if (!name || !process.argv[i+1] || options[name]) throw new Error('invalid materializer arguments');
    options[name]=process.argv[i+1];
  }
  if (Object.keys(options).length !== 4) throw new Error('all materializer arguments are required');
  const stats=fs.lstatSync(options.documentPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16*1024*1024) throw new Error('media document must be a bounded regular JSON file');
  console.log(JSON.stringify(materializeTrustedMediaAssets({...options, document:JSON.parse(fs.readFileSync(options.documentPath))})));
}
