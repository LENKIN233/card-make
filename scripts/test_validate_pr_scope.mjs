#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOTS = new Set();

test.after(() => {
  for (const root of TEMP_ROOTS) fs.rmSync(root, { force: true, recursive: true });
});

test('a diff with no card or self-review change passes', () => {
  const repo = createRepository();
  fs.writeFileSync(path.join(repo.root, 'README.md'), 'administrative update\n');
  commit(repo.root, 'administrative update');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.content_candidate_diff, false);
});

test('changing any legacy card field without complete quality metadata fails', () => {
  const repo = createRepository();
  writeCardBox(repo.root, [{ ...legacyCard(), front: { text: 'changed prompt' } }]);
  commit(repo.root, 'change legacy card');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_card_quality_metadata_invalid');
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
});

test('deleting an entire candidate card box fails even when its ids are omitted from review scope', () => {
  const repo = createRepository();
  fs.rmSync(path.join(
    repo.root,
    'card_boxes_json/card_boxes_seed_cet4_listening_0000.json',
  ));
  commit(repo.root, 'delete candidate card box');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_candidate_card_deleted');
});

test('a noncanonical or Unicode card-box path cannot bypass corpus validation', () => {
  const repo = createRepository();
  const invalidPath = path.join(repo.root, 'card_boxes_json/额外 card box.json');
  writeJson(invalidPath, {cards: [legacyCard()]});
  commit(repo.root, 'add noncanonical card box');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  const issue = assertIssue(result.report, 'candidate_card_box_path_invalid');
  assert.equal(issue.path, 'card_boxes_json/额外 card box.json');

  const globalResult = validateCards(repo);
  assert.notEqual(globalResult.status, 0, globalResult.stdout);
  assert.ok(globalResult.report.first_errors.some(
    error => error.code === 'invalid_card_box_filename',
  ));
});

test('a canonical card-box rename does not invent a content audit failure', () => {
  const repo = createRepository();
  git(
    repo.root,
    'mv',
    'card_boxes_json/card_boxes_seed_cet4_listening_0000.json',
    'card_boxes_json/card_boxes_seed_cet4_listening_alt_0000.json',
  );
  commit(repo.root, 'rename canonical card box');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, []);
  assert.equal(result.report.current_scoped_audit.reason, 'no_added_or_modified_card_objects');
});

test('renaming a card box out of the governed directory is a card deletion', () => {
  const repo = createRepository();
  fs.mkdirSync(path.join(repo.root, 'docs'), {recursive: true});
  git(
    repo.root,
    'mv',
    'card_boxes_json/card_boxes_seed_cet4_listening_0000.json',
    'docs/escaped-card-box.json',
  );
  commit(repo.root, 'rename card box out of corpus');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_candidate_card_deleted');
});

test('a changed card with complete matching changed self-review passes', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review.json', ['000001'], [reviewEntry(card)]);
  commit(repo.root, 'change card with matching review');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
});

test('a changed card cannot be hidden by omitting its id from self-review scope', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review.json', [], [reviewEntry(card)]);
  commit(repo.root, 'omit changed card from scope');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_card_missing_from_scope');
  assertIssue(result.report, 'changed_card_self_review_count_invalid');
});

test('changed card and self-review quality metadata must deeply match', () => {
  const repo = createRepository();
  const card = completeCard();
  const review = reviewEntry(card);
  review.quality_metadata.exam_value = '不一致的考试价值说明，不能伪装成同一份元数据。';
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review.json', ['000001'], [review]);
  commit(repo.root, 'mismatch review metadata');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_card_self_review_metadata_mismatch');
});

test('self-review-only metadata drift is compared with the unchanged HEAD corpus', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReview(
    repo.root,
    'review.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish governed card and review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.cards[0].quality_metadata.exam_value =
    '这条仍满足 schema，但已经与当前卡片的考试价值证据发生漂移。';
  writeJson(reviewPath, review);
  commit(repo.root, 'drift self-review only');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, []);
  assertIssue(result.report, 'changed_card_self_review_metadata_mismatch');
});

test('unprefixed full-track self-review drift cannot bypass HEAD corpus parity', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReviewFile(
    repo.root,
    '20260731-cet4-full-track-remediation.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish unprefixed full-track review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.cards[0].quality_metadata.exam_value =
    '这条仍满足 schema，但无前缀文件名也不能绕过与当前卡片的元数据一致性。';
  writeJson(reviewPath, review);
  commit(repo.root, 'drift unprefixed full-track review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_card_self_review_metadata_mismatch');
});

test('deleting self-review evidence fails closed', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReview(
    repo.root,
    'review.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish governed card and review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  fs.rmSync(reviewPath);
  commit(repo.root, 'delete self-review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_deleted');
});

test('deleting an unprefixed full-track self-review fails closed', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReviewFile(
    repo.root,
    '20260731-cet4-full-track-remediation.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish unprefixed full-track review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  fs.rmSync(reviewPath);
  commit(repo.root, 'delete unprefixed full-track review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_self_review_deleted');
});

test('unprefixed draft and scoped-audit JSON changes enter content scope', async t => {
  for (const relativePath of [
    'reviews/drafts/full-track-remediation.json',
    'reviews/audit_scopes/full-track-remediation.json',
  ]) {
    await t.test(relativePath, () => {
      const repo = createRepository();
      writeJson(path.join(repo.root, relativePath), {
        scope: {card_ids: ['000001']},
      });
      commit(repo.root, `add ${relativePath}`);

      const result = validate(repo);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.report.content_candidate_diff, true);
    });
  }
});

test('review templates remain outside content-candidate scope', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json'),
    {template: true},
  );
  commit(repo.root, 'add full-track review template');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.content_candidate_diff, false);
});

test('a misleading TEMPLATE suffix cannot disguise an unprefixed self-review', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReviewFile(
    repo.root,
    '20260731-REAL-NOT_A_TEMPLATE.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish misleadingly named governed review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.cards[0].quality_metadata.exam_value =
    '未知 TEMPLATE 后缀仍是受治理记录，不能绕过当前卡片一致性。';
  writeJson(reviewPath, review);
  commit(repo.root, 'drift misleadingly named governed review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_card_self_review_metadata_mismatch');
});

test('strict full-track aggregate coverage can review a changed card without cards snapshots', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
  });
  commit(repo.root, 'change card under full-track aggregate review');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
  assert.deepEqual(
    result.report.changed_card_integrity.changed_full_track_review_paths,
    ['reviews/agent_self_review/20260731-cet4-full-track-remediation.json'],
  );
});

test('full-track aggregate cannot shrink to only the changed card', () => {
  const repo = createRepository();
  const secondCard = {
    ...legacyCard(),
    card_id: '000002',
    knowledge_ref: {box_prefix: '0001'},
    front: {text: 'second baseline prompt'},
  };
  writeCardBox(repo.root, [legacyCard(), secondCard]);
  commit(repo.root, 'establish two-box CET4 track');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  writeCardBox(repo.root, [completeCard(), secondCard]);
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
    boxPrefixes: ['0000'],
  });
  commit(repo.root, 'claim partial track as full-track review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_full_track_review_track_card_scope_mismatch');
  assertIssue(result.report, 'changed_full_track_review_track_box_scope_mismatch');
  assertIssue(result.report, 'changed_card_self_review_count_invalid');
});

test('full-track remediation aggregate cannot authorize a newly added card', () => {
  const repo = createRepository();
  const addedCard = {
    ...completeCard(),
    card_id: '000002',
    front: {text: 'new candidate prompt'},
  };
  writeCardBox(repo.root, [legacyCard(), addedCard]);
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001', '000002'],
    expectedCount: 2,
  });
  commit(repo.root, 'add card under full-track remediation aggregate');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_full_track_review_track_membership_changed');
  const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(coverageIssue.card_id, '000002');
  assert.equal(coverageIssue.review_count, 0);
});

test('full-track aggregate cannot claim the wrong track for covered HEAD cards', () => {
  const repo = createRepository();
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
    track: 'cet6',
  });
  commit(repo.root, 'claim CET4 card as CET6 full-track review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_full_track_review_track_card_scope_mismatch');
  assertIssue(result.report, 'changed_full_track_review_scope_track_mismatch');
});

test('full-track aggregate covers only the declared track in a mixed corpus', () => {
  const repo = createRepository();
  const cet6Card = {
    ...legacyCard(),
    card_id: '100001',
    track: 'cet6',
    knowledge_ref: {box_prefix: '1000'},
    front: {text: 'CET6 baseline prompt'},
  };
  writeCardBox(repo.root, [legacyCard(), cet6Card]);
  commit(repo.root, 'establish mixed CET4 and CET6 corpus');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  writeCardBox(repo.root, [completeCard(), cet6Card]);
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
    track: 'cet4',
    boxPrefixes: ['0000'],
  });
  commit(repo.root, 'review complete CET4 track only');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
});

test('full-track aggregate coverage cannot omit the changed card', () => {
  const repo = createRepository();
  const unchangedCard = {
    ...legacyCard(),
    card_id: '000002',
    front: {text: 'second baseline prompt'},
  };
  writeCardBox(repo.root, [legacyCard(), unchangedCard]);
  commit(repo.root, 'establish two-card corpus');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  writeCardBox(repo.root, [completeCard(), unchangedCard]);
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000002'],
  });
  commit(repo.root, 'omit changed card from full-track coverage');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  const issue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(issue.card_id, '000001');
  assert.equal(issue.review_count, 0);
});

test('full-track aggregate scope and reviewed coverage must be identical', () => {
  const repo = createRepository();
  const secondCard = {
    ...legacyCard(),
    card_id: '000002',
    front: {text: 'second baseline prompt'},
  };
  writeCardBox(repo.root, [legacyCard(), secondCard]);
  commit(repo.root, 'establish two-card corpus');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
    reviewedCardIds: ['000002'],
  });
  commit(repo.root, 'mismatch full-track scope and coverage');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_full_track_review_scope_coverage_mismatch');
});

test('full-track aggregate rejects duplicate and unknown coverage identities', async t => {
  await t.test('duplicate ids', () => {
    const repo = createRepository();
    writeFullTrackReview(repo.root, {
      scopeCardIds: ['000001', '000001'],
      reviewedCardIds: ['000001', '000001'],
      expectedCount: 1,
    });
    commit(repo.root, 'duplicate full-track identities');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_scope_card_ids_duplicate');
    assertIssue(result.report, 'changed_full_track_review_coverage_card_ids_duplicate');
  });

  await t.test('unknown HEAD id', () => {
    const repo = createRepository();
    writeFullTrackReview(repo.root, {
      scopeCardIds: ['999999'],
    });
    commit(repo.root, 'use unknown full-track identity');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_scope_card_missing_from_head_corpus');
  });
});

test('full-track aggregate rejects an attached cards snapshot payload', () => {
  const repo = createRepository();
  const card = completeCard();
  writeFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
    cards: [reviewEntry(card)],
  });
  commit(repo.root, 'attach cards payload to full-track aggregate');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_full_track_review_cards_forbidden');
});

test('a non-full-track self-review still requires cards snapshots', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/agent_self_review/ordinary-review.json'),
    {
      review_id: 'ordinary-review',
      scope: {box_prefixes: ['0000'], card_ids: ['000001']},
      sample_policy: {review_scope_type: 'three_card_sample_per_box'},
    },
  );
  commit(repo.root, 'omit ordinary cards snapshots');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_cards_missing');
});

test('a changed elimination card cannot keep stale mirror and answer truth', () => {
  const repo = createRepository();
  const card = {
    ...completeCard(),
    interaction_id: 'elimination',
    elimination_items: [
      { id: 'evidence', text: '有效证据' },
      { id: 'distractor', text: '干扰信息' },
    ],
    eliminable_items: [
      { text: '过期证据', is_correct: true },
      { text: '干扰信息', is_correct: false },
    ],
    answer_key: { correct_items: ['stale_id'] },
  };
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review.json', ['000001'], [reviewEntry(card)]);
  commit(repo.root, 'introduce stale elimination truth');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  const eliminationIssues = result.report.issues.filter(
    issue => issue.code === 'changed_card_elimination_integrity_invalid',
  );
  assert.ok(eliminationIssues.length > 0);
  assert.ok(eliminationIssues.some(issue => issue.library_code === 'elimination_legacy_mirror_mismatch'));
  assert.ok(eliminationIssues.some(
    issue => issue.library_code === 'elimination_correct_items_truth_mismatch',
  ));
});

test('a changed card must have exactly one changed self-review entry', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review-a.json', ['000001'], [reviewEntry(card)]);
  writeSelfReview(repo.root, 'review-b.json', ['000001'], [reviewEntry(card)]);
  commit(repo.root, 'duplicate changed card review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  const issue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(issue.review_count, 2);
});

test('a changed self-review cannot name a card missing from the HEAD corpus', () => {
  const repo = createRepository();
  const absentCard = { ...completeCard(), card_id: '999999' };
  writeSelfReview(repo.root, 'review.json', ['999999'], [reviewEntry(absentCard)]);
  commit(repo.root, 'review missing corpus card');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_card_missing_from_head_corpus');
  assertIssue(result.report, 'changed_self_review_scope_card_missing_from_head_corpus');
});

test('rename and modify audit materializes the complete HEAD corpus for an R diff', () => {
  const repo = createRepository();
  const {card, reviewPath} = establishCompleteCandidateBase(repo);
  const oldPath = 'card_boxes_json/card_boxes_seed_cet4_listening_0000.json';
  const newPath = 'card_boxes_json/card_boxes_seed_cet4_listening_alt_0000.json';
  installHeadSnapshotAuditStub(repo.root);
  git(repo.root, 'mv', oldPath, newPath);
  writeJson(path.join(repo.root, newPath), {
    cards: [{
      ...card,
      analysis: {text: 'HEAD 中对同一卡片做了小幅修改。'},
    }],
  });
  changeReviewId(reviewPath, 'rename-modify-r');
  commit(repo.root, 'rename and modify candidate card box');

  const nameStatus = git(
    repo.root,
    'diff',
    '--name-status',
    '--find-renames',
    `${repo.base}...HEAD`,
    '--',
    'card_boxes_json',
  );
  assert.match(nameStatus, /^R\d+\t/m);

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.current_scoped_audit.ok, true);
});

test('rename and modify audit materializes the complete HEAD corpus for a D/A diff', () => {
  const repo = createRepository();
  const {card, reviewPath} = establishCompleteCandidateBase(repo);
  const oldPath = 'card_boxes_json/card_boxes_seed_cet4_listening_0000.json';
  const newPath = 'card_boxes_json/card_boxes_seed_cet4_listening_alt_0000.json';
  installHeadSnapshotAuditStub(repo.root);
  fs.rmSync(path.join(repo.root, oldPath));
  writeCompactJson(path.join(repo.root, newPath), {
    cards: [{
      ...card,
      analysis: {text: 'HEAD 中以完全不同的文件布局保存同一卡片。'},
    }],
  });
  changeReviewId(reviewPath, 'rename-modify-delete-add');
  commit(repo.root, 'delete and add modified candidate card box');

  const nameStatus = git(
    repo.root,
    'diff',
    '--name-status',
    '--find-renames',
    `${repo.base}...HEAD`,
    '--',
    'card_boxes_json',
  ).split('\n');
  assert.ok(nameStatus.some(line => line.startsWith(`D\t${oldPath}`)), nameStatus.join('\n'));
  assert.ok(nameStatus.some(line => line.startsWith(`A\t${newPath}`)), nameStatus.join('\n'));

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.current_scoped_audit.ok, true);
});

test('worktree-only content validation fails closed without an explicit head commit', () => {
  const repo = createRepository();
  writeCardBox(repo.root, [{...legacyCard(), front: {text: 'uncommitted drift'}}]);

  const result = validateWorktree(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'content_candidate_explicit_head_required');
});

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-make-pr-scope-test-'));
  TEMP_ROOTS.add(root);
  for (const directory of [
    'scripts/lib',
    'spec',
    'card_boxes_json',
    'reviews/agent_self_review',
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }

  for (const relativePath of [
    'scripts/validate_pr_scope.mjs',
    'scripts/validate_cards.mjs',
    'scripts/lib/card_integrity.mjs',
    'spec/card-metadata.schema.json',
    'spec/content-quality-contract.json',
  ]) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  fs.writeFileSync(path.join(root, 'scripts/audit_card_quality.mjs'), AUDIT_STUB);
  writeJson(path.join(root, 'spec/card-quality-audit.json'), {});
  writeCardBox(root, [legacyCard()]);

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'pr-scope-test@example.invalid');
  git(root, 'config', 'user.name', 'PR Scope Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  commit(root, 'baseline');

  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function legacyCard() {
  return {
    card_id: '000001',
    track: 'cet4',
    knowledge_ref: { box_prefix: '0000' },
    interaction_id: 'flip',
    front: { text: 'baseline prompt' },
    analysis: {text: 'baseline analysis'},
    source_ref: {type: 'human_original', provenance_status: 'documented'},
  };
}

function completeCard() {
  return {
    ...legacyCard(),
    front: { text: 'changed prompt' },
    quality_metadata: {
      main_training_goal: '训练识别题目中的核心考点',
      weak_point_tags: ['exam_strategy_weak'],
      difficulty: { primary: 'pass', secondary: ['high_score'] },
      card_prototype: 'solving_action',
      material: {
        text_source_type: 'human_original',
        source_note: 'Integration-test fixture.',
        audio_generation_method: 'none',
      },
      exam_value: '帮助考生在考试中更快定位核心证据。',
      box_progression_role: 'application',
      review_status: 'draft',
    },
  };
}

function reviewEntry(card) {
  return {
    card_id: card.card_id,
    interaction_id: card.interaction_id,
    knowledge_ref: card.knowledge_ref,
    status: 'pass',
    quality_metadata: {
      ...structuredClone(card.quality_metadata),
      review_status: 'agent_pass',
    },
  };
}

function writeCardBox(root, cards) {
  writeJson(
    path.join(root, 'card_boxes_json/card_boxes_seed_cet4_listening_0000.json'),
    { cards },
  );
}

function writeSelfReview(root, suffix, cardIds, cards) {
  return writeSelfReviewFile(
    root,
    `20260731-cet4-listening-0000-${suffix}`,
    cardIds,
    cards,
  );
}

function writeSelfReviewFile(root, filename, cardIds, cards) {
  const filePath = path.join(root, 'reviews/agent_self_review', filename);
  writeJson(
    filePath,
    {
      review_id: filename,
      scope: { box_prefixes: ['0000'], card_ids: cardIds },
      cards,
    },
  );
  return filePath;
}

function writeFullTrackReview(root, {
  scopeCardIds,
  reviewedCardIds = scopeCardIds,
  expectedCount = new Set(scopeCardIds).size,
  track = 'cet4',
  boxPrefixes = ['0000'],
  coverageBoxPrefixes = boxPrefixes,
  cards,
}) {
  const filePath = path.join(
    root,
    'reviews/agent_self_review/20260731-cet4-full-track-remediation.json',
  );
  const record = {
    review_id: '20260731-cet4-full-track-remediation',
    created_at: '2026-07-31T12:00:00+08:00',
    agent: 'codex',
    scope: {
      track,
      box_prefixes: boxPrefixes,
      card_ids: scopeCardIds,
    },
    specs_read: ['spec/review-workflow.json'],
    sample_policy: {
      review_scope_type: 'full_track_remediation',
      is_three_card_sample_per_box: false,
      full_track_remediation: true,
      batch_generation_requires_user_confirmation: true,
      final_user_approval_required: true,
    },
    coverage: {
      expected_card_count: expectedCount,
      reviewed_card_ids: reviewedCardIds,
      human_reviewer: 'fixture-reviewer',
      boxes: coverageBoxPrefixes.map(boxPrefix => ({
        box_prefix: boxPrefix,
        status: 'pass',
        reviewer: 'fixture-reviewer',
      })),
    },
    quality_audit: {
      report: 'reports/card_quality_audit_report.json',
      corpus_fingerprint: 'fixture-fingerprint',
      scope_has_no_hard_blockers: true,
    },
    representative_cards: scopeCardIds.slice(0, 1),
    batch_review: {
      status: 'ready_for_full_track_user_approval',
      summary: 'Fixture aggregate review.',
      remaining_risks: [],
      next_step: 'Request user approval.',
    },
  };
  if (cards !== undefined) record.cards = cards;
  writeJson(filePath, record);
  return filePath;
}

function establishCompleteCandidateBase(repo) {
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReview(
    repo.root,
    'head-snapshot-review.json',
    ['000001'],
    [reviewEntry(card)],
  );
  commit(repo.root, 'establish complete governed candidate');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  return {card, reviewPath};
}

function changeReviewId(reviewPath, reviewId) {
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.review_id = reviewId;
  writeJson(reviewPath, review);
}

function installHeadSnapshotAuditStub(root) {
  fs.writeFileSync(
    path.join(root, 'scripts/audit_card_quality.mjs'),
    HEAD_SNAPSHOT_AUDIT_STUB,
  );
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCompactJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function commit(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', message);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function validate(repo) {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate_pr_scope.mjs', '--base', repo.base, '--head', 'HEAD'],
    { cwd: repo.root, encoding: 'utf8' },
  );
  const output = result.stdout.trim() || result.stderr.trim();
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(output),
  };
}

function validateWorktree(repo) {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate_pr_scope.mjs', '--base', repo.base],
    {cwd: repo.root, encoding: 'utf8'},
  );
  const output = result.stdout.trim() || result.stderr.trim();
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(output),
  };
}

function validateCards(repo) {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate_cards.mjs'],
    {cwd: repo.root, encoding: 'utf8'},
  );
  const output = result.stdout.trim() || result.stderr.trim();
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(output),
  };
}

function assertIssue(report, code) {
  const issue = report.issues.find(candidate => candidate.code === code);
  assert.ok(issue, `expected ${code}; received ${JSON.stringify(report.issues, null, 2)}`);
  return issue;
}

const AUDIT_STUB = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const reportIndex = process.argv.indexOf('--write-scope-report');
const reportPath = process.argv[reportIndex + 1];
const report = {
  scope_summary: { by_severity: { hard_blocker: 0 } },
  scoped_hard_blocker_issues: [],
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report));
console.log(JSON.stringify(report));
`;

const HEAD_SNAPSHOT_AUDIT_STUB = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const reportIndex = process.argv.indexOf('--write-scope-report');
const reportPath = process.argv[reportIndex + 1];
const oldPath = path.join(
  process.cwd(),
  'card_boxes_json/card_boxes_seed_cet4_listening_0000.json',
);
const newPath = path.join(
  process.cwd(),
  'card_boxes_json/card_boxes_seed_cet4_listening_alt_0000.json',
);
const invalidHeadSnapshot = fs.existsSync(oldPath) || !fs.existsSync(newPath);
const report = {
  scope_summary: {
    by_severity: {hard_blocker: invalidHeadSnapshot ? 1 : 0},
  },
  scoped_hard_blocker_issues: invalidHeadSnapshot
    ? [{code: 'stale_base_card_box_visible_in_current_audit'}]
    : [],
};
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, JSON.stringify(report));
console.log(JSON.stringify(report));
`;
