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
  return git(root, 'rev-parse', 'HEAD');
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
  customDiffDriver = false,
  declareGitlink = true,
  gitlinkPath = false,
  parked = false,
  patchFormat,
  literalMagicPath = false,
  rawInvalidUtf8Path = false,
  unicodePath = false,
} = {}) {
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
  const baseCommitSha = commitAll(root, 'base');

  git(root, 'switch', '-c', 'harness/test-delivery');
  if (bomAliasOnly) {
    write(root, '\ufeffpayload.txt', 'BOM-leading payload path\n');
  } else {
    write(root, 'docs/payload.txt', 'base text\npayload text\n');
    write(root, 'assets/payload.bin', Buffer.from([0, 1, 2, 9, 8, 7, 6, 5]));
    if (literalMagicPath) write(root, ':(exclude)**', 'changed magic path\n');
    if (unicodePath) write(root, 'docs/听力.txt', 'changed listening text\n');
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
    merge_authority: 'test-only',
  };
  write(root, HANDOFF_PATH, `${JSON.stringify(record, null, 2)}\n`);
  let handoffCommitSha;
  if (hasIndexOnlyPayload) {
    git(root, 'add', HANDOFF_PATH);
    git(root, 'commit', '-m', 'handoff');
    handoffCommitSha = git(root, 'rev-parse', 'HEAD');
  } else {
    handoffCommitSha = commitAll(root, 'handoff');
  }
  return {baseCommitSha, handoffCommitSha, payloadCommitSha, root};
}

function validate(fixture) {
  return validateDeliveryRecord({
    root: fixture.root,
    base: 'main',
    head: 'HEAD',
    branch: 'harness/test-delivery',
    baseBranch: 'main',
  });
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

test('accepts a legacy scoped hash and a real pull-request URL', t => {
  const fixture = createFixture();
  cleanUp(t, fixture);

  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.schema_version, 'delivery-record-validation.v2');
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
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
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
