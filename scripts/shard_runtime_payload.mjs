#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {deriveRuntimePayloadContentIdentity} from './lib/model_acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MAX_SHARD_BYTES = 900 * 1024;
const MANIFEST_PATH_RE =
  /^reviews\/runtime_payloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function shardDocument(track, cardRecords) {
  return {
    schema_version: 'card-make-runtime-card-shard.v1',
    track,
    card_records: cardRecords,
  };
}

export function buildRuntimePayloadShards({
  payload,
  manifestPath,
  maxShardBytes = DEFAULT_MAX_SHARD_BYTES,
}) {
  if (!MANIFEST_PATH_RE.test(String(manifestPath || ''))) {
    throw new Error('manifest path must be a direct JSON child of reviews/runtime_payloads');
  }
  if (
    !Number.isSafeInteger(maxShardBytes) ||
    maxShardBytes < 1024 ||
    maxShardBytes >= 1024 * 1024
  ) {
    throw new Error('max shard bytes must be between 1024 and 1048575');
  }
  const records = payload.card_records;
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.some((record, index) =>
      typeof record?.card_id !== 'string' ||
      (index > 0 && records[index - 1].card_id.localeCompare(record.card_id) >= 0))
  ) {
    throw new Error('runtime cards must be strictly ordered by unique card_id before sharding');
  }
  const identity = deriveRuntimePayloadContentIdentity(payload);
  const base = manifestPath.slice(0, -'.json'.length);
  const groups = [];
  let current = [];
  for (const record of records) {
    const candidate = [...current, record];
    if (
      current.length > 0 &&
      Buffer.byteLength(serialized(shardDocument(payload.track, candidate))) >
        maxShardBytes
    ) {
      groups.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    if (
      Buffer.byteLength(serialized(shardDocument(payload.track, current))) >
      maxShardBytes
    ) {
      throw new Error(`runtime card ${record?.card_id ?? '<unknown>'} exceeds shard limit`);
    }
  }
  if (current.length > 0) groups.push(current);
  const width = Math.max(3, String(groups.length).length);
  const shards = groups.map((cardRecords, index) => {
    const shardPath = `${base}.part-${String(index + 1).padStart(width, '0')}.json`;
    const document = shardDocument(payload.track, cardRecords);
    const bytes = serialized(document);
    return {
      path: shardPath,
      document,
      bytes,
      sha256: sha256(bytes),
    };
  });
  const manifest = {
    schema_version: 'card-make-runtime-payload-manifest.v1',
    source: payload.source,
    track: payload.track,
    content_version: identity.content_version,
    card_record_shards: shards.map(shard => ({
      path: shard.path,
      sha256: shard.sha256,
      card_count: shard.document.card_records.length,
      first_card_id: shard.document.card_records[0].card_id,
      last_card_id: shard.document.card_records.at(-1).card_id,
    })),
    assets: payload.assets ?? [],
    release: payload.release ?? null,
  };
  const manifestBytes = serialized(manifest);
  if (Buffer.byteLength(manifestBytes) >= 1024 * 1024) {
    throw new Error('runtime manifest exceeds repository blob limit');
  }
  return {manifest, manifestBytes, shards};
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function runCli() {
  const input = option(process.argv, '--input');
  const manifestPath = option(process.argv, '--manifest');
  const maxShardBytes = Number(option(
    process.argv,
    '--max-shard-bytes',
    String(DEFAULT_MAX_SHARD_BYTES),
  ));
  if (!input || !manifestPath) {
    throw new Error('--input and --manifest are required');
  }
  const absoluteManifestPath = path.resolve(ROOT, manifestPath);
  const expectedPrefix = `${path.join(ROOT, 'reviews', 'runtime_payloads')}${path.sep}`;
  if (!absoluteManifestPath.startsWith(expectedPrefix)) {
    throw new Error('manifest path escapes reviews/runtime_payloads');
  }
  const payload = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  const result = buildRuntimePayloadShards({
    payload,
    manifestPath,
    maxShardBytes,
  });
  const outputs = [manifestPath, ...result.shards.map(shard => shard.path)];
  for (const output of outputs) {
    if (fs.existsSync(path.resolve(ROOT, output))) {
      throw new Error(`refusing to overwrite existing runtime artifact: ${output}`);
    }
  }
  for (const shard of result.shards) {
    fs.writeFileSync(path.resolve(ROOT, shard.path), shard.bytes);
  }
  fs.writeFileSync(absoluteManifestPath, result.manifestBytes);
  console.log(JSON.stringify({
    ok: true,
    manifest: manifestPath,
    shard_count: result.shards.length,
    card_count: payload.card_records.length,
    content_version: result.manifest.content_version,
    outputs: outputs.map(output => ({
      path: output,
      size_bytes: fs.statSync(path.resolve(ROOT, output)).size,
    })),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
