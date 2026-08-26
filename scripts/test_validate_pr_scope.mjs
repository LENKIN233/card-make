#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildContentAuthorizationAdditionalBindings,
  buildModelAcceptanceInputSha256,
  deriveRuntimePayloadContentIdentity,
} from './lib/model_acceptance.mjs';
import {validateFullTrackAggregateSemantics} from './validate_pr_scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOTS = new Set();

test.after(() => {
  for (const root of TEMP_ROOTS) fs.rmSync(root, { force: true, recursive: true });
});

test('model-owned full-track semantic review cannot omit reference or representative evidence', () => {
  const cardIds = new Set(['000001']);
  const boxPrefixes = new Set(['0000']);
  const record = {
    schema_version: 'model-owned-full-track-review.v2',
    model_acceptances: [],
    scope: {track: 'cet4', box_prefixes: ['0000'], card_ids: ['000001']},
    specs_read: ['spec/review-workflow.json'],
    coverage: {
      expected_card_count: 1,
      reviewed_card_ids: ['000001'],
      human_reviewer: 'external:legacy-person-authority',
      boxes: [{box_prefix: '0000', status: 'pass'}],
    },
    quality_audit: {
      report: 'reviews/audit_scopes/fixture.json',
      report_sha256: null,
      corpus_fingerprint: 'f'.repeat(64),
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(['000001']),
    },
    representative_cards: [],
    removed_cards: [],
    batch_review: {
      status: 'ready_for_model_authorization',
      summary: 'Fixture summary.',
      remaining_risks: [],
      next_step: 'Create authorization.',
    },
  };
  const issues = validateFullTrackAggregateSemantics({
    record,
    filePath: 'reviews/agent_self_review/full-track.json',
    scopeCardIds: cardIds,
    scopeBoxPrefixes: boxPrefixes,
    head: null,
  });
  assertIssue({issues}, 'changed_full_track_review_analysis_reference_check_invalid');
  assertIssue({issues}, 'changed_full_track_review_representative_cards_invalid');
  assertIssue({issues}, 'changed_model_review_person_authority_field_forbidden');
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
  assertIssue(result.report, 'changed_candidate_card_deleted_without_model_acceptance');
});

test('a governed model-owned destructive decision permits the exact bound removal', () => {
  const repo = createRepository();
  const removedCard = legacyCard();
  const remainingCard = {
    ...completeCard(),
    card_id: '000002',
    front: {text: 'remaining governed prompt'},
  };
  writeCardBox(repo.root, [removedCard, remainingCard]);
  commit(repo.root, 'establish two-card removal base');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  const baseCardSha256 = testCardObjectSha256(removedCard);
  writeCardBox(repo.root, [remainingCard]);
  const auditPath = 'reviews/audit_scopes/model-removal-scope-audit.json';
  writeJson(path.join(repo.root, auditPath), fixtureScopedAuditReport(['000002']));
  const auditSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, auditPath)))
    .digest('hex')}`;
  const reviewScope = {
    track: 'cet4',
    box_prefixes: ['0000'],
    card_ids: ['000002'],
  };
  writeJson(
    path.join(repo.root, 'reviews/agent_self_review/model-removal.json'),
    {
      schema_version: 'model-owned-card-review.v2',
      review_id: 'model-removal',
      created_at: '2026-08-23T12:00:00+08:00',
      model_acceptance: testModelAcceptance(
        buildModelAcceptanceInputSha256({
          decisionType: 'card_review',
          scope: reviewScope,
          corpusFingerprint: 'f'.repeat(64),
          auditSha256,
        }),
        ['card_semantic_review', 'source_provenance_review'],
        'codex-task:removal-review',
      ),
      scope: reviewScope,
      specs_read: ['spec/review-workflow.json'],
      quality_audit: {
        report: auditPath,
        report_sha256: auditSha256,
        corpus_fingerprint: 'f'.repeat(64),
        scope_has_no_hard_blockers: true,
        scope_summary: qualityAuditSummary(['000002']),
      },
      cards: [reviewEntry(remainingCard)],
      removed_cards: [{
        card_id: removedCard.card_id,
        base_card_sha256: baseCardSha256,
        reason: 'Remove an obsolete duplicate from the current corpus.',
        reference_scan: {
          status: 'pass',
          scanned_commit: 'HEAD',
          scanned_surface: 'card_boxes_json',
          dangling_current_references: [],
        },
        coverage_after_removal: {
          status: 'pass',
          track: 'cet4',
          box_prefix: '0000',
          base_box_card_count: 2,
          head_box_card_count: 1,
          box_remains_nonempty: true,
        },
        model_acceptance: testModelAcceptance(
          baseCardSha256,
          ['destructive_change_review'],
          'codex-task:removal-decision',
        ),
      }],
      batch_review: {
        status: 'model_accepted',
        box_progression: 'The remaining corpus preserves the governed sequence.',
        repetition_or_gap_risks: [],
        representative_cards: ['000002'],
        next_step: 'Merge after exact-head gates pass.',
      },
    },
  );
  commit(repo.root, 'remove card with model-owned evidence');
  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.ok, true);
  const removalReviewPath = path.join(
    repo.root,
    'reviews/agent_self_review/model-removal.json',
  );
  const forged = readJson(removalReviewPath);
  forged.removed_cards[0].coverage_after_removal.head_box_card_count = 99;
  writeJson(removalReviewPath, forged);
  commit(repo.root, 'forge removal coverage claim');
  const forgedResult = validate(repo);
  assert.notEqual(forgedResult.status, 0, forgedResult.stdout);
  assertIssue(forgedResult.report, 'changed_card_removal_coverage_invalid');
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
  assertIssue(result.report, 'changed_candidate_card_deleted_without_model_acceptance');
});

test('a changed card with complete matching changed self-review passes', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeModelOwnedSelfReview(repo.root, 'review.json', [card]);
  commit(repo.root, 'change card with matching review');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
});

test('scoped audit worktrees retain LFS pointers without running media smudge', () => {
  const repo = createRepository();
  const mediaPath = path.join(repo.root, 'media/probe.bin');
  fs.mkdirSync(path.dirname(mediaPath), {recursive: true});
  fs.writeFileSync(
    path.join(repo.root, '.gitattributes'),
    '*.bin filter=lfs diff=lfs merge=lfs -text\n',
  );
  fs.writeFileSync(
    mediaPath,
    'version https://git-lfs.github.com/spec/v1\n' +
      `oid sha256:${'a'.repeat(64)}\n` +
      'size 1\n',
  );
  git(repo.root, 'config', 'filter.lfs.clean', 'cat');
  git(
    repo.root,
    'config',
    'filter.lfs.smudge',
    'sh -c \'test "$GIT_LFS_SKIP_SMUDGE" = 1 && cat\'',
  );
  git(repo.root, 'config', 'filter.lfs.required', 'true');
  commit(repo.root, 'establish pointer-only media fixture');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeModelOwnedSelfReview(repo.root, 'lfs-pointer-review.json', [card]);
  commit(repo.root, 'change card with pointer-only audit replay');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.current_scoped_audit.ok, true);
});

test('a changed self-review must explicitly confirm answer and analysis references', () => {
  const repo = createRepository();
  const card = completeCard();
  const review = reviewEntry(card);
  review.analysis_reference_check.distractor_labels_match_explanations = false;
  writeCardBox(repo.root, [card]);
  writeSelfReview(repo.root, 'review.json', ['000001'], [review]);
  commit(repo.root, 'omit semantic reference confirmation');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_analysis_reference_check_invalid');
  const coverageIssue = assertIssue(
    result.report,
    'changed_card_self_review_count_invalid',
  );
  assert.equal(coverageIssue.review_count, 0);
});

test('legacy three-card standard samples cannot authorize current changed candidates', () => {
  const repo = createRepository();
  const cards = [
    completeCard(),
    {
      ...completeCard(),
      card_id: '000002',
      front: {text: 'second changed prompt'},
    },
    {
      ...completeCard(),
      card_id: '000003',
      front: {text: 'third changed prompt'},
    },
  ];
  writeCardBox(repo.root, cards);
  writeSelfReview(
    repo.root,
    'standard-sample.json',
    cards.map(card => card.card_id),
    cards.map(reviewEntry),
    {reviewScopeType: 'three_card_sample_per_box'},
  );
  commit(repo.root, 'add complete three-card standard sample');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(
    result.report,
    'changed_self_review_legacy_person_authority_archive_only',
  );
});

test('legacy confirmed box expansion cannot authorize current changed cards', async t => {
  for (const targetCardCount of [12, 8, 6]) {
    await t.test(`target ${targetCardCount}`, () => {
      const {repo, expansionCards} = prepareConfirmedExpansion(targetCardCount);
      commit(repo.root, `expand confirmed sample to ${targetCardCount}`);
      const result = validate(repo);
      assert.notEqual(result.status, 0, result.stdout);
      assertIssue(
        result.report,
        'changed_self_review_legacy_person_authority_archive_only',
      );
    });
  }
});

test('confirmed box expansion fails closed without its confirmation record', () => {
  const {repo, confirmationPath} = prepareConfirmedExpansion(8);
  fs.rmSync(confirmationPath);
  commit(repo.root, 'try expansion without confirmation evidence');
  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_confirmed_expansion_confirmation_missing');
});

test('confirmed box expansion cannot stop short of or exceed its recorded target', () => {
  const {repo, expansionCards, reviewPath} = prepareConfirmedExpansion(8);
  const cards = readJson(reviewPath).cards.slice(0, -1);
  writeCardBox(repo.root, [
    legacyCard(),
    {...legacyCard(), card_id: '000002', front: {text: 'second sample prompt'}},
    {...legacyCard(), card_id: '000003', front: {text: 'third sample prompt'}},
    ...expansionCards.slice(0, -1),
  ]);
  const review = readJson(reviewPath);
  review.cards = cards;
  review.scope.card_ids = cards.map(card => card.card_id);
  review.batch_review.representative_cards = [cards[0].card_id];
  writeJson(reviewPath, review);
  writeJson(path.join(repo.root, review.quality_audit.report), fixtureScopedAuditReport(review.scope.card_ids));
  commit(repo.root, 'try partial confirmed expansion');
  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_legacy_person_authority_archive_only');
});

test('confirmed box expansion cannot cross into an unconfirmed second box', () => {
  const {repo, reviewPath} = prepareConfirmedExpansion(8);
  const review = readJson(reviewPath);
  review.scope.box_prefixes = ['0000', '0010'];
  writeJson(reviewPath, review);
  commit(repo.root, 'try cross-box confirmed expansion');
  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_confirmed_expansion_single_box_required');
});

test('sample confirmation cannot claim release-gate eligibility', () => {
  const {repo, confirmationPath} = prepareConfirmedExpansion(6);
  const confirmation = readJson(confirmationPath);
  confirmation.gate_eligible = true;
  writeJson(confirmationPath, confirmation);
  commit(repo.root, 'try gate-eligible sample confirmation');
  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_sample_confirmation_formal_boundary_invalid');
});

test('a changed standard sample must use current scoped audit evidence', () => {
  const repo = createRepository();
  const cards = [
    completeCard(),
    {...completeCard(), card_id: '000002', front: {text: 'second changed prompt'}},
    {...completeCard(), card_id: '000003', front: {text: 'third changed prompt'}},
  ];
  writeCardBox(repo.root, cards);
  const reviewPath = writeSelfReview(
    repo.root,
    'global-audit-standard-sample.json',
    cards.map(card => card.card_id),
    cards.map(reviewEntry),
    {reviewScopeType: 'three_card_sample_per_box'},
  );
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  review.quality_audit.report = 'reports/card_quality_audit_report.json';
  writeJson(reviewPath, review);
  commit(repo.root, 'try archived global audit for current standard sample');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_standard_scoped_audit_required');
  for (const card of cards) {
    const coverageIssue = result.report.issues.find(
      issue => issue.code === 'changed_card_self_review_count_invalid' &&
        issue.card_id === card.card_id,
    );
    assert.ok(coverageIssue, card.card_id);
    assert.equal(coverageIssue.review_count, 0);
  }
});

test('a standard sample needs a complete batch-level review conclusion', async t => {
  const cases = [
    ['box_progression', 'changed_self_review_batch_box_progression_missing'],
    ['repetition_or_gap_risks', 'changed_self_review_batch_risks_invalid'],
    ['representative_cards', 'changed_self_review_batch_representative_cards_invalid'],
    ['next_step', 'changed_self_review_batch_next_step_missing'],
  ];
  for (const [field, issueCode] of cases) {
    await t.test(`missing ${field}`, () => {
      const repo = createRepository();
      const cards = [
        completeCard(),
        {...completeCard(), card_id: '000002', front: {text: 'second changed prompt'}},
        {...completeCard(), card_id: '000003', front: {text: 'third changed prompt'}},
      ];
      writeCardBox(repo.root, cards);
      const reviewPath = writeSelfReview(
        repo.root,
        `missing-${field}-standard-sample.json`,
        cards.map(card => card.card_id),
        cards.map(reviewEntry),
        {reviewScopeType: 'three_card_sample_per_box'},
      );
      const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      delete review.batch_review[field];
      writeJson(reviewPath, review);
      commit(repo.root, `omit standard batch ${field}`);

      const result = validate(repo);
      assert.notEqual(result.status, 0, result.stdout);
      assertIssue(result.report, issueCode);
      const coverageIssue = result.report.issues.find(
        issue => issue.code === 'changed_card_self_review_count_invalid',
      );
      assert.ok(coverageIssue);
      assert.equal(coverageIssue.review_count, 0);
    });
  }
});

test('the pre-cutover report index is immutable even outside a content diff', () => {
  const repo = createRepository();
  writeJson(path.join(repo.root, 'reports/pre-cutover-report-index.json'), {
    schema_version: 'pre-cutover-report-index.v1',
    legacy_references: [],
  });
  commit(repo.root, 'try to extend pre-cutover archive index');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, false);
  assertIssue(result.report, 'pre_cutover_report_index_immutable');
});

test('invalid standard sample shape cannot count as changed-card coverage', async t => {
  await t.test('not three cards per box', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    writeSelfReview(
      repo.root,
      'short-standard-sample.json',
      ['000001'],
      [reviewEntry(card)],
      {reviewScopeType: 'three_card_sample_per_box'},
    );
    commit(repo.root, 'add short standard sample');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_sample_card_count_invalid');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });

  await t.test('invalid card status', () => {
    const repo = createRepository();
    const cards = [
      completeCard(),
      {...completeCard(), card_id: '000002', front: {text: 'second prompt'}},
      {...completeCard(), card_id: '000003', front: {text: 'third prompt'}},
    ];
    const reviews = cards.map(reviewEntry);
    reviews[0].status = 'approved';
    writeCardBox(repo.root, cards);
    writeSelfReview(
      repo.root,
      'invalid-status-standard-sample.json',
      cards.map(card => card.card_id),
      reviews,
      {reviewScopeType: 'three_card_sample_per_box'},
    );
    commit(repo.root, 'add invalid standard review status');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_card_status_invalid');
    for (const cardId of cards.map(card => card.card_id)) {
      const coverageIssue = result.report.issues.find(
        issue => issue.code === 'changed_card_self_review_count_invalid' &&
          issue.card_id === cardId,
      );
      assert.ok(coverageIssue, cardId);
      assert.equal(coverageIssue.review_count, 0);
    }
  });

  await t.test('six snapshots cannot all come from one of two declared boxes', () => {
    const repo = createRepository();
    const cards = Array.from({length: 6}, (_, index) => ({
      ...completeCard(),
      card_id: String(index + 1).padStart(6, '0'),
      front: {text: `changed prompt ${index + 1}`},
    }));
    writeCardBox(repo.root, cards);
    writeSelfReview(
      repo.root,
      'imbalanced-two-box-standard-sample.json',
      cards.map(card => card.card_id),
      cards.map(reviewEntry),
      {
        reviewScopeType: 'three_card_sample_per_box',
        boxPrefixes: ['0000', '9999'],
      },
    );
    commit(repo.root, 'add imbalanced two-box standard sample');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    const counts = result.report.issues.filter(
      issue => issue.code === 'changed_self_review_per_box_card_count_invalid',
    );
    assert.deepEqual(
      counts.map(issue => [issue.box_prefix, issue.actual]).sort(),
      [['0000', 6], ['9999', 0]],
    );
  });

  await t.test('snapshot box identity must match the immutable HEAD card', () => {
    const repo = createRepository();
    const cards = Array.from({length: 6}, (_, index) => ({
      ...completeCard(),
      card_id: String(index + 1).padStart(6, '0'),
      knowledge_ref: {box_prefix: index < 3 ? '0000' : '9999'},
      front: {text: `two-box changed prompt ${index + 1}`},
    }));
    const reviews = cards.map(reviewEntry);
    reviews[0].knowledge_ref = {box_prefix: '9999'};
    reviews[3].knowledge_ref = {box_prefix: '0000'};
    writeCardBox(repo.root, cards);
    writeSelfReview(
      repo.root,
      'falsified-box-standard-sample.json',
      cards.map(card => card.card_id),
      reviews,
      {
        reviewScopeType: 'three_card_sample_per_box',
        boxPrefixes: ['0000', '9999'],
      },
    );
    commit(repo.root, 'add falsified snapshot box identities');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    const mismatches = result.report.issues.filter(
      issue => issue.code === 'changed_self_review_card_knowledge_ref_mismatch',
    );
    assert.deepEqual(mismatches.map(issue => issue.card_id).sort(), ['000001', '000004']);
  });
});

test('a newly added card cannot use residual-closure evidence as generation approval', () => {
  const repo = createRepository();
  const addedCard = {
    ...completeCard(),
    card_id: '000002',
    front: {text: 'new card cannot be disguised as residual closure'},
  };
  writeCardBox(repo.root, [legacyCard(), addedCard]);
  writeSelfReview(
    repo.root,
    'added-card-residual.json',
    ['000002'],
    [reviewEntry(addedCard)],
  );
  commit(repo.root, 'add card under residual closure evidence');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_legacy_person_authority_archive_only');
  const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(coverageIssue.card_id, '000002');
  assert.equal(coverageIssue.review_count, 0);
  assert.equal(coverageIssue.ineligible_review_count, 0);
});

test('changed residual closure evidence requires its explicit type and scoped audit', async t => {
  await t.test('missing explicit review scope type', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    const reviewPath = writeSelfReview(
      repo.root,
      'inferred-residual.json',
      ['000001'],
      [reviewEntry(card)],
    );
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    delete review.sample_policy.review_scope_type;
    writeJson(reviewPath, review);
    commit(repo.root, 'omit residual review scope type');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_scope_type_required');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });

  await t.test('global audit instead of scoped audit', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    const reviewPath = writeSelfReview(
      repo.root,
      'global-audit-residual.json',
      ['000001'],
      [reviewEntry(card)],
    );
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    review.quality_audit.report = 'reports/card_quality_audit_report.json';
    writeJson(reviewPath, review);
    commit(repo.root, 'use global audit for residual closure');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_residual_scoped_audit_required');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });
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
  const reviewPath = writeModelOwnedSelfReview(repo.root, 'review.json', [card]);
  const record = readJson(reviewPath);
  record.cards = [review];
  writeJson(reviewPath, record);
  commit(repo.root, 'mismatch review metadata');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_card_self_review_metadata_mismatch');
});

test('self-review-only metadata drift is compared with the unchanged HEAD corpus', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeModelOwnedSelfReview(repo.root, 'review.json', [card]);
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
  const reviewPath = writeModelOwnedSelfReview(
    repo.root,
    '20260731-cet4-full-track-remediation.json',
    [card],
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

test('an unprefixed draft JSON change enters content scope', () => {
  const repo = createRepository();
  const relativePath = 'reviews/drafts/full-track-remediation.json';
  writeJson(path.join(repo.root, relativePath), {
    scope: {card_ids: ['000001']},
  });
  commit(repo.root, `add ${relativePath}`);

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
});

test('an empty unlinked scoped-audit artifact is rejected', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/audit_scopes/9999-forged.json'),
    {},
  );
  commit(repo.root, 'add empty unlinked scoped audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_scoped_audit_invalid');
});

test('a structurally plausible unlinked scoped audit must match current replay', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/audit_scopes/9999-forged.json'),
    {
      ok: true,
      audit_version: 'card-make-quality-audit-v1',
      mode: 'read_only_non_blocking_for_legacy_corpus',
      report_type: 'scoped_card_quality_audit',
      corpus_fingerprint: {
        algorithm: 'sha256',
        card_dir: 'card_boxes_json',
        file_count: 1,
        card_count: 1,
        digest: '0'.repeat(64),
      },
      scope: {
        card_dir: 'card_boxes_json',
        card_ids: ['000001'],
        missing_card_ids: [],
      },
      scope_summary: qualityAuditSummary(['000001']),
      scoped_card_issue_index: {},
      scoped_hard_blocker_issues: [],
    },
  );
  commit(repo.root, 'add plausible but forged unlinked scoped audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_scoped_audit_replay_mismatch');
});

test('a changed approval cannot link the archived global audit', () => {
  const repo = createRepository();
  establishApprovalReviewBase(repo);
  writeApprovalFile(repo.root, 'global-audit-approval.json', {
    report: 'reports/card_quality_audit_report.json',
  });
  commit(repo.root, 'add approval linked to archived global audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_legacy_archive_only');
});

test('a legacy approval remains archive-only even with an exact current scoped-audit replay', () => {
  const repo = createRepository();
  establishApprovalReviewBase(repo);
  writeApprovalFile(repo.root, 'current-scoped-audit-approval.json');
  commit(repo.root, 'add approval with current scoped audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_legacy_archive_only');
});

test('a model-owned authorization passes with canonical scope, audit, and linked-review hashes', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const auditPath = 'reviews/audit_scopes/model-authorization-audit.json';
  writeJson(path.join(repo.root, auditPath), fixtureScopedAuditReport(['000001']));
  const auditSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, auditPath)))
    .digest('hex')}`;
  const reviewPath = 'reviews/agent_self_review/model-authorization-review.json';
  const reviewScope = {
    track: 'cet4',
    library: 'fixture-library',
    group: 'fixture-group',
    box: 'fixture-box',
    box_prefixes: ['0000'],
    card_ids: ['000001'],
  };
  writeJson(path.join(repo.root, reviewPath), {
    schema_version: 'model-owned-card-review.v2',
    review_id: 'model-authorization-review',
    created_at: '2026-08-23T12:00:00+08:00',
    model_acceptance: testModelAcceptance(
      buildModelAcceptanceInputSha256({
        decisionType: 'card_review',
        scope: reviewScope,
        corpusFingerprint: 'f'.repeat(64),
        auditSha256,
      }),
      ['card_semantic_review', 'source_provenance_review'],
      'model-review-run',
    ),
    scope: reviewScope,
    specs_read: ['spec/review-workflow.json'],
    quality_audit: {
      report: auditPath,
      report_sha256: auditSha256,
      corpus_fingerprint: 'f'.repeat(64),
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(['000001']),
    },
    cards: [reviewEntry(card)],
    removed_cards: [],
    batch_review: {
      status: 'model_accepted',
      box_progression: 'fixture progression',
      repetition_or_gap_risks: [],
      representative_cards: ['000001'],
      next_step: 'create authorization',
    },
  });
  commit(repo.root, 'establish model review and audit');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  const reviewSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, reviewPath)))
    .digest('hex')}`;
  const authorizationScope = {
    track: 'cet4',
    purpose: 'formal_content',
    box_prefixes: ['0000'],
    card_ids: ['000001'],
  };
  writeJson(
    path.join(repo.root, 'reviews/approved_batches/model-authorization.json'),
    {
      schema_version: 'model-owned-content-authorization.v2',
      authorization_id: 'model-authorization',
      authorized_at: '2026-08-23T12:30:00+08:00',
      model_acceptance: testModelAcceptance(
        buildModelAcceptanceInputSha256({
          decisionType: 'content_authorization',
          scope: authorizationScope,
          corpusFingerprint: 'f'.repeat(64),
          auditSha256,
          linkedReviewIdentity: {path: reviewPath, sha256: reviewSha256},
        }),
        ['content_authorization'],
        'authorization-run',
      ),
      scope: authorizationScope,
      summary: 'Exact model-owned authorization fixture.',
      representative_cards: ['000001'],
      card_quality_audit: {
        report: auditPath,
        report_sha256: auditSha256,
        corpus_fingerprint: 'f'.repeat(64),
        scope_has_no_hard_blockers: true,
        scope_summary: qualityAuditSummary(['000001']),
      },
      validation: {
        harness: 'pass',
        cards: 'pass',
        card_quality_audit: 'pass',
        model_review: reviewPath,
        model_review_sha256: reviewSha256,
      },
      authorization_limits: ['scope only', 'no external claims', 'new input requires review'],
    },
  );
  commit(repo.root, 'add model-owned authorization');
  let result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const authorizationPath = path.join(
    repo.root,
    'reviews/approved_batches/model-authorization.json',
  );
  const fullTrack = JSON.parse(fs.readFileSync(authorizationPath, 'utf8'));
  const runtimePayloadPath =
    'reviews/runtime_payloads/model-authorization-runtime.json';
  const runtimePayload = runtimePayloadForCards([card]);
  const contentVersionA =
    deriveRuntimePayloadContentIdentity(runtimePayload).content_version;
  runtimePayload.content_version = contentVersionA;
  writeJson(path.join(repo.root, runtimePayloadPath), runtimePayload);
  const runtimePayloadSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, runtimePayloadPath)))
    .digest('hex')}`;
  const contentVersionB = `sha256:${'e'.repeat(64)}`;
  const fullTrackInput = buildModelAcceptanceInputSha256({
    decisionType: 'full_track_content_authorization',
    scope: authorizationScope,
    corpusFingerprint: 'f'.repeat(64),
    auditSha256,
    linkedReviewIdentity: {path: reviewPath, sha256: reviewSha256},
    additionalBindings: buildContentAuthorizationAdditionalBindings({
      authorizationMode: 'full_track',
      contentVersion: contentVersionA,
    }),
  });
  fullTrack.authorization_mode = 'full_track';
  fullTrack.content_version = contentVersionA;
  fullTrack.validation.runtime_payload = runtimePayloadPath;
  fullTrack.validation.runtime_payload_sha256 = runtimePayloadSha256;
  fullTrack.model_acceptances = [
    testModelAcceptance(
      fullTrackInput,
      ['content_authorization'],
      'full-track-authorization-run-a',
    ),
    testModelAcceptance(
      fullTrackInput,
      ['content_authorization'],
      'full-track-authorization-run-b',
    ),
  ];
  delete fullTrack.model_acceptance;
  writeJson(authorizationPath, fullTrack);
  commit(repo.root, 'bind full-track authorization to runtime version');
  result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const runtimeShardPath =
    'reviews/runtime_payloads/model-authorization-runtime-001.json';
  const runtimeShard = {
    schema_version: 'card-make-runtime-card-shard.v1',
    track: 'cet4',
    card_records: runtimePayload.card_records,
  };
  writeJson(path.join(repo.root, runtimeShardPath), runtimeShard);
  const runtimeShardSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, runtimeShardPath)))
    .digest('hex')}`;
  writeJson(path.join(repo.root, runtimePayloadPath), {
    schema_version: 'card-make-runtime-payload-manifest.v1',
    source: runtimePayload.source,
    track: runtimePayload.track,
    content_version: contentVersionA,
    card_record_shards: [{
      path: runtimeShardPath,
      sha256: runtimeShardSha256,
      card_count: runtimeShard.card_records.length,
      first_card_id: runtimeShard.card_records[0].card_id,
      last_card_id: runtimeShard.card_records.at(-1).card_id,
    }],
    assets: [],
    release: null,
  });
  fullTrack.validation.runtime_payload_sha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repo.root, runtimePayloadPath)))
    .digest('hex')}`;
  writeJson(authorizationPath, fullTrack);
  commit(repo.root, 'replace direct runtime payload with a hash-bound shard manifest');
  result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  fullTrack.approved_by_user = true;
  writeJson(authorizationPath, fullTrack);
  commit(repo.root, 'attempt person-authority field injection');
  result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(
    result.report,
    'changed_model_authorization_person_authority_field_forbidden',
  );
  delete fullTrack.approved_by_user;

  fullTrack.content_version = contentVersionB;
  writeJson(authorizationPath, fullTrack);
  commit(repo.root, 'attempt cross-version authorization replay');
  result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_runtime_payload_identity_mismatch');
  assertIssue(result.report, 'changed_approval_model_input_mismatch');
});

test('formal approval evidence cannot be deleted', () => {
  const repo = createRepository();
  establishApprovalReviewBase(repo);
  const approvalPath = writeApprovalFile(
    repo.root,
    'immutable-approval-evidence.json',
  );
  commit(repo.root, 'establish formal approval evidence');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  fs.rmSync(approvalPath);
  commit(repo.root, 'delete formal approval evidence');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_deleted');
});

test('a changed approval cannot link review evidence outside the governed direct path', () => {
  const repo = createRepository();
  establishApprovalReviewBase(repo);
  writeJson(path.join(repo.root, 'misc/forged-review.json'), {
    scope: {
      box_prefixes: ['0000'],
      card_ids: ['000001'],
    },
    quality_audit: {
      report: 'reviews/audit_scopes/fixture-approval-review-scope-audit.json',
    },
  });
  writeApprovalFile(repo.root, 'forged-review-link-approval.json', {
    linkedReview: 'misc/forged-review.json',
  });
  commit(repo.root, 'link approval to review outside governed path');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_legacy_archive_only');
});

test('a changed approval cannot reuse an unchanged stale linked self-review audit', () => {
  const repo = createRepository();
  establishApprovalReviewBase(repo);
  const linkedReportPath = path.join(
    repo.root,
    'reviews/audit_scopes/fixture-approval-review-scope-audit.json',
  );
  const linkedReport = JSON.parse(fs.readFileSync(linkedReportPath, 'utf8'));
  linkedReport.forged_historical_claim = true;
  writeJson(linkedReportPath, linkedReport);
  commit(repo.root, 'establish stale linked review audit');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  writeApprovalFile(repo.root, 'stale-linked-review-approval.json');
  commit(repo.root, 'add approval reusing stale linked review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_approval_legacy_archive_only');
});

test('tracked scoped-audit evidence cannot be deleted', () => {
  const repo = createRepository();
  const auditPath = path.join(repo.root, 'reviews/audit_scopes/9999-history.json');
  writeJson(auditPath, {
    scope: {card_ids: ['000001']},
  });
  commit(repo.root, 'establish tracked scoped audit');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  fs.rmSync(auditPath);
  commit(repo.root, 'delete tracked scoped audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_scoped_audit_deleted_or_renamed');
});

test('review templates remain outside content-candidate scope', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/agent_self_review/FULL_TRACK_TEMPLATE.json'),
    {template: true},
  );
  writeJson(
    path.join(repo.root, 'reviews/controlled_pilot_reviews/TEMPLATE.json'),
    {template: true},
  );
  writeJson(
    path.join(repo.root, 'reviews/controlled_pilot_approvals/TEMPLATE.json'),
    {template: true},
  );
  commit(repo.root, 'add governed review templates');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.report.content_candidate_diff, false);
});

test('an unprefixed controlled-pilot aggregate review enters content scope and fails closed', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/controlled_pilot_reviews/pilot-review.json'),
    {schema_version: 'controlled-pilot-review.v1'},
  );
  commit(repo.root, 'add incomplete controlled-pilot review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_controlled_pilot_review_legacy_archive_only');
});

test('an orphan controlled-pilot approval artifact fails closed', () => {
  const repo = createRepository();
  writeJson(
    path.join(repo.root, 'reviews/controlled_pilot_approvals/orphan.json'),
    {schema_version: 'controlled-pilot-approval.v1'},
  );
  commit(repo.root, 'add orphan controlled-pilot approval');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.report.content_candidate_diff, true);
  assertIssue(result.report, 'changed_controlled_pilot_approval_legacy_archive_only');
});

test('a misleading TEMPLATE suffix cannot disguise an unprefixed self-review', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeModelOwnedSelfReview(
    repo.root,
    '20260731-REAL-NOT_A_TEMPLATE.json',
    [card],
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

test('model-owned full-track aggregate coverage can review a changed card without card snapshots', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeModelOwnedFullTrackReview(repo.root, {
    scopeCardIds: ['000001'],
  });
  commit(repo.root, 'change card under full-track aggregate review');

  const result = validate(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.report.changed_card_integrity.changed_card_ids, ['000001']);
  assert.deepEqual(
    result.report.changed_card_integrity.changed_full_track_review_paths,
    ['reviews/agent_self_review/20260823-model-owned-full-track-review.json'],
  );
});

test('full-track aggregate semantics fail closed before coverage can count', async t => {
  const cases = [
    {
      name: 'sample policy flag',
      mutate(record) {
        delete record.sample_policy.final_user_approval_required;
      },
      issue: 'changed_full_track_review_sample_policy_invalid',
    },
    {
      name: 'automation reviewer identity',
      mutate(record) {
        record.coverage.human_reviewer = 'external:codex-agent';
        record.coverage.boxes[0].reviewer = 'external:codex-agent';
      },
      issue: 'changed_full_track_review_human_reviewer_invalid',
    },
    {
      name: 'analysis reference check',
      mutate(record) {
        record.coverage.analysis_reference_check.answer_matches_card = false;
      },
      issue: 'changed_full_track_review_analysis_reference_check_invalid',
    },
    {
      name: 'per-box human pass',
      mutate(record) {
        record.coverage.boxes[0].status = 'pending';
      },
      issue: 'changed_full_track_review_box_human_pass_invalid',
    },
    {
      name: 'per-box reviewer mismatch',
      mutate(record) {
        record.coverage.boxes[0].reviewer = 'external:other-reviewer';
      },
      issue: 'changed_full_track_review_box_human_pass_invalid',
    },
    {
      name: 'quality audit',
      mutate(record) {
        delete record.quality_audit;
      },
      issue: 'changed_full_track_review_quality_audit_invalid',
    },
    {
      name: 'quality audit report path',
      mutate(record) {
        record.quality_audit.report = '../unscoped-report.json';
      },
      issue: 'changed_full_track_review_scoped_audit_required',
    },
    {
      name: 'archived global audit',
      mutate(record) {
        record.quality_audit.report = 'reports/card_quality_audit_report.json';
      },
      issue: 'changed_full_track_review_scoped_audit_required',
    },
    {
      name: 'quality audit fingerprint',
      mutate(record) {
        record.quality_audit.corpus_fingerprint = '';
      },
      issue: 'changed_full_track_review_quality_audit_fingerprint_invalid',
    },
    {
      name: 'quality audit scope flag',
      mutate(record) {
        record.quality_audit.scope_has_no_hard_blockers = false;
      },
      issue: 'changed_full_track_review_quality_audit_not_clear',
    },
    {
      name: 'quality audit summary scope',
      mutate(record) {
        record.quality_audit.scope_summary.card_ids = [];
      },
      issue: 'changed_full_track_review_quality_audit_scope_mismatch',
    },
    {
      name: 'quality audit hard blocker',
      mutate(record) {
        record.quality_audit.scope_summary.issue_count = 1;
        record.quality_audit.scope_summary.by_severity.hard_blocker = 1;
      },
      issue: 'changed_full_track_review_quality_audit_has_hard_blockers',
    },
    {
      name: 'quality audit severity total',
      mutate(record) {
        record.quality_audit.scope_summary.issue_count = 1;
      },
      issue: 'changed_full_track_review_quality_audit_severity_total_mismatch',
    },
    {
      name: 'quality audit rule coverage',
      mutate(record) {
        delete record.quality_audit.scope_summary.by_rule.synthetic_source;
      },
      issue: 'changed_full_track_review_quality_audit_rule_invalid',
    },
    {
      name: 'batch status',
      mutate(record) {
        delete record.batch_review;
      },
      issue: 'changed_full_track_review_batch_status_invalid',
    },
    {
      name: 'remaining risks',
      mutate(record) {
        record.batch_review.remaining_risks = ['unresolved fixture risk'];
      },
      issue: 'changed_full_track_review_remaining_risks_invalid',
    },
    {
      name: 'batch summary',
      mutate(record) {
        delete record.batch_review.summary;
      },
      issue: 'changed_full_track_review_batch_evidence_incomplete',
    },
    {
      name: 'batch next step',
      mutate(record) {
        delete record.batch_review.next_step;
      },
      issue: 'changed_full_track_review_batch_evidence_incomplete',
    },
    {
      name: 'empty representative cards',
      mutate(record) {
        record.representative_cards = [];
      },
      issue: 'changed_full_track_review_representative_cards_invalid',
    },
    {
      name: 'representative card scope',
      mutate(record) {
        record.representative_cards = ['999999'];
      },
      issue: 'changed_full_track_review_representative_cards_invalid',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const repo = createRepository();
      const card = completeCard();
      writeCardBox(repo.root, [card]);
      const reviewPath = writeFullTrackReview(repo.root, {
        scopeCardIds: ['000001'],
      });
      const record = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
      testCase.mutate(record);
      writeJson(reviewPath, record);
      commit(repo.root, `invalidate full-track ${testCase.name}`);

      const result = validate(repo);
      assert.notEqual(result.status, 0, result.stdout);
      assertIssue(result.report, testCase.issue);
      const coverageIssue = assertIssue(
        result.report,
        'changed_card_self_review_count_invalid',
      );
      assert.equal(coverageIssue.review_count, 0);
    });
  }
});

test('a minimal standard self-review cannot count as changed-card coverage', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  writeJson(
    path.join(repo.root, 'reviews/agent_self_review/minimal.json'),
    {
      scope: {box_prefixes: ['0000'], card_ids: ['000001']},
      cards: [{
        card_id: '000001',
        interaction_id: card.interaction_id,
        knowledge_ref: card.knowledge_ref,
        status: 'pass',
        quality_metadata: {
          ...structuredClone(card.quality_metadata),
          review_status: 'agent_pass',
        },
      }],
    },
  );
  commit(repo.root, 'add incomplete standard review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_quality_audit_invalid');
  assertIssue(result.report, 'changed_self_review_blocker_scan_invalid');
  const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(coverageIssue.review_count, 0);
});

test('nested self-review JSON cannot authorize standard or full-track coverage', async t => {
  await t.test('standard', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    writeSelfReviewFile(
      repo.root,
      'nested/standard.json',
      ['000001'],
      [reviewEntry(card)],
    );
    commit(repo.root, 'add nested standard review');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_path_noncanonical');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });

  await t.test('full-track', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    const reviewPath = writeFullTrackReview(repo.root, {
      scopeCardIds: ['000001'],
    });
    const nestedDir = path.join(repo.root, 'reviews/agent_self_review/nested');
    fs.mkdirSync(nestedDir, {recursive: true});
    fs.renameSync(reviewPath, path.join(nestedDir, path.basename(reviewPath)));
    commit(repo.root, 'add nested full-track review');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'changed_self_review_path_noncanonical');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });
});

test('Git evidence paths are preserved exactly and unusual separators fail closed', async t => {
  await t.test('literal backslash', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    const reviewPath = writeSelfReview(
      repo.root,
      'collision.json',
      ['000001'],
      [reviewEntry(card)],
    );
    commit(repo.root, 'establish canonical review path');
    repo.base = git(repo.root, 'rev-parse', 'HEAD');

    writeCardBox(repo.root, [{
      ...card,
      analysis: {text: 'Changed card body must require genuinely changed evidence.'},
    }]);
    const relativeReviewPath = path.relative(repo.root, reviewPath);
    writeJson(
      path.join(repo.root, relativeReviewPath.replaceAll('/', '\\')),
      {scope: {card_ids: ['000001']}},
    );
    commit(repo.root, 'add colliding literal backslash path');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assertIssue(result.report, 'git_diff_path_noncanonical');
    const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
    assert.equal(coverageIssue.review_count, 0);
  });

  await t.test('Unicode line separator', () => {
    const repo = createRepository();
    const card = completeCard();
    writeCardBox(repo.root, [card]);
    writeSelfReviewFile(
      repo.root,
      'line\u2028separator.json',
      ['000001'],
      [reviewEntry(card)],
    );
    commit(repo.root, 'add Unicode line separator review');

    const result = validate(repo);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.report.content_candidate_diff, true);
    assertIssue(result.report, 'git_diff_path_noncanonical');
  });
});

test('a symlinked self-review cannot authorize changed-card coverage', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const targetPath = writeSelfReviewFile(
    repo.root,
    'target.txt',
    ['000001'],
    [reviewEntry(card)],
  );
  const symlinkPath = path.join(repo.root, 'reviews/agent_self_review/review.json');
  fs.symlinkSync(path.basename(targetPath), symlinkPath);
  commit(repo.root, 'add symlinked review');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_self_review_not_regular_file');
  const coverageIssue = assertIssue(result.report, 'changed_card_self_review_count_invalid');
  assert.equal(coverageIssue.review_count, 0);
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
  writeModelOwnedFullTrackReview(repo.root, {
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
  writeModelOwnedSelfReview(repo.root, 'review-a.json', [card]);
  writeModelOwnedSelfReview(repo.root, 'review-b.json', [card]);
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

test('a changed review cannot reuse an unchanged forged scoped audit', () => {
  const repo = createRepository();
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeSelfReview(
    repo.root,
    'unchanged-forged-audit.json',
    ['000001'],
    [reviewEntry(card)],
  );
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const reportPath = path.join(repo.root, review.quality_audit.report);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.forged_historical_claim = true;
  writeJson(reportPath, report);
  commit(repo.root, 'establish forged historical scoped audit');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  changeReviewId(reviewPath, 'changed-review-reusing-forged-audit');
  commit(repo.root, 'change review while reusing forged scoped audit');

  const result = validate(repo);
  assert.notEqual(result.status, 0, result.stdout);
  assertIssue(result.report, 'changed_review_scoped_audit_replay_mismatch');
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

test('worktree validation preserves untracked paths without a stale normalizer call', () => {
  const repo = createRepository();
  fs.writeFileSync(path.join(repo.root, 'UNTRACKED.md'), 'untracked fixture\n');

  const result = validateWorktree(repo);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    result.report.changed_paths.find(entry => entry.status === '??')?.paths,
    ['UNTRACKED.md'],
  );
});

test('worktree validation rejects an untracked literal-backslash path without rewriting it', () => {
  const repo = createRepository();
  const unsafePath = 'reviews\\agent_self_review\\untracked.json';
  writeJson(path.join(repo.root, unsafePath), {scope: {card_ids: ['000001']}});

  const result = validateWorktree(repo);
  assert.notEqual(result.status, 0, result.stdout);
  const issue = assertIssue(result.report, 'git_diff_path_noncanonical');
  assert.equal(issue.path, unsafePath);
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
    'scripts/manage_controlled_pilot_approval.mjs',
    'scripts/lib/card_integrity.mjs',
    'scripts/lib/model_acceptance.mjs',
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

function testCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${testCanonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function testCardObjectSha256(card) {
  return `sha256:${crypto.createHash('sha256').update(testCanonicalJson(card)).digest('hex')}`;
}

function testModelAcceptance(inputSha256, capabilities, runId) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-08-23T12:00:00+08:00',
      input_sha256: inputSha256,
      capabilities,
      summary: 'The exact bound input passed the governed model review.',
      findings: [],
    },
    decision: 'accepted',
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
    blocker_scan: {
      logic_error: false,
      language_error: false,
      inappropriate_wording: false,
      low_knowledge_density: false,
      not_meeting_requirement: false,
      reverse_engineered_front: false,
      fake_source_claim: false,
      low_quality_variation: false,
    },
    analysis_reference_check: {
      answer_matches_card: true,
      choice_or_bank_references_match_source: true,
      distractor_labels_match_explanations: true,
    },
  };
}

function writeCardBox(root, cards) {
  writeJson(
    path.join(root, 'card_boxes_json/card_boxes_seed_cet4_listening_0000.json'),
    { cards },
  );
}

function writeSelfReview(root, suffix, cardIds, cards, options = {}) {
  return writeSelfReviewFile(
    root,
    `20260731-cet4-listening-0000-${suffix}`,
    cardIds,
    cards,
    options,
  );
}

function writeModelOwnedSelfReview(root, suffix, cards, {
  boxPrefixes = ['0000'],
} = {}) {
  const cardIds = cards.map(card => card.card_id);
  const auditReportPath = `reviews/audit_scopes/model-${suffix}-scope-audit.json`;
  writeJson(
    path.join(root, auditReportPath),
    fixtureScopedAuditReport(cardIds),
  );
  const auditSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, auditReportPath)))
    .digest('hex')}`;
  const scope = {
    track: 'cet4',
    box_prefixes: boxPrefixes,
    card_ids: cardIds,
  };
  const inputSha256 = buildModelAcceptanceInputSha256({
    decisionType: 'card_review',
    scope,
    corpusFingerprint: 'f'.repeat(64),
    auditSha256,
  });
  const filePath = path.join(root, 'reviews/agent_self_review', suffix);
  writeJson(filePath, {
    schema_version: 'model-owned-card-review.v2',
    review_id: suffix.replace(/\.json$/u, ''),
    created_at: '2026-08-23T12:00:00+08:00',
    model_acceptance: testModelAcceptance(
      inputSha256,
      ['card_semantic_review', 'source_provenance_review'],
      `model-card-${suffix.replace(/\.json$/u, '')}`,
    ),
    scope,
    specs_read: ['spec/review-workflow.json'],
    quality_audit: {
      report: auditReportPath,
      report_sha256: auditSha256,
      corpus_fingerprint: 'f'.repeat(64),
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(cardIds),
    },
    cards: cards.map(reviewEntry),
    removed_cards: [],
    batch_review: {
      status: 'model_accepted',
      box_progression: 'Exact-scope model review preserves governed progression.',
      repetition_or_gap_risks: [],
      representative_cards: cardIds.slice(0, 1),
      next_step: 'Merge after exact-head gates pass.',
    },
  });
  return filePath;
}

function writeSelfReviewFile(
  root,
  filename,
  cardIds,
  cards,
  {
    reviewScopeType = 'residual_blocker_closure',
    boxPrefixes = ['0000'],
  } = {},
) {
  const filePath = path.join(root, 'reviews/agent_self_review', filename);
  const isResidualClosure = reviewScopeType === 'residual_blocker_closure';
  const isConfirmedExpansion = reviewScopeType === 'confirmed_box_expansion';
  const auditReportPath = isResidualClosure
    ? 'reviews/audit_scopes/fixture-residual-scope-audit.json'
    : 'reviews/audit_scopes/fixture-standard-scope-audit.json';
  writeJson(
    filePath,
    {
      review_id: filename,
      created_at: '2026-07-31T12:00:00+08:00',
      agent: 'codex',
      scope: {
        library: 'fixture-library',
        group: 'fixture-group',
        box: 'fixture-box',
        box_prefixes: boxPrefixes,
        card_ids: cardIds,
        ...(isResidualClosure
          ? {
              closure_reason: 'Fixture closes a previously identified candidate issue.',
              source_issue_refs: ['fixture:changed-card'],
            }
          : {}),
      },
      specs_read: ['spec/review-workflow.json'],
      sample_policy: isResidualClosure
        ? {
            review_scope_type: 'residual_blocker_closure',
            is_three_card_sample_per_box: false,
            residual_blocker_closure: true,
            not_sample_approval: true,
            batch_generation_requires_user_confirmation: true,
          }
        : isConfirmedExpansion
          ? {
              review_scope_type: 'confirmed_box_expansion',
              is_three_card_sample_per_box: false,
              confirmed_box_expansion: true,
              sample_confirmation_satisfied: true,
              sample_confirmation_record: 'reviews/sample_confirmations/fixture-confirmation.json',
              sample_confirmation_id: 'fixture-confirmation',
              final_user_approval_required: true,
              batch_generation_requires_user_confirmation: true,
            }
          : {
            review_scope_type: 'three_card_sample_per_box',
            is_three_card_sample_per_box: true,
            batch_generation_requires_user_confirmation: true,
      },
      quality_audit: {
        report: auditReportPath,
        corpus_fingerprint: 'fixture-fingerprint',
        scope_has_no_hard_blockers: true,
        scope_summary: qualityAuditSummary(cardIds),
      },
      cards,
      batch_review: {
        status: isResidualClosure
          ? 'documented_residual_closure'
          : isConfirmedExpansion
            ? 'reviewed_confirmed_box_expansion'
            : 'recommend_user_confirmation',
        box_progression: 'fixture progression',
        repetition_or_gap_risks: [],
        representative_cards: cardIds.slice(0, 1),
        next_step: 'Request user confirmation.',
      },
    },
  );
  writeJson(
    path.join(root, auditReportPath),
    fixtureScopedAuditReport(cardIds),
  );
  return filePath;
}

function sampleConfirmation(targetCardCount) {
  return {
    schema_version: 'sample-confirmation.v1',
    confirmation_id: 'fixture-confirmation',
    recorded_at: '2026-08-02T12:00:00+08:00',
    confirmed_by_user: true,
    confirmation_source: {
      conversation_id: 'fixture:conversation',
      message: 'continue',
      context: 'The fixture confirms one three-card sample for exact target expansion.',
    },
    scope: {
      track: 'cet4',
      purpose: 'controlled_pilot',
      target_card_count: targetCardCount,
      box_targets: [{
        box_prefix: '0000',
        target_card_count: targetCardCount,
        sample_card_ids: ['000001', '000002', '000003'],
      }],
    },
    sample_evidence: {
      review_pack_sha256: `sha256:${'a'.repeat(64)}`,
      sample_card_count: 3,
      box_count: 1,
      branch_heads: [{box_prefix: '0000', branch: 'content/fixture', commit_sha: 'abcdef0'}],
    },
    authorizes: {confirmed_box_expansion: true, same_quality_contract: true},
    does_not_authorize: ['formal_content_approval', 'audio_perceptual_qc', 'pilot_release', 'destructive_card_changes'],
    final_user_approval_required: true,
    gate_eligible: false,
  };
}

function prepareConfirmedExpansion(targetCardCount) {
  const repo = createRepository();
  const sampleCards = [
    legacyCard(),
    {...legacyCard(), card_id: '000002', front: {text: 'second sample prompt'}},
    {...legacyCard(), card_id: '000003', front: {text: 'third sample prompt'}},
  ];
  writeCardBox(repo.root, sampleCards);
  commit(repo.root, 'establish confirmed sample baseline');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');

  const expansionCards = Array.from({length: targetCardCount - 3}, (_, index) => ({
    ...completeCard(),
    card_id: `0000${String(index + 4).padStart(2, '0')}`,
    front: {text: `expansion prompt ${index + 1}`},
  }));
  writeCardBox(repo.root, [...sampleCards, ...expansionCards]);
  const confirmationPath = path.join(repo.root, 'reviews/sample_confirmations/fixture-confirmation.json');
  writeJson(confirmationPath, sampleConfirmation(targetCardCount));
  const reviewPath = writeSelfReview(
    repo.root,
    'confirmed-expansion.json',
    expansionCards.map(card => card.card_id),
    expansionCards.map(reviewEntry),
    {reviewScopeType: 'confirmed_box_expansion'},
  );
  return {repo, sampleCards, expansionCards, confirmationPath, reviewPath};
}

function fixtureScopedAuditReport(cardIds) {
  return {
    scope: {card_ids: [...new Set(cardIds)].sort()},
    scope_summary: {by_severity: {hard_blocker: 0}},
    scoped_hard_blocker_issues: [],
  };
}

function qualityAuditSummary(cardIds) {
  return {
    card_ids: cardIds,
    card_count: new Set(cardIds).size,
    issue_count: 0,
    by_severity: {
      hard_blocker: 0,
      content_risk: 0,
      review_gap: 0,
      source_risk: 0,
    },
    by_rule: {
      multiple_choice_no_options: 0,
      multiple_choice_answer_not_in_options: 0,
      front_leaks_correct_answer: 0,
      front_leaks_analysis_conclusion: 0,
      front_missing_or_too_short: 0,
      analysis_missing_or_too_short: 0,
      generic_front_pattern: 0,
      template_analysis_pattern: 0,
      exact_repeated_front: 0,
      exact_repeated_analysis: 0,
      missing_quality_metadata: 0,
      unverified_source: 0,
      synthetic_source: 0,
    },
  };
}

function runtimePayloadForCards(cards, track = 'cet4') {
  return {
    source: {id: 'card-make-fixture', label: 'Card Make fixture'},
    track,
    card_records: cards,
    release: null,
  };
}

function writeApprovalFile(
  root,
  filename,
  {
    cardIds = ['000001'],
    linkedReview =
      'reviews/agent_self_review/fixture-approval-current-review.json',
    report = 'reviews/audit_scopes/fixture-approval-scope-audit.json',
  } = {},
) {
  const filePath = path.join(root, 'reviews/approved_batches', filename);
  writeJson(filePath, {
    approved_by_user: true,
    approved_at: '2026-07-31T12:00:00+08:00',
    scope: {
      library: 'fixture-library',
      group: 'fixture-group',
      box: 'fixture-box',
      box_prefixes: ['0000'],
      card_ids: cardIds,
    },
    summary: 'Fixture approval evidence.',
    card_quality_audit: {
      report,
      corpus_fingerprint: 'fixture-fingerprint',
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(cardIds),
    },
    representative_cards: cardIds.slice(0, 1),
    validation: {
      agent_self_review: linkedReview,
      harness: 'pass',
      cards: 'pass',
      audit: 'pass',
    },
    approval_limits: [
      'scope only',
      'no bulk generation',
      'no automatic merge',
    ],
  });
  if (report.startsWith('reviews/audit_scopes/')) {
    writeJson(path.join(root, report), fixtureScopedAuditReport(cardIds));
  }
  return filePath;
}

function establishApprovalReviewBase(repo, cardIds = ['000001']) {
  const reviewPath =
    'reviews/agent_self_review/fixture-approval-current-review.json';
  const reportPath =
    'reviews/audit_scopes/fixture-approval-review-scope-audit.json';
  writeJson(path.join(repo.root, reviewPath), {
    review_id: 'fixture-approval-current-review',
    scope: {
      box_prefixes: ['0000'],
      card_ids: cardIds,
    },
    quality_audit: {
      report: reportPath,
      corpus_fingerprint: 'fixture-fingerprint',
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(cardIds),
    },
  });
  writeJson(
    path.join(repo.root, reportPath),
    fixtureScopedAuditReport(cardIds),
  );
  commit(repo.root, 'establish current linked approval review');
  repo.base = git(repo.root, 'rev-parse', 'HEAD');
  return reviewPath;
}

function writeFullTrackReview(root, {
  scopeCardIds,
  reviewedCardIds = scopeCardIds,
  expectedCount = new Set(scopeCardIds).size,
  track = 'cet4',
  boxPrefixes = ['0000'],
  coverageBoxPrefixes = boxPrefixes,
  humanReviewer = 'external:fixture-reviewer',
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
      human_reviewer: humanReviewer,
      analysis_reference_check: {
        answer_matches_card: true,
        choice_or_bank_references_match_source: true,
        distractor_labels_match_explanations: true,
      },
      boxes: coverageBoxPrefixes.map(boxPrefix => ({
        box_prefix: boxPrefix,
        status: 'pass',
        reviewer: humanReviewer,
      })),
    },
    quality_audit: {
      report: 'reviews/audit_scopes/fixture-full-track-scope-audit.json',
      corpus_fingerprint: 'fixture-fingerprint',
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(scopeCardIds),
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
  writeJson(
    path.join(root, record.quality_audit.report),
    fixtureScopedAuditReport(scopeCardIds),
  );
  return filePath;
}

function writeModelOwnedFullTrackReview(root, {
  scopeCardIds,
  reviewedCardIds = scopeCardIds,
  expectedCount = new Set(scopeCardIds).size,
  track = 'cet4',
  boxPrefixes = ['0000'],
  coverageBoxPrefixes = boxPrefixes,
}) {
  const filePath = path.join(
    root,
    'reviews/agent_self_review/20260823-model-owned-full-track-review.json',
  );
  const auditReportPath =
    'reviews/audit_scopes/fixture-model-full-track-scope-audit.json';
  writeJson(
    path.join(root, auditReportPath),
    fixtureScopedAuditReport(scopeCardIds),
  );
  const auditSha256 = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, auditReportPath)))
    .digest('hex')}`;
  const scope = {track, box_prefixes: boxPrefixes, card_ids: scopeCardIds};
  const inputSha256 = buildModelAcceptanceInputSha256({
    decisionType: 'full_track_review',
    scope,
    corpusFingerprint: 'f'.repeat(64),
    auditSha256,
  });
  writeJson(filePath, {
    schema_version: 'model-owned-full-track-review.v2',
    review_id: '20260823-model-owned-full-track-review',
    created_at: '2026-08-23T12:00:00+08:00',
    model_acceptances: [
      testModelAcceptance(
        inputSha256,
        ['card_semantic_review', 'source_provenance_review'],
        'model-full-track-review-a',
      ),
      testModelAcceptance(
        inputSha256,
        ['card_semantic_review', 'source_provenance_review'],
        'model-full-track-review-b',
      ),
    ],
    scope,
    specs_read: ['spec/review-workflow.json'],
    coverage: {
      expected_card_count: expectedCount,
      reviewed_card_ids: reviewedCardIds,
      analysis_reference_check: {
        answer_matches_card: true,
        choice_or_bank_references_match_source: true,
        distractor_labels_match_explanations: true,
      },
      boxes: coverageBoxPrefixes.map(boxPrefix => ({
        box_prefix: boxPrefix,
        status: 'pass',
      })),
    },
    quality_audit: {
      report: auditReportPath,
      report_sha256: auditSha256,
      corpus_fingerprint: 'f'.repeat(64),
      scope_has_no_hard_blockers: true,
      scope_summary: qualityAuditSummary(scopeCardIds),
    },
    representative_cards: scopeCardIds.slice(0, 1),
    removed_cards: [],
    batch_review: {
      status: 'ready_for_model_authorization',
      summary: 'Exact full-track model review passed.',
      remaining_risks: [],
      next_step: 'Create exact-scope model authorization.',
    },
  });
  return filePath;
}

function establishCompleteCandidateBase(repo) {
  const card = completeCard();
  writeCardBox(repo.root, [card]);
  const reviewPath = writeModelOwnedSelfReview(
    repo.root,
    'head-snapshot-review.json',
    [card],
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
    { cwd: repo.root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  const output = result.stdout.trim() || result.stderr.trim();
  let report;
  try {
    report = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `validate_pr_scope emitted invalid JSON: ${error.message}; ` +
      `status=${result.status}; signal=${result.signal}; ` +
      `stdout=${result.stdout.length}; stderr=${result.stderr.length}; ` +
      `tail=${JSON.stringify(output.slice(-240))}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report,
  };
}

function validateWorktree(repo) {
  const result = spawnSync(
    process.execPath,
    ['scripts/validate_pr_scope.mjs', '--base', repo.base],
    {cwd: repo.root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024},
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
    {cwd: repo.root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024},
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
const scopeIndex = process.argv.indexOf('--scope-card-ids');
const cardIds = process.argv[scopeIndex + 1].split(',').filter(Boolean).sort();
const report = {
  scope: {card_ids: [...new Set(cardIds)]},
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
const scopeIndex = process.argv.indexOf('--scope-card-ids');
const cardIds = process.argv[scopeIndex + 1].split(',').filter(Boolean).sort();
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
  scope: {card_ids: [...new Set(cardIds)]},
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
