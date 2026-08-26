#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveRuntimePayloadContentIdentity,
} from './lib/model_acceptance.mjs';
import {buildRuntimePayloadShards} from './shard_runtime_payload.mjs';

test('runtime sharder keeps every blob below the limit and preserves content identity', () => {
  const payload = {
    source: {id: 'fixture', label: 'Fixture'},
    track: 'cet4',
    card_records: [
      {card_id: '000001', front: {text: 'a'.repeat(900)}},
      {card_id: '000002', front: {text: 'b'.repeat(900)}},
      {card_id: '000003', front: {text: 'c'.repeat(900)}},
    ],
    assets: [],
    release: null,
  };
  const result = buildRuntimePayloadShards({
    payload,
    manifestPath: 'reviews/runtime_payloads/fixture.json',
    maxShardBytes: 1200,
  });
  assert.equal(result.shards.length, 3);
  assert.ok(result.shards.every(shard => Buffer.byteLength(shard.bytes) < 1200));
  const byPath = new Map(result.shards.map(shard => [shard.path, shard]));
  const identity = deriveRuntimePayloadContentIdentity(result.manifest, {
    loadShard: shardPath => ({
      payload: byPath.get(shardPath).document,
      sha256: byPath.get(shardPath).sha256,
    }),
  });
  assert.deepEqual(identity, deriveRuntimePayloadContentIdentity(payload));
});

test('runtime sharder rejects one card larger than the configured shard limit', () => {
  assert.throws(
    () => buildRuntimePayloadShards({
      payload: {
        source: {id: 'fixture', label: 'Fixture'},
        track: 'cet4',
        card_records: [{card_id: '000001', front: {text: 'x'.repeat(2000)}}],
      },
      manifestPath: 'reviews/runtime_payloads/fixture.json',
      maxShardBytes: 1200,
    }),
    /exceeds shard limit/,
  );
});
