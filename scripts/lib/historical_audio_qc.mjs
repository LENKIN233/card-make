import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {
  runProductTrustedMediaVerifier,
  verifyTrustedMediaEvidence,
} from './trusted_media_reference.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function gitEnv() {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1', GIT_GRAFT_FILE: os.devNull, GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C', LANG: 'C'};
}
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', ...args],
    {cwd: root, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
}
function textGit(root, ...args) { return git(root, ...args).toString('utf8').trim(); }
function regularBytes(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || /[\u0000-\u001f\u007f]/u.test(relative)) {
    throw new Error('Historical evidence path is invalid');
  }
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Historical evidence escapes workspace');
  const parts = path.relative(root, absolute).split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Historical evidence contains a symlink');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || (stat.mode & 0o111)) throw new Error('Historical evidence is not a regular non-executable file');
  return fs.readFileSync(absolute);
}
function committedBytes(root, head, relative) {
  const bytes = regularBytes(root, relative);
  const tree = git(root, 'ls-tree', '-z', head, '--', relative).toString('utf8');
  const match = tree.match(/^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/u);
  if (!match || match[2] !== relative) throw new Error('Historical evidence must be a direct committed 100644 blob');
  const index = git(root, 'ls-files', '--stage', '-z', '--', relative).toString('utf8');
  if (index !== '100644 ' + match[1] + ' 0\t' + relative + '\0' ||
      !bytes.equals(git(root, 'show', head + ':' + relative))) {
    throw new Error('Historical evidence is dirty or staged');
  }
  return bytes;
}

/** Audits immutable past evidence. It never authorizes the current corpus. */
export function createHistoricalAudioQcReplay({
  root,
  execFile = execFileSync,
  typeSpecificVerifier,
} = {}) {
  const normalizedRoot = fs.realpathSync(root);
  const snapshots = new Map();
  const historicalVerifier = typeSpecificVerifier ??
    (args => runProductTrustedMediaVerifier({...args, root: normalizedRoot}));
  function capture(record, source) {
    if (path.posix.dirname(source) !== 'reviews/audio_qc' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(path.posix.basename(source)) ||
        source.endsWith('/TEMPLATE.json')) throw new Error('Historical QC requires a direct non-template record');
    const common = path.resolve(normalizedRoot, textGit(normalizedRoot, 'rev-parse', '--git-common-dir'));
    const grafts = path.join(common, 'info', 'grafts');
    if ((fs.existsSync(grafts) && fs.readFileSync(grafts).toString().trim()) ||
        textGit(normalizedRoot, 'replace', '-l')) throw new Error('Historical replay forbids Git replacements and grafts');
    const head = textGit(normalizedRoot, 'rev-parse', '--verify', 'HEAD^{commit}');
    if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error('Historical replay HEAD is invalid');
    const bytes = committedBytes(normalizedRoot, head, source);
    if (!isDeepStrictEqual(JSON.parse(bytes), record)) throw new Error('Historical QC input differs from its committed record');
    const commit = textGit(normalizedRoot, 'log', '-1', '--format=%H', head, '--', source);
    if (!/^[a-f0-9]{40}$/u.test(commit) || commit === head) throw new Error('New QC cannot be treated as historical evidence');
    git(normalizedRoot, 'merge-base', '--is-ancestor', commit, head);
    if (!bytes.equals(git(normalizedRoot, 'show', commit + ':' + source))) {
      throw new Error('Historical QC does not match its original commit');
    }
    return {head, commit, recordSha256: hash(bytes)};
  }
  function snapshot(commit) {
    if (snapshots.has(commit)) return snapshots.get(commit);
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cardmake-historical-audio-'));
    const directory = path.join(parent, 'card-make');
    try {
      git(normalizedRoot, '-c', 'core.hooksPath=' + os.devNull, 'clone', '--shared', '--no-checkout',
        '--', normalizedRoot, directory);
      git(directory, '-c', 'core.hooksPath=' + os.devNull, 'checkout', '--detach', commit);
      if (textGit(directory, 'rev-parse', 'HEAD') !== commit) throw new Error('Historical checkout commit mismatch');
      const value = {parent, directory, hydratedReceipts: new Set()};
      snapshots.set(commit, value);
      return value;
    } catch (error) {
      fs.rmSync(parent, {recursive: true, force: true});
      throw error;
    }
  }
  function bindReferenceFiles(state, record, captured) {
    const records = record.source_records;
    for (const relative of [records.trusted_media_receipt, records.trusted_media_attestation_bundle,
      records.linked_approved_batch, records.linked_perceptual_worklist]) {
      if (!committedBytes(normalizedRoot, captured.head, relative)
        .equals(committedBytes(state.directory, captured.commit, relative))) {
        throw new Error('Historical linked evidence was changed after its QC decision');
      }
    }
    const stem = path.posix.basename(records.trusted_media_receipt, '.json');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stem)) throw new Error('Historical receipt name is invalid');
    const relativeDirectory = 'reviews/trusted_media_runs/' + stem;
    const oldDirectory = path.join(state.directory, relativeDirectory);
    const currentDirectory = path.join(normalizedRoot, relativeDirectory);
    const oldNames = fs.readdirSync(oldDirectory).sort();
    if (!isDeepStrictEqual(oldNames, fs.readdirSync(currentDirectory).sort())) {
      throw new Error('Historical artifact file set was changed');
    }
    for (const name of oldNames) {
      const relative = relativeDirectory + '/' + name;
      if (!committedBytes(normalizedRoot, captured.head, relative)
        .equals(committedBytes(state.directory, captured.commit, relative))) {
        throw new Error('Historical artifact bytes were changed');
      }
    }
    if (state.hydratedReceipts.has(stem)) return;
    const manifest = JSON.parse(regularBytes(state.directory, relativeDirectory + '/audio-manifest.json'));
    if (!['cet4', 'cet6'].includes(manifest.track) || !Array.isArray(manifest.assets)) {
      throw new Error('Historical audio manifest is invalid');
    }
    for (const asset of manifest.assets) {
      const relative = asset.asset_path;
      if (typeof relative !== 'string' || !relative.startsWith('ai_tts/' + manifest.track + '/') ||
          relative.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Historical audio asset escapes its track');
      }
      const original = git(state.directory, 'show', captured.commit + ':' + relative);
      const pointer = original.toString('utf8').match(
        /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/u);
      const expectedHash = asset.file_sha256;
      const expectedSize = asset.size_bytes;
      if (!/^[a-f0-9]{64}$/u.test(expectedHash || '') || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
          (pointer && (pointer[1] !== expectedHash || Number(pointer[2]) !== expectedSize))) {
        throw new Error('Historical asset does not match its committed identity');
      }
      const bytes = pointer ? regularBytes(normalizedRoot, relative) : original;
      if (hash(bytes) !== expectedHash || bytes.length !== expectedSize) throw new Error('Historical audio bytes do not match');
      // The leaf and its ancestors must be regular tracked paths, never links.
      regularBytes(state.directory, relative);
      fs.writeFileSync(path.join(state.directory, relative), bytes);
    }
    state.hydratedReceipts.add(stem);
  }
  return {
    verify(record, source) {
      const captured = capture(record, source);
      const state = snapshot(captured.commit);
      bindReferenceFiles(state, record, captured);
      const records = record.source_records;
      const evidence = verifyTrustedMediaEvidence({
        root: state.directory, execFile,
        typeSpecificVerifier: historicalVerifier,
        attestationBundlePath: records.trusted_media_attestation_bundle,
        authorizationPath: records.linked_approved_batch,
        expectedSourceRecords: records,
        trustedReceiptPath: records.trusted_media_receipt,
        worklistPath: records.linked_perceptual_worklist,
        worklistSha256: records.perceptual_worklist_sha256,
      });
      const after = capture(record, source);
      if (!isDeepStrictEqual(after, captured)) throw new Error('Current QC identity changed during historical replay');
      bindReferenceFiles(state, record, after);
      return {historical_valid: true, formal_ready: false, record_commit: captured.commit,
        record_sha256: captured.recordSha256, receipt_sha256: evidence.receiptSha256};
    },
    dispose() {
      for (const value of snapshots.values()) fs.rmSync(value.parent, {recursive: true, force: true});
      snapshots.clear();
    },
  };
}
