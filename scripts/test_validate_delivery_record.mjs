import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPatchBytes,
  computePatchSha256,
  validateDeliveryRecord,
} from './validate_delivery_record.mjs';

const HANDOFF_PATH = 'reviews/git_handoffs/20260731-test-delivery.json';
const PAYLOAD_PATHS = ['assets/payload.bin', 'docs/payload.txt'];
const PATCH_FORMAT_V2 = 'git-diff-binary-v2';
const V2_GOLDEN_SHA256 = '4fa4d17ca8633b5313260f144fffaf7230b9c19adc5246e34e99685c25578fed';

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
  fs.writeFileSync(absolutePath, contents);
}

function updateOriginTrackingRef(root) {
  try {
    git(root, 'config', '--get', 'remote.origin.url');
    const branch = git(root, 'branch', '--show-current');
    if (branch) git(root, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  } catch {
    // Fixtures without an origin do not model pushed delivery state.
  }
}

function stageInvalidUtf8Path(root, prefix = 'raw-invalid') {
  const blobSha = execFileSync(
    'git',
    ['hash-object', '-w', '--stdin'],
    {
      cwd: root,
      encoding: 'utf8',
      input: 'raw invalid-path payload\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  const indexInfo = Buffer.concat([
    Buffer.from(`100644 ${blobSha}\t${prefix}-`),
    Buffer.from([0xff]),
    Buffer.from('.txt\0'),
  ]);
  execFileSync('git', ['update-index', '-z', '--index-info'], {
    cwd: root,
    encoding: null,
    input: indexInfo,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function commitAll(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', message);
  const commitSha = git(root, 'rev-parse', 'HEAD');
  updateOriginTrackingRef(root);
  return commitSha;
}

function readRecord(fixture) {
  return JSON.parse(fs.readFileSync(path.join(fixture.root, HANDOFF_PATH), 'utf8'));
}

function writeRecord(fixture, record) {
  write(fixture.root, HANDOFF_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

function mutateRecord(fixture, mutate) {
  const record = readRecord(fixture);
  mutate(record);
  writeRecord(fixture, record);
  commitAll(fixture.root, 'mutate handoff');
  return record;
}

function createFixture({
  bomAliasOnly = false,
  audioRecord = false,
  authorizationRecord = false,
  candidateCard = false,
  confirmedExpansionEvidence = false,
  multiPrefixEvidence = false,
  customDiffDriver = false,
  declareGitlink = true,
  gitlinkPath = false,
  historicalHandoffPath = null,
  parked = false,
  patchFormat = PATCH_FORMAT_V2,
  literalMagicPath = false,
  rawInvalidUtf8Path = false,
  unicodePath = false,
} = {}) {
  if (multiPrefixEvidence) candidateCard = true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-record-validator-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Delivery Validator Test');
  git(root, 'config', 'user.email', 'delivery-validator@example.com');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/card-make.git');

  write(root, 'README.md', 'fixture\n');
  write(root, 'docs/unchanged.txt', 'unchanged\n');
  write(root, 'docs/payload.txt', 'base text\n');
  write(root, 'assets/payload.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
  if (customDiffDriver) write(root, '.gitattributes', '*.txt diff=fixture\n');
  if (literalMagicPath) write(root, ':(exclude)**', 'base magic path\n');
  if (unicodePath) write(root, 'docs/听力.txt', 'base listening text\n');
  if (candidateCard) {
    const prefixes = multiPrefixEvidence ? ['0000', '0001'] : ['0000'];
    for (const prefix of prefixes) {
      write(root, `card_boxes_json/card_boxes_seed_cet4_listening_${prefix}.json`, '{"version":"base"}\n');
      write(root, `reviews/agent_self_review/${prefix}-test.json`, '{"version":"base"}\n');
      write(root, `reviews/audit_scopes/${prefix}-test.json`, '{"version":"base"}\n');
    }
  }
  if (historicalHandoffPath) write(root, historicalHandoffPath, '{"archived":true}\n');
  const baseCommitSha = commitAll(root, 'base');

  git(root, 'switch', '-c', 'harness/test-delivery');
  if (bomAliasOnly) {
    write(root, '\ufeffpayload.txt', 'BOM-leading payload path\n');
  } else {
    write(root, 'docs/payload.txt', 'base text\npayload text\n');
    write(root, 'assets/payload.bin', Buffer.from([0, 1, 2, 9, 8, 7, 6, 5]));
    if (literalMagicPath) write(root, ':(exclude)**', 'changed magic path\n');
    if (unicodePath) write(root, 'docs/听力.txt', 'changed listening text\n');
    if (candidateCard) {
      const prefixes = multiPrefixEvidence ? ['0000', '0001'] : ['0000'];
      for (const prefix of prefixes) {
        write(root, `card_boxes_json/card_boxes_seed_cet4_listening_${prefix}.json`, '{"version":"candidate"}\n');
        write(root, `reviews/agent_self_review/${prefix}-test.json`, multiPrefixEvidence
          ? JSON.stringify({
              sample_policy: {
                review_scope_type: 'residual_blocker_closure',
                residual_blocker_closure: true,
                not_sample_approval: true,
              },
              scope: {box_prefixes: [prefix], card_ids: [`${prefix}01`]},
              quality_audit: {report: `reviews/audit_scopes/${prefix}-test.json`},
            })
          : confirmedExpansionEvidence
            ? JSON.stringify({
            sample_policy: {review_scope_type: 'three_card_sample_per_box'},
            scope: {box_prefixes: ['0000'], card_ids: ['000001', '000002', '000003']},
            quality_audit: {report: 'reviews/audit_scopes/0000-test.json'},
          })
            : '{"version":"candidate"}\n');
        write(root, `reviews/audit_scopes/${prefix}-test.json`, '{"version":"candidate"}\n');
      }
      if (confirmedExpansionEvidence) {
        write(root, 'reviews/agent_self_review/0000-expansion.json', JSON.stringify({
          sample_policy: {
            review_scope_type: 'confirmed_box_expansion',
            confirmed_box_expansion: true,
            sample_confirmation_satisfied: true,
            sample_confirmation_id: 'fixture-confirmation',
          },
          scope: {box_prefixes: ['0000'], card_ids: ['000004', '000005']},
          quality_audit: {report: 'reviews/audit_scopes/0000-expansion.json'},
        }));
        write(root, 'reviews/audit_scopes/0000-expansion.json', '{"version":"candidate-expansion"}\n');
      }
    }
    if (audioRecord) {
      write(root, 'reviews/audio_qc/current.json', '{"schema_version":"model-owned-audio-qc.v2"}\n');
    }
    if (authorizationRecord) {
      write(root, 'reviews/approved_batches/current.json', '{"schema_version":"model-owned-content-authorization.v2"}\n');
    }
  }
  let payloadCommitSha;
  const hasIndexOnlyPayload = gitlinkPath || rawInvalidUtf8Path;
  if (hasIndexOnlyPayload) {
    git(root, 'add', '--all');
    if (gitlinkPath) {
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${baseCommitSha},deps/hidden`);
    }
    if (rawInvalidUtf8Path) stageInvalidUtf8Path(root);
    git(root, 'commit', '-m', 'payload');
    payloadCommitSha = git(root, 'rev-parse', 'HEAD');
  } else {
    payloadCommitSha = commitAll(root, 'payload');
  }
  const payloadPaths = bomAliasOnly ? ['payload.txt'] : [...PAYLOAD_PATHS];
  if (gitlinkPath && declareGitlink) payloadPaths.push('deps/hidden');
  if (literalMagicPath) payloadPaths.push(':(exclude)**');
  if (rawInvalidUtf8Path) payloadPaths.push('raw-invalid-\ufffd.txt');
  if (unicodePath) payloadPaths.push('docs/听力.txt');
  if (candidateCard) {
    const prefixes = multiPrefixEvidence ? ['0000', '0001'] : ['0000'];
    for (const prefix of prefixes) {
      payloadPaths.push(
        `card_boxes_json/card_boxes_seed_cet4_listening_${prefix}.json`,
        `reviews/agent_self_review/${prefix}-test.json`,
        `reviews/audit_scopes/${prefix}-test.json`,
      );
    }
    if (confirmedExpansionEvidence) {
      payloadPaths.push(
        'reviews/agent_self_review/0000-expansion.json',
        'reviews/audit_scopes/0000-expansion.json',
      );
    }
  }
  if (audioRecord) payloadPaths.push('reviews/audio_qc/current.json');
  if (authorizationRecord) payloadPaths.push('reviews/approved_batches/current.json');
  payloadPaths.sort();

  const patchSha256 = computePatchSha256({
    root,
    baseCommitSha,
    commitSha: payloadCommitSha,
    touchedPaths: payloadPaths,
    patchFormat,
  });
  const scope = {
    change_type: 'harness',
    touched_paths: [...payloadPaths],
    patch_sha256: patchSha256,
  };
  if (patchFormat === PATCH_FORMAT_V2) {
    scope.patch_format = patchFormat;
    scope.base_commit_sha = baseCommitSha;
  }
  const record = {
    handoff_id: '20260731-test-delivery',
    created_at: '2026-07-31T20:00:00+08:00',
    agent: 'codex',
    branch: 'harness/test-delivery',
    base_branch: 'main',
    commit_sha: payloadCommitSha,
    push_ref: 'origin/harness/test-delivery',
    PR_url: parked
      ? 'https://github.com/example/card-make/compare/main...harness/test-delivery'
      : 'https://github.com/example/card-make/pull/123',
    PR_state: parked ? 'PARKED_NO_PR_WIP_LIMIT' : 'OPEN',
    is_draft: false,
    scope,
    validation: [{command: 'node --test', result: 'passed'}],
    local_status: 'test fixture',
    remaining_risks: [],
    merge_authority: 'standing_delegation_auto_merge_for_all_validated_change_classes',
  };
  if (multiPrefixEvidence) {
    record.branch = 'content/cet4-multi-prefix-closure';
    record.push_ref = 'origin/content/cet4-multi-prefix-closure';
    record.scope.change_type = 'content_candidate_residual_blocker_closure';
    record.scope.box_prefixes = ['0000', '0001'];
    record.scope.multi_prefix_review_unit = true;
    record.scope.scope_reason = 'Two independently reviewed box remediations are delivered as one residual-closure unit.';
    record.merge_authority = 'standing_delegation_auto_merge_for_all_validated_change_classes';
  }
  write(root, HANDOFF_PATH, `${JSON.stringify(record, null, 2)}\n`);
  let handoffCommitSha;
  if (hasIndexOnlyPayload) {
    git(root, 'add', HANDOFF_PATH);
    git(root, 'commit', '-m', 'handoff');
    handoffCommitSha = git(root, 'rev-parse', 'HEAD');
    updateOriginTrackingRef(root);
  } else {
    handoffCommitSha = commitAll(root, 'handoff');
  }
  return {baseCommitSha, handoffCommitSha, parked, payloadCommitSha, root};
}

function rebuildFixtureWithPayloadHistory(fixture, buildHistory) {
  const originalRecord = readRecord(fixture);
  git(fixture.root, 'reset', '--hard', fixture.baseCommitSha);
  buildHistory(fixture.root, fixture);
  write(fixture.root, 'docs/payload.txt', 'base text\npayload text\n');
  write(fixture.root, 'assets/payload.bin', Buffer.from([0, 1, 2, 9, 8, 7, 6, 5]));
  fixture.payloadCommitSha = commitAll(fixture.root, 'final payload');
  originalRecord.commit_sha = fixture.payloadCommitSha;
  originalRecord.scope.base_commit_sha = fixture.baseCommitSha;
  originalRecord.scope.touched_paths = [...PAYLOAD_PATHS];
  originalRecord.scope.patch_sha256 = computePatchSha256({
    root: fixture.root,
    baseCommitSha: fixture.baseCommitSha,
    commitSha: fixture.payloadCommitSha,
    touchedPaths: PAYLOAD_PATHS,
    patchFormat: PATCH_FORMAT_V2,
  });
  writeRecord(fixture, originalRecord);
  fixture.handoffCommitSha = commitAll(fixture.root, 'handoff after historical payload');
}

function validate(fixture, {branch = 'harness/test-delivery'} = {}) {
  const pullRequest = fixture.parked
    ? undefined
    : pullRequestContext(fixture, {headBranch: branch});
  return validateDeliveryRecord({
    root: fixture.root,
    base: 'main',
    head: 'HEAD',
    branch,
    baseBranch: 'main',
    pullRequest,
  });
}

function pullRequestContext(fixture, overrides = {}) {
  return {
    number: 123,
    url: 'https://github.com/example/card-make/pull/123',
    state: 'open',
    merged: false,
    isDraft: false,
    headSha: git(fixture.root, 'rev-parse', 'HEAD'),
    headBranch: 'harness/test-delivery',
    headRepository: 'example/card-make',
    baseBranch: 'main',
    baseRepository: 'example/card-make',
    ...overrides,
  };
}

function assertError(result, pattern) {
  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  assert.ok(
    result.errors.some(error => pattern.test(error)),
    `expected ${pattern} in:\n${result.errors.join('\n')}`,
  );
}

function cleanUp(t, fixture) {
  t.after(() => fs.rmSync(fixture.root, {recursive: true, force: true}));
}

function commitHandoffWithMode(fixture, mode) {
  let objectOid = fixture.payloadCommitSha;
  if (mode !== '160000') {
    objectOid = execFileSync(
      'git',
      ['hash-object', '-w', '--stdin'],
      {
        cwd: fixture.root,
        encoding: 'utf8',
        input: JSON.stringify(readRecord(fixture)),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  }
  git(fixture.root, 'update-index', '--add', '--cacheinfo', `${mode},${objectOid},${HANDOFF_PATH}`);
  git(fixture.root, 'commit', '-m', `handoff mode ${mode}`);
  updateOriginTrackingRef(fixture.root);
}

function moveHandoffRecord(fixture, destination) {
  const source = path.join(fixture.root, HANDOFF_PATH);
  const target = path.join(fixture.root, destination);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.renameSync(source, target);
  commitAll(fixture.root, `move handoff to ${JSON.stringify(destination)}`);
}

test('rejects legacy scoped hashes for a current pull-request handoff', t => {
  const fixture = createFixture({patchFormat: null});
  cleanUp(t, fixture);

  assertError(validate(fixture), /current handoff scope\.patch_format must equal git-diff-binary-v2/);
});

test('accepts a parked candidate compare locator in the legacy PR_url field', t => {
  const fixture = createFixture({parked: true});
  cleanUp(t, fixture);

  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('rejects a parked compare locator whose base or branch does not match the record', t => {
  const fixture = createFixture({parked: true});
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    record.PR_url = 'https://github.com/example/card-make/compare/develop...harness/other-branch';
  });

  assertError(validate(fixture), /must use \/compare\/main\.\.\.harness\/test-delivery/);
});

test('rejects a push_ref that does not target origin and the recorded branch', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    record.push_ref = 'origin/harness/other-branch';
  });

  assertError(validate(fixture), /push_ref mismatch: origin\/harness\/other-branch != origin\/harness\/test-delivery/);
});

test('accepts v2 deterministic patch evidence bound to the merge-base', t => {
  const fixture = createFixture({patchFormat: PATCH_FORMAT_V2});
  cleanUp(t, fixture);

  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('requires a direct regular 100644 handoff blob at fixed HEAD', async t => {
  await t.test('rejects a valid JSON symlink blob', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    commitHandoffWithMode(fixture, '120000');

    assertError(validate(fixture), /must be a direct regular 100644 blob.*120000 blob/);
  });

  await t.test('rejects an executable JSON blob', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    commitHandoffWithMode(fixture, '100755');

    assertError(validate(fixture), /must be a direct regular 100644 blob.*100755 blob/);
  });

  await t.test('rejects a gitlink in the handoff zone', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    commitHandoffWithMode(fixture, '160000');

    assertError(validate(fixture), /must be a direct regular 100644 blob.*160000 commit/);
  });
});

test('rejects nested or anomalous handoff record paths', async t => {
  for (const [name, destination] of [
    ['nested child', 'reviews/git_handoffs/nested/record.json'],
    ['newline child', 'reviews/git_handoffs/bad\nrecord.json'],
    ['backslash child', 'reviews/git_handoffs/bad\\record.json'],
    ['Unicode line separator child', 'reviews/git_handoffs/bad\u2028record.json'],
  ]) {
    await t.test(name, subtest => {
      const fixture = createFixture();
      cleanUp(subtest, fixture);
      moveHandoffRecord(fixture, destination);

      assertError(
        validate(fixture),
        /handoff record (?:path is not a safe repository-relative path|must be a direct canonical JSON child)/,
      );
    });
  }
});

test('treats pathspec magic as a literal tracked payload path', t => {
  const fixture = createFixture({
    patchFormat: PATCH_FORMAT_V2,
    literalMagicPath: true,
  });
  cleanUp(t, fixture);

  const patch = buildPatchBytes({
    root: fixture.root,
    baseCommitSha: fixture.baseCommitSha,
    commitSha: fixture.payloadCommitSha,
    touchedPaths: [':(exclude)**'],
    patchFormat: PATCH_FORMAT_V2,
  });
  assert.ok(patch.length > 0);
  assert.match(patch.toString('utf8'), /exclude/);
  assert.equal(validate(fixture).ok, true);
});

test('rejects a non-UTF-8 payload path instead of hashing a lossy alias', t => {
  const fixture = createFixture({
    patchFormat: PATCH_FORMAT_V2,
    rawInvalidUtf8Path: true,
  });
  cleanUp(t, fixture);

  assertError(validate(fixture), /unable to inspect PR diff/);
});

test('preserves a leading UTF-8 BOM in a payload path instead of accepting its stripped alias', t => {
  const fixture = createFixture({
    bomAliasOnly: true,
    patchFormat: PATCH_FORMAT_V2,
  });
  cleanUp(t, fixture);

  assertError(validate(fixture), /payload path missing from scope\.touched_paths: \ufeffpayload\.txt/);
});

test('reads an explicit head snapshot instead of an uncommitted handoff rewrite', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    record.PR_url = 'https://github.com/example/card-make/compare/main...harness/test-delivery';
  });
  const worktreeRecord = readRecord(fixture);
  worktreeRecord.PR_url = 'https://github.com/example/card-make/pull/123';
  writeRecord(fixture, worktreeRecord);

  assertError(validate(fixture), /for OPEN must use \/pull\/<number>/);
});

test('an arbitrary TEMPLATE suffix remains a governed handoff record', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  write(
    fixture.root,
    'reviews/git_handoffs/EVILTEMPLATE.json',
    `${JSON.stringify({spoofed: true}, null, 2)}\n`,
  );
  commitAll(fixture.root, 'add disguised handoff');

  assertError(validate(fixture), /exactly one git handoff record is required, got 2/);
});

test('rejects an incorrect incremental patch hash', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    record.scope.patch_sha256 = '0'.repeat(64);
  });

  assertError(validate(fixture), /patch_sha256 mismatch/);
});

test('rejects removing v2 fields to downgrade a current handoff', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    delete record.scope.patch_format;
    delete record.scope.base_commit_sha;
    delete record.scope.patch_sha256;
  });

  assertError(validate(fixture), /current handoff scope\.patch_format must equal git-diff-binary-v2/);
});

test('enforces payload path completeness for a harness record without a patch hash', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    delete record.scope.patch_sha256;
    record.scope.touched_paths = ['assets/payload.bin'];
  });

  assertError(validate(fixture), /payload path missing from scope\.touched_paths: docs\/payload\.txt/);
});

test('rejects missing, extra, out-of-order, duplicate, unsafe, and self-referential touched paths', async t => {
  await t.test('empty path set', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = [];
    });
    assertError(validate(fixture), /scope\.touched_paths must be a non-empty array/);
  });

  await t.test('missing payload path', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = ['assets/payload.bin'];
    });
    assertError(validate(fixture), /payload path missing from scope\.touched_paths: docs\/payload\.txt/);
  });

  await t.test('extra unchanged path', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = [...PAYLOAD_PATHS, 'docs/unchanged.txt'];
    });
    assertError(validate(fixture), /names a path not changed by the payload: docs\/unchanged\.txt/);
  });

  await t.test('out-of-order paths', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = [...PAYLOAD_PATHS].reverse();
    });
    assertError(validate(fixture), /must be sorted lexicographically/);
  });

  await t.test('duplicate paths', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = ['assets/payload.bin', 'assets/payload.bin', 'docs/payload.txt'];
    });
    assertError(validate(fixture), /must not contain duplicates/);
  });

  await t.test('repository escape', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = ['../escape', ...PAYLOAD_PATHS];
    });
    assertError(validate(fixture), /not a safe repository-relative path/);
  });

  await t.test('current handoff path', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.scope.touched_paths = [...PAYLOAD_PATHS, HANDOFF_PATH];
    });
    assertError(validate(fixture), /must not include the current handoff record/);
  });
});

test('accepts a handoff-only commit after the final payload commit', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);

  assert.notEqual(fixture.payloadCommitSha, fixture.handoffCommitSha);
  assert.equal(validate(fixture).ok, true);
});

test('rejects transient paths anywhere in the complete pre-payload history', async t => {
  await t.test('add then delete', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    rebuildFixtureWithPayloadHistory(fixture, root => {
      write(root, 'secrets/transient-token.txt', 'transient secret\n');
      commitAll(root, 'add transient secret');
      fs.rmSync(path.join(root, 'secrets/transient-token.txt'));
      commitAll(root, 'delete transient secret');
    });
    assertError(validate(fixture), /payload history contains a transient or restored path: secrets\/transient-token\.txt/);
  });

  await t.test('modify then restore', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    rebuildFixtureWithPayloadHistory(fixture, root => {
      write(root, 'docs/unchanged.txt', 'temporary rewrite\n');
      commitAll(root, 'temporarily rewrite tracked file');
      write(root, 'docs/unchanged.txt', 'unchanged\n');
      commitAll(root, 'restore tracked file');
    });
    assertError(validate(fixture), /payload history contains a transient or restored path: docs\/unchanged\.txt/);
  });

  await t.test('restored side branch merged before payload', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    rebuildFixtureWithPayloadHistory(fixture, (root, state) => {
      git(root, 'switch', '-c', 'hidden-pre-payload', state.baseCommitSha);
      write(root, 'secrets/side-branch-token.txt', 'side branch secret\n');
      commitAll(root, 'add side branch secret');
      fs.rmSync(path.join(root, 'secrets/side-branch-token.txt'));
      commitAll(root, 'restore side branch tree');
      git(root, 'switch', 'harness/test-delivery');
      git(root, 'merge', '--no-ff', 'hidden-pre-payload', '-m', 'merge restored side branch');
      updateOriginTrackingRef(root);
    });
    assertError(validate(fixture), /payload history contains a transient or restored path: secrets\/side-branch-token\.txt/);
  });

  await t.test('restored non-UTF-8 path', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    rebuildFixtureWithPayloadHistory(fixture, (root, state) => {
      stageInvalidUtf8Path(root, 'pre-payload');
      git(root, 'commit', '-m', 'add non-UTF-8 path before payload');
      git(root, 'read-tree', '--reset', '-u', state.baseCommitSha);
      git(root, 'commit', '-m', 'restore tree after non-UTF-8 path');
      updateOriginTrackingRef(root);
    });
    assertError(validate(fixture), /unable to inspect complete payload history through handoff commit_sha/);
  });

  await t.test('restored gitlink', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    rebuildFixtureWithPayloadHistory(fixture, (root, state) => {
      git(root, 'update-index', '--add', '--cacheinfo', `160000,${state.baseCommitSha},deps/transient`);
      git(root, 'commit', '-m', 'add transient gitlink');
      git(root, 'read-tree', '--reset', '-u', state.baseCommitSha);
      git(root, 'commit', '-m', 'restore tree after gitlink');
      updateOriginTrackingRef(root);
    });
    assertError(validate(fixture), /payload history contains a transient or restored path: deps\/transient/);
  });
});

test('rejects a substantive change after the recorded final payload commit', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  write(fixture.root, 'docs/payload.txt', 'changed after recorded payload\n');
  commitAll(fixture.root, 'late payload mutation');

  assertError(validate(fixture), /non-handoff path changed after handoff commit_sha: docs\/payload\.txt/);
});

test('rejects a post-payload mutation even when a later commit restores the payload tree', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  write(fixture.root, 'docs/payload.txt', 'transient mutation after recorded payload\n');
  commitAll(fixture.root, 'transient late payload mutation');
  write(fixture.root, 'docs/payload.txt', 'base text\npayload text\n');
  commitAll(fixture.root, 'restore payload tree');

  assertError(validate(fixture), /non-handoff path changed after handoff commit_sha: docs\/payload\.txt/);
});

test('rejects restored mutations hidden in a pre-payload side branch with an identical-tree merge', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  git(fixture.root, 'switch', '-c', 'hidden-side', fixture.baseCommitSha);
  git(fixture.root, 'read-tree', '--reset', '-u', fixture.handoffCommitSha);
  commitAll(fixture.root, 'replicate payload and handoff tree');
  write(fixture.root, 'docs/transient.txt', 'hidden side-branch mutation\n');
  commitAll(fixture.root, 'hidden side-branch mutation');
  fs.rmSync(path.join(fixture.root, 'docs/transient.txt'));
  commitAll(fixture.root, 'restore hidden side-branch tree');

  git(fixture.root, 'switch', 'harness/test-delivery');
  git(fixture.root, 'merge', '--no-ff', 'hidden-side', '-m', 'merge identical side tree');

  assertError(validate(fixture), /non-handoff path changed after handoff commit_sha: docs\/transient\.txt/);
});

test('rejects a restored non-UTF-8 path in post-payload history', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  stageInvalidUtf8Path(fixture.root, 'transient');
  git(fixture.root, 'commit', '-m', 'add transient non-UTF-8 path');
  commitAll(fixture.root, 'restore tree after non-UTF-8 path');

  assertError(validate(fixture), /unable to inspect changes after handoff commit_sha/);
});

test('validates the explicit pull-request head when the base branch advances', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  git(fixture.root, 'switch', 'main');
  write(fixture.root, 'docs/base-only.txt', 'base advanced independently\n');
  commitAll(fixture.root, 'advance base');
  git(fixture.root, 'switch', 'harness/test-delivery');

  const result = validateDeliveryRecord({
    root: fixture.root,
    base: 'main',
    head: fixture.handoffCommitSha,
    branch: 'harness/test-delivery',
    baseBranch: 'main',
    pullRequest: pullRequestContext(fixture, {headSha: fixture.handoffCommitSha}),
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('ignores Git replace refs when inspecting fixed payload history', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  write(fixture.root, 'docs/late-replaced.txt', 'late payload hidden by replace ref\n');
  const lateHead = commitAll(fixture.root, 'late payload targeted by replace ref');
  git(fixture.root, 'replace', lateHead, fixture.handoffCommitSha);

  assertError(
    validate(fixture),
    /non-handoff path changed after handoff commit_sha: docs\/late-replaced\.txt/,
  );
});

test('ignores an injected GIT_REPLACE_REF_BASE when inspecting fixed history', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  write(fixture.root, 'docs/late-alternate-replace.txt', 'late payload hidden by alternate replace ref\n');
  const lateHead = commitAll(fixture.root, 'late payload targeted by alternate replace ref');
  const alternateBase = 'refs/alternate-replace/';
  git(
    fixture.root,
    'update-ref',
    `${alternateBase}${lateHead}`,
    fixture.handoffCommitSha,
  );

  const priorReplaceBase = process.env.GIT_REPLACE_REF_BASE;
  process.env.GIT_REPLACE_REF_BASE = alternateBase;
  try {
    const shapedTree = git(fixture.root, 'rev-parse', 'HEAD^{tree}');
    const handoffTree = git(fixture.root, 'rev-parse', `${fixture.handoffCommitSha}^{tree}`);
    assert.equal(shapedTree, handoffTree, 'test setup must activate the alternate replace namespace');
    assertError(
      validate(fixture),
      /non-handoff path changed after handoff commit_sha: docs\/late-alternate-replace\.txt/,
    );
  } finally {
    if (priorReplaceBase === undefined) delete process.env.GIT_REPLACE_REF_BASE;
    else process.env.GIT_REPLACE_REF_BASE = priorReplaceBase;
  }
});

test('v2 patch evidence ignores ambient diff formatting and attribute config', t => {
  const fixture = createFixture({
    patchFormat: PATCH_FORMAT_V2,
    unicodePath: true,
  });
  cleanUp(t, fixture);
  const record = readRecord(fixture);
  const expected = record.scope.patch_sha256;
  const orderFile = path.join(fixture.root, 'ambient-diff-order');
  const attributesFile = path.join(fixture.root, 'ambient-global-attributes');
  write(fixture.root, 'ambient-diff-order', 'docs/**\nassets/**\n');
  write(fixture.root, 'ambient-global-attributes', '*.txt binary\n');
  write(fixture.root, '.gitattributes', '*.txt binary\n');
  git(fixture.root, 'config', 'color.ui', 'always');
  git(fixture.root, 'config', 'core.quotePath', 'false');
  git(fixture.root, 'config', 'core.attributesFile', attributesFile);
  git(fixture.root, 'config', 'diff.noprefix', 'true');
  git(fixture.root, 'config', 'diff.context', '0');
  git(fixture.root, 'config', 'diff.algorithm', 'histogram');
  git(fixture.root, 'config', 'diff.indentHeuristic', 'true');
  git(fixture.root, 'config', 'diff.interHunkContext', '7');
  git(fixture.root, 'config', 'diff.ignoreSubmodules', 'all');
  git(fixture.root, 'config', 'diff.orderFile', orderFile);
  const priorDiffOpts = process.env.GIT_DIFF_OPTS;
  const priorConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
  const priorConfigCount = process.env.GIT_CONFIG_COUNT;
  const priorConfigKey0 = process.env.GIT_CONFIG_KEY_0;
  const priorConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
  const priorIcasePathspecs = process.env.GIT_ICASE_PATHSPECS;
  process.env.GIT_DIFF_OPTS = '-U0';
  process.env.GIT_CONFIG_PARAMETERS = "'diff.noprefix=true'";
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'diff.context';
  process.env.GIT_CONFIG_VALUE_0 = '0';
  process.env.GIT_ICASE_PATHSPECS = '1';
  try {
    const actual = computePatchSha256({
      root: fixture.root,
      baseCommitSha: fixture.baseCommitSha,
      commitSha: fixture.payloadCommitSha,
      touchedPaths: record.scope.touched_paths,
      patchFormat: PATCH_FORMAT_V2,
    });
    assert.equal(actual, expected);
    assert.equal(validate(fixture).ok, true);
  } finally {
    if (priorDiffOpts === undefined) delete process.env.GIT_DIFF_OPTS;
    else process.env.GIT_DIFF_OPTS = priorDiffOpts;
    if (priorConfigParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = priorConfigParameters;
    if (priorConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = priorConfigCount;
    if (priorConfigKey0 === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = priorConfigKey0;
    if (priorConfigValue0 === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = priorConfigValue0;
    if (priorIcasePathspecs === undefined) delete process.env.GIT_ICASE_PATHSPECS;
    else process.env.GIT_ICASE_PATHSPECS = priorIcasePathspecs;
  }
});

test('v2 prechecks ignore malformed injected Git config environment', t => {
  const fixture = createFixture({patchFormat: PATCH_FORMAT_V2});
  cleanUp(t, fixture);
  const record = readRecord(fixture);
  const priorConfigParameters = process.env.GIT_CONFIG_PARAMETERS;
  const priorConfigCount = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_PARAMETERS = 'malformed';
  process.env.GIT_CONFIG_COUNT = 'not-a-number';
  try {
    const actual = computePatchSha256({
      root: fixture.root,
      baseCommitSha: fixture.baseCommitSha,
      commitSha: fixture.payloadCommitSha,
      touchedPaths: record.scope.touched_paths,
      patchFormat: PATCH_FORMAT_V2,
    });
    assert.equal(actual, record.scope.patch_sha256);
  } finally {
    if (priorConfigParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = priorConfigParameters;
    if (priorConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = priorConfigCount;
  }
});

test('v2 patch evidence rejects non-empty repository info attributes', t => {
  const fixture = createFixture({patchFormat: PATCH_FORMAT_V2});
  cleanUp(t, fixture);
  const record = readRecord(fixture);
  const infoAttributes = git(fixture.root, 'rev-parse', '--git-path', 'info/attributes');
  write(fixture.root, infoAttributes, '*.txt binary\n');

  assert.throws(
    () => computePatchSha256({
      root: fixture.root,
      baseCommitSha: fixture.baseCommitSha,
      commitSha: fixture.payloadCommitSha,
      touchedPaths: record.scope.touched_paths,
      patchFormat: PATCH_FORMAT_V2,
    }),
    /refuses non-empty repository info attributes/,
  );
  assertError(validate(fixture), /unable to recompute handoff scope\.patch_sha256/);
});

test('v2 patch evidence rejects ambient custom diff-driver config', t => {
  const fixture = createFixture({
    customDiffDriver: true,
    patchFormat: PATCH_FORMAT_V2,
  });
  cleanUp(t, fixture);
  const record = readRecord(fixture);
  git(fixture.root, 'config', 'diff.fixture.binary', 'true');

  assert.throws(
    () => computePatchSha256({
      root: fixture.root,
      baseCommitSha: fixture.baseCommitSha,
      commitSha: fixture.payloadCommitSha,
      touchedPaths: record.scope.touched_paths,
      patchFormat: PATCH_FORMAT_V2,
    }),
    /refuses custom diff-driver config/,
  );
  assertError(validate(fixture), /unable to recompute handoff scope\.patch_sha256/);
});

test('v2 patch evidence rejects worktree custom diff-driver config', t => {
  const fixture = createFixture({
    customDiffDriver: true,
    patchFormat: PATCH_FORMAT_V2,
  });
  cleanUp(t, fixture);
  const record = readRecord(fixture);
  git(fixture.root, 'config', 'extensions.worktreeConfig', 'true');
  git(fixture.root, 'config', '--worktree', 'diff.fixture.binary', 'true');

  assert.throws(
    () => computePatchSha256({
      root: fixture.root,
      baseCommitSha: fixture.baseCommitSha,
      commitSha: fixture.payloadCommitSha,
      touchedPaths: record.scope.touched_paths,
      patchFormat: PATCH_FORMAT_V2,
    }),
    /refuses custom diff-driver config/,
  );
});

test('v2 patch evidence includes gitlinks despite ambient submodule ignore config', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-record-gitlink-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Delivery Validator Test');
  git(root, 'config', 'user.email', 'delivery-validator@example.com');
  write(root, 'README.md', 'base\n');
  const baseCommitSha = commitAll(root, 'base');

  git(root, 'switch', '-c', 'harness/gitlink');
  write(root, 'README.md', 'payload\n');
  git(root, 'add', '--all');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${baseCommitSha},deps/example`);
  git(root, 'commit', '-m', 'payload with gitlink');
  const commitSha = git(root, 'rev-parse', 'HEAD');
  const options = {
    root,
    baseCommitSha,
    commitSha,
    touchedPaths: ['README.md', 'deps/example'],
    patchFormat: PATCH_FORMAT_V2,
  };
  const expected = computePatchSha256(options);

  git(root, 'config', 'diff.ignoreSubmodules', 'all');
  const patch = buildPatchBytes(options).toString('utf8');
  assert.match(patch, /diff --git a\/deps\/example b\/deps\/example/);
  assert.equal(computePatchSha256(options), expected);
});

test('payload completeness rejects an omitted gitlink despite ambient submodule ignore config', t => {
  const fixture = createFixture({
    declareGitlink: false,
    gitlinkPath: true,
    patchFormat: PATCH_FORMAT_V2,
  });
  cleanUp(t, fixture);
  git(fixture.root, 'config', 'diff.ignoreSubmodules', 'all');

  assertError(validate(fixture), /payload path missing from scope\.touched_paths: deps\/hidden/);
});

test('rejects compare URLs for real PR states and pull URLs for parked state', async t => {
  await t.test('real PR state with compare URL', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.PR_url = 'https://github.com/example/card-make/compare/main...harness/test-delivery';
    });
    assertError(validate(fixture), /for OPEN must use \/pull\/<number>/);
  });

  await t.test('parked state with pull URL', subtest => {
    const fixture = createFixture({parked: true});
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.PR_url = 'https://github.com/example/card-make/pull/123';
    });
    assertError(validate(fixture), /for PARKED_NO_PR_WIP_LIMIT must use \/compare\/main\.\.\.harness\/test-delivery/);
  });

  await t.test('URL for a different repository', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.PR_url = 'https://github.com/other/card-make/pull/123';
    });
    assertError(validate(fixture), /PR_url repository mismatch/);
  });
});

test('enforces the complete current handoff schema and authority mapping', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    delete record.handoff_id;
    delete record.created_at;
    delete record.agent;
    record.is_draft = 'not-a-boolean';
    record.validation = [null];
    record.local_status = null;
    record.remaining_risks = [null];
    record.scope.change_type = null;
    record.merge_authority = null;
  });

  const result = validate(fixture);
  for (const pattern of [
    /missing handoff_id/,
    /missing created_at/,
    /missing agent/,
    /is_draft must be a boolean/,
    /validation entries must be objects with non-empty command and result strings/,
    /local_status must be a non-empty string/,
    /remaining_risks entries must be non-empty strings/,
    /scope\.change_type is unsupported/,
    /merge_authority must be a non-empty string/,
  ]) {
    assertError(result, pattern);
  }
});

test('requires canonical handoff identity and a real calendar timestamp', async t => {
  await t.test('handoff_id matches the direct filename', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.handoff_id = '20260731-another-delivery';
    });
    assertError(validate(fixture), /handoff_id must equal its filename/);
  });

  await t.test('created_at rejects normalized impossible dates', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.created_at = '2026-02-31T20:00:00+08:00';
    });
    assertError(validate(fixture), /created_at must be a valid RFC3339 timestamp/);
  });
});

test('candidate card payload cannot claim harness auto-merge authority', t => {
  const fixture = createFixture({candidateCard: true});
  cleanUp(t, fixture);
  assertError(validate(fixture), /candidate card payload must use a content change_type and validated auto-merge authority/);
});

for (const [name, option, expectedType, errorPattern] of [
  ['audio', {audioRecord: true}, 'audio', /scope\.change_type=audio/],
  ['authorization', {authorizationRecord: true}, 'authorization', /scope\.change_type=authorization/],
]) {
  test(`${name} evidence requires its explicit delivery change type`, t => {
    const fixture = createFixture(option);
    cleanUp(t, fixture);
    assertError(validate(fixture), errorPattern);
    mutateRecord(fixture, record => {
      record.scope.change_type = expectedType;
    });
    const result = validate(fixture);
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  });
}

test('accepts one sample plus one confirmed-expansion evidence pair for a candidate card payload', t => {
  const fixture = createFixture({candidateCard: true, confirmedExpansionEvidence: true});
  cleanUp(t, fixture);
  mutateRecord(fixture, record => {
    record.branch = 'content/cet4-listening-0000';
    record.push_ref = 'origin/content/cet4-listening-0000';
    record.scope.change_type = 'content_sample';
    record.merge_authority = 'standing_delegation_auto_merge_for_all_validated_change_classes';
  });

  const result = validate(fixture, {branch: 'content/cet4-listening-0000'});
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('accepts exact per-prefix residual-closure evidence for a declared multi-prefix content unit', t => {
  const fixture = createFixture({multiPrefixEvidence: true});
  cleanUp(t, fixture);

  const result = validate(fixture, {branch: 'content/cet4-multi-prefix-closure'});
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test('rejects an arbitrary two-review candidate evidence bundle', t => {
  const fixture = createFixture({candidateCard: true, confirmedExpansionEvidence: true});
  cleanUp(t, fixture);
  const expansionPath = path.join(
    fixture.root,
    'reviews/agent_self_review/0000-expansion.json',
  );
  const expansion = JSON.parse(fs.readFileSync(expansionPath, 'utf8'));
  expansion.sample_policy.review_scope_type = 'residual_blocker_closure';
  write(fixture.root, 'reviews/agent_self_review/0000-expansion.json', JSON.stringify(expansion));
  commitAll(fixture.root, 'corrupt expansion evidence');

  assertError(validate(fixture), /exactly one three-card sample and one confirmed box expansion/);
});

test('binds real pull-request records to exact event metadata', async t => {
  await t.test('event context is mandatory', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    const result = validateDeliveryRecord({
      root: fixture.root,
      base: 'main',
      head: 'HEAD',
      branch: 'harness/test-delivery',
      baseBranch: 'main',
    });
    assertError(result, /requires exact pull-request event context/);
  });

  await t.test('PR number and URL must match the event', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    mutateRecord(fixture, record => {
      record.PR_url = 'https://github.com/example/card-make/pull/99999999';
    });
    const result = validate(fixture);
    assertError(result, /PR number mismatch: 99999999 != 123/);
    assertError(result, /PR_url must exactly equal the event URL/);
  });

  await t.test('head SHA, draft state, and repository must match', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    const result = validateDeliveryRecord({
      root: fixture.root,
      base: 'main',
      head: 'HEAD',
      branch: 'harness/test-delivery',
      baseBranch: 'main',
      pullRequest: pullRequestContext(fixture, {
        headSha: fixture.payloadCommitSha,
        isDraft: true,
        headRepository: 'fork-owner/card-make',
      }),
    });
    assertError(result, /event head SHA must equal the explicit validated head/);
    assertError(result, /is_draft must equal the event draft state/);
    assertError(result, /fork pull requests are not supported/);
  });
});

test('requires parked push_ref evidence to resolve to the explicit head', async t => {
  await t.test('missing remote branch', subtest => {
    const fixture = createFixture({parked: true});
    cleanUp(subtest, fixture);
    git(fixture.root, 'update-ref', '-d', 'refs/remotes/origin/harness/test-delivery');
    assertError(validate(fixture), /parked handoff push_ref must resolve/);
  });

  await t.test('stale remote branch', subtest => {
    const fixture = createFixture({parked: true});
    cleanUp(subtest, fixture);
    git(
      fixture.root,
      'update-ref',
      'refs/remotes/origin/harness/test-delivery',
      fixture.payloadCommitSha,
    );
    assertError(validate(fixture), /parked handoff push_ref must equal the explicit validated head/);
  });
});

test('requires the current handoff artifact to be append-only', async t => {
  await t.test('overwriting a base handoff is rejected', subtest => {
    const fixture = createFixture({historicalHandoffPath: HANDOFF_PATH});
    cleanUp(subtest, fixture);
    assertError(validate(fixture), /current handoff record must be append-only and absent at merge-base/);
  });

  await t.test('deleting an old record while adding a new record is rejected', subtest => {
    const oldPath = 'reviews/git_handoffs/20260730-old-delivery.json';
    const fixture = createFixture({historicalHandoffPath: oldPath});
    cleanUp(subtest, fixture);
    fs.rmSync(path.join(fixture.root, oldPath));
    commitAll(fixture.root, 'delete old handoff after adding current record');
    assertError(validate(fixture), /exactly one git handoff record is required, got 2/);
  });

  await t.test('renaming an old record into the current record is rejected', subtest => {
    const oldPath = 'reviews/git_handoffs/20260730-old-delivery.json';
    const fixture = createFixture({historicalHandoffPath: oldPath});
    cleanUp(subtest, fixture);
    fs.rmSync(path.join(fixture.root, HANDOFF_PATH));
    fs.renameSync(path.join(fixture.root, oldPath), path.join(fixture.root, HANDOFF_PATH));
    commitAll(fixture.root, 'rename historical handoff over current record');
    assertError(validate(fixture), /exactly one git handoff record is required, got 2/);
  });
});

test('rejects legacy Git grafts from the common repository directory', async t => {
  await t.test('ordinary worktree', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    const commonGitDirectory = git(fixture.root, 'rev-parse', '--git-common-dir');
    const graftsPath = path.join(fixture.root, commonGitDirectory, 'info', 'grafts');
    write(fixture.root, path.relative(fixture.root, graftsPath), `${fixture.handoffCommitSha} ${fixture.payloadCommitSha}\n`);
    assertError(validate(fixture), /refuses non-empty repository grafts/);
  });

  await t.test('linked worktree uses the common git directory', subtest => {
    const fixture = createFixture();
    cleanUp(subtest, fixture);
    const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-record-linked-'));
    const linkedRoot = path.join(linkedParent, 'worktree');
    git(fixture.root, 'worktree', 'add', '--detach', linkedRoot, fixture.handoffCommitSha);
    subtest.after(() => {
      try {
        git(fixture.root, 'worktree', 'remove', '--force', linkedRoot);
      } catch {
        // Best-effort fixture cleanup.
      }
      fs.rmSync(linkedParent, {recursive: true, force: true});
    });
    const commonGitDirectory = git(linkedRoot, 'rev-parse', '--git-common-dir');
    const graftsPath = path.join(commonGitDirectory, 'info', 'grafts');
    fs.mkdirSync(path.dirname(graftsPath), {recursive: true});
    fs.writeFileSync(graftsPath, `${fixture.handoffCommitSha} ${fixture.payloadCommitSha}\n`);
    const result = validateDeliveryRecord({
      root: linkedRoot,
      base: 'main',
      head: fixture.handoffCommitSha,
      branch: 'harness/test-delivery',
      baseBranch: 'main',
      pullRequest: pullRequestContext(fixture, {headSha: fixture.handoffCommitSha}),
    });
    assertError(result, /refuses non-empty repository grafts/);
  });
});

test('legacy and v2 hashes are stable across text and binary payloads', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);

  const legacyOptions = {
    root: fixture.root,
    baseCommitSha: fixture.baseCommitSha,
    commitSha: fixture.payloadCommitSha,
    touchedPaths: PAYLOAD_PATHS,
  };
  const legacyPatch = buildPatchBytes(legacyOptions);
  assert.match(legacyPatch.toString('utf8'), /diff --git a\/assets\/payload\.bin b\/assets\/payload\.bin/);
  assert.match(legacyPatch.toString('utf8'), /GIT binary patch/);
  assert.match(legacyPatch.toString('utf8'), /diff --git a\/docs\/payload\.txt b\/docs\/payload\.txt/);
  assert.equal(computePatchSha256(legacyOptions), computePatchSha256(legacyOptions));
  const directLegacyPatch = execFileSync(
    'git',
    ['diff', '--binary', fixture.baseCommitSha, fixture.payloadCommitSha, '--', ...PAYLOAD_PATHS],
    {cwd: fixture.root, encoding: null},
  );
  assert.equal(
    computePatchSha256(legacyOptions),
    crypto.createHash('sha256').update(directLegacyPatch).digest('hex'),
  );

  const v2Options = {...legacyOptions, patchFormat: PATCH_FORMAT_V2};
  const v2PatchBytes = buildPatchBytes(v2Options);
  const v2Patch = v2PatchBytes.toString('utf8');
  assert.match(v2Patch, /index [0-9a-f]{40}\.\.[0-9a-f]{40}/);
  assert.equal(computePatchSha256(v2Options), computePatchSha256(v2Options));
  assert.equal(
    computePatchSha256(v2Options),
    crypto.createHash('sha256').update(v2PatchBytes).digest('hex'),
  );
  assert.equal(computePatchSha256(v2Options), V2_GOLDEN_SHA256);
  assert.notEqual(computePatchSha256(legacyOptions), computePatchSha256(v2Options));
});
