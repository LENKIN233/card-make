import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  computeCardCorpusFingerprint,
  deepEqualQualityMetadata,
  isHumanReviewerIdentity,
  loadIntegrityPolicy,
  validateCurrentApprovalRecordReference,
  validateChangedCardSelfReviewParity,
  validateEliminationIntegrity,
  validateModelOwnedFullTrackReviewShape,
  validateQualityMetadata,
} from './lib/card_integrity.mjs';
import {buildEliminationContract} from './migrate_cards_to_softbook_contract.mjs';
import {
  buildContentAuthorizationAdditionalBindings,
  buildModelAcceptanceInputSha256,
  deriveRuntimePayloadContentIdentity,
} from './lib/model_acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = loadIntegrityPolicy(ROOT);

test('structured human reviewer identities allow real short and Unicode IDs but reject automation identities', () => {
  for (const identity of [
    'external:张三',
    'github:x',
    'team:qa',
    'external:Alice.Wu',
  ]) {
    assert.equal(isHumanReviewerIdentity(identity), true, identity);
  }
  for (const identity of [
    'external:codexagent',
    'github:buildbot123',
    'team:automationRunner',
    'team:ci',
    'team:ci-runner',
    'external:',
    'external:Alice Wu',
    'external:-',
    'external:_',
    'external:@',
    'external:...',
  ]) {
    assert.equal(isHumanReviewerIdentity(identity), false, identity);
  }
});

test('model-owned full-track review requires complete reference, box, batch, and representative evidence', () => {
  const review = {
    schema_version: 'model-owned-full-track-review.v2',
    scope: {track: 'cet4', box_prefixes: ['0000'], card_ids: ['000001']},
    coverage: {
      expected_card_count: 1,
      reviewed_card_ids: ['000001'],
      analysis_reference_check: {
        answer_matches_card: true,
        choice_or_bank_references_match_source: true,
        distractor_labels_match_explanations: true,
      },
      boxes: [{box_prefix: '0000', status: 'pass'}],
    },
    representative_cards: ['000001'],
    batch_review: {
      status: 'ready_for_model_authorization',
      summary: 'Complete exact-scope model review.',
      remaining_risks: [],
      next_step: 'Create bound authorization.',
    },
  };
  assert.equal(validateModelOwnedFullTrackReviewShape(review).ok, true);
  const incomplete = structuredClone(review);
  delete incomplete.coverage.analysis_reference_check;
  incomplete.representative_cards = [];
  const result = validateModelOwnedFullTrackReviewShape(incomplete);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(
    issue => issue.code === 'model_full_track_review_reference_check_invalid',
  ));
  assert.ok(result.issues.some(
    issue => issue.code === 'model_full_track_review_representatives_invalid',
  ));
});

function clone(value) {
  return structuredClone(value);
}

function modelAcceptance(
  inputDigest,
  capabilities,
  runId = 'codex-task:card-integrity-fixture',
) {
  return {
    schema_version: 'model-acceptance.v2',
    actor: {
      kind: 'model_harness',
      agent: 'agent:codex',
      model: 'gpt-5.6-sol',
      run_id: runId,
    },
    evidence: {
      reviewed_at: '2026-07-31T12:00:00+08:00',
      input_sha256: String(inputDigest).startsWith('sha256:')
        ? inputDigest
        : `sha256:${inputDigest}`,
      capabilities,
      summary: 'The exact bound scope passed semantic review.',
      findings: [],
    },
    decision: 'accepted',
  };
}

function cryptoHashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validMetadata(reviewStatus = 'draft') {
  return {
    main_training_goal: '识别听力语篇中的转折信号',
    secondary_training_goals: ['排除无关细节'],
    weak_point_tags: ['listening_weak', 'exam_strategy_weak'],
    difficulty: {
      primary: 'pass',
      secondary: ['high_score'],
    },
    card_prototype: 'integrated_micro_drill',
    material: {
      text_source_type: 'simulation',
      source_note: 'Test-only simulated CET material.',
      audio_generation_method: 'none',
      tts_text_reviewed: true,
      tts_audio_reviewed: false,
    },
    exam_value: '训练用户在考试听力中快速锁定真正决定答案的转折信息。',
    box_progression_role: 'application',
    review_status: reviewStatus,
  };
}

function validCard(overrides = {}) {
  return {
    card_id: '000001',
    track: 'cet4',
    knowledge_ref: {library_id: '0', group_id: '0', box_id: '0'},
    interaction_id: 'multiple_choice',
    quality_metadata: validMetadata(),
    ...overrides,
  };
}

function eliminationCard(overrides = {}) {
  const eliminableItems = [
    {text: 'keep the central claim', is_correct: true},
    {text: 'remove the date detail', is_correct: false},
    {text: 'keep the causal link', is_correct: true},
  ];
  return {
    card_id: '060001',
    interaction_id: 'elimination',
    elimination_items: [
      {id: 'central_claim', text: 'keep the central claim'},
      {id: 'date_detail', text: 'remove the date detail'},
      {id: 'causal_link', text: 'keep the causal link'},
    ],
    eliminable_items: eliminableItems,
    answer_key: {
      correct_items: ['central_claim', 'causal_link'],
    },
    ...overrides,
  };
}

function legacyEliminationCard() {
  const items = [
    {text: 'keep the central claim', is_correct: true},
    {text: 'remove the date detail', is_correct: false},
  ];
  return {
    card_id: '060099',
    interaction_id: 'elimination',
    elimination_items: clone(items),
    eliminable_items: clone(items),
    answer_key: {
      correct_items: ['keep the central claim'],
    },
  };
}

function codes(result) {
  return new Set(result.issues.map(issue => issue.code));
}

test('loads the active schema and content-quality enum intersection', () => {
  assert.ok(POLICY.allowed.weak_point_tags.includes('listening_weak'));
  assert.deepEqual(POLICY.allowed.difficulties, ['foundation', 'pass', 'high_score']);
  assert.ok(POLICY.quality_metadata_required_fields.includes('review_status'));
});

test('accepts a complete quality_metadata payload', () => {
  const result = validateQualityMetadata(validCard(), POLICY, {required: true});
  assert.equal(result.ok, true);
  assert.equal(result.present, true);
  assert.deepEqual(result.issues, []);
});

test('grandfathers absent legacy metadata but strict mode requires it', () => {
  const card = validCard();
  delete card.quality_metadata;

  const legacyResult = validateQualityMetadata(card, POLICY, {required: false});
  assert.equal(legacyResult.ok, true);
  assert.equal(legacyResult.skipped, true);

  const strictResult = validateQualityMetadata(card, POLICY, {required: true});
  assert.equal(strictResult.ok, false);
  assert.ok(codes(strictResult).has('candidate_quality_metadata_missing'));
});

test('does not grandfather an explicitly null metadata payload', () => {
  const result = validateQualityMetadata(
    validCard({quality_metadata: null}),
    POLICY,
    {required: false},
  );
  assert.equal(result.ok, false);
  assert.equal(result.present, true);
  assert.ok(codes(result).has('candidate_quality_metadata_invalid'));
});

test('rejects invalid content-quality enums and missing schema-required metadata', () => {
  const card = validCard();
  card.quality_metadata.weak_point_tags = ['listening_weak', 'challenge'];
  card.quality_metadata.difficulty.primary = 'advanced';
  card.quality_metadata.card_prototype = 'flashcard';
  card.quality_metadata.material.text_source_type = 'unknown';
  card.quality_metadata.material.audio_generation_method = 'human_recording';
  card.quality_metadata.box_progression_role = 'final';
  card.quality_metadata.review_status = 'user_approved';
  delete card.quality_metadata.exam_value;

  const result = validateQualityMetadata(card, POLICY, {required: true});
  const actualCodes = codes(result);
  assert.equal(result.ok, false);
  assert.ok(actualCodes.has('invalid_weak_point_tag'));
  assert.ok(actualCodes.has('invalid_difficulty'));
  assert.ok(actualCodes.has('invalid_card_prototype'));
  assert.ok(actualCodes.has('invalid_text_source_type'));
  assert.ok(actualCodes.has('invalid_audio_generation_method'));
  assert.ok(actualCodes.has('invalid_box_progression_role'));
  assert.ok(actualCodes.has('invalid_review_status'));
  assert.ok(actualCodes.has('candidate_quality_metadata_required_field_missing'));
});

test('accepts answer order changes while preserving canonical truth', () => {
  const card = eliminationCard();
  card.answer_key.correct_items.reverse();
  card.eliminable_items = card.eliminable_items.map(item => ({
    is_correct: item.is_correct,
    text: item.text,
  }));

  const result = validateEliminationIntegrity(card, {requireLegacyMirror: true});
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('rejects a canonical and local-preview mirror mismatch', () => {
  const card = eliminationCard();
  card.eliminable_items[1].text = 'stale preview text';

  const result = validateEliminationIntegrity(card, {requireLegacyMirror: true});
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('elimination_legacy_mirror_mismatch'));
});

test('rejects stale, missing, and false answer identities', () => {
  const card = eliminationCard({
    answer_key: {
      correct_items: ['central_claim', 'date_detail', 'stale_id'],
    },
  });

  const result = validateEliminationIntegrity(card, {requireLegacyMirror: true});
  const actualCodes = codes(result);
  assert.equal(result.ok, false);
  assert.ok(actualCodes.has('elimination_correct_items_not_in_items'));
  assert.ok(actualCodes.has('elimination_correct_items_truth_mismatch'));
  assert.deepEqual(
    result.issues.find(issue => issue.code === 'elimination_correct_items_truth_mismatch').missing,
    ['causal_link'],
  );
});

test('rejects duplicate canonical and answer identities', () => {
  const duplicateCanonical = eliminationCard();
  duplicateCanonical.elimination_items.push({
    id: 'central_claim',
    text: 'duplicate display text',
  });
  duplicateCanonical.eliminable_items.push({
    text: 'duplicate display text',
    is_correct: false,
  });
  let result = validateEliminationIntegrity(duplicateCanonical, {requireLegacyMirror: true});
  assert.ok(codes(result).has('elimination_duplicate_item_identity'));

  const duplicateAnswer = eliminationCard();
  duplicateAnswer.answer_key.correct_items.push('central_claim');
  result = validateEliminationIntegrity(duplicateAnswer, {requireLegacyMirror: true});
  assert.ok(codes(result).has('elimination_duplicate_item_identity'));
  assert.ok(codes(result).has('elimination_correct_items_truth_mismatch'));
});

test('rejects missing or malformed canonical elimination structures', () => {
  const missingCanonical = eliminationCard();
  delete missingCanonical.elimination_items;
  let result = validateEliminationIntegrity(missingCanonical, {requireLegacyMirror: true});
  assert.ok(codes(result).has('elimination_items_missing'));

  const invalidCanonical = eliminationCard();
  delete invalidCanonical.elimination_items[0].id;
  result = validateEliminationIntegrity(invalidCanonical, {requireLegacyMirror: true});
  assert.ok(codes(result).has('elimination_items_invalid'));
});

test('legacy text-as-id cards pass only the explicit untouched-corpus compatibility mode', () => {
  const card = legacyEliminationCard();
  const strictResult = validateEliminationIntegrity(card, {requireLegacyMirror: true});
  assert.equal(strictResult.ok, false);
  assert.equal(strictResult.mode, 'runtime_id_contract');
  assert.ok(codes(strictResult).has('elimination_items_invalid'));

  const compatibilityResult = validateEliminationIntegrity(card, {
    requireLegacyMirror: true,
    allowLegacyContract: true,
  });
  assert.equal(compatibilityResult.ok, true);
  assert.equal(compatibilityResult.mode, 'legacy_text_answer_compatibility');
  assert.equal(compatibilityResult.legacy_compatible, true);
});

test('runtime-ID answer truth cannot pass when the preview projection marks every item false', () => {
  const card = eliminationCard();
  card.eliminable_items.forEach(item => {
    item.is_correct = false;
  });

  const result = validateEliminationIntegrity(card, {requireLegacyMirror: true});
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('elimination_correct_items_truth_mismatch'));
});

test('legacy text-as-ID answer truth cannot pass when every mirrored item is false', () => {
  const card = legacyEliminationCard();
  card.elimination_items.forEach(item => {
    item.is_correct = false;
  });
  card.eliminable_items = clone(card.elimination_items);

  const result = validateEliminationIntegrity(card, {
    requireLegacyMirror: true,
    allowLegacyContract: true,
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).has('elimination_correct_items_truth_mismatch'));
});

test('migration emits stable runtime IDs and keeps preview correctness as a projection', () => {
  const contract = buildEliminationContract([
    {text: 'first item', is_correct: true},
    {id: 'stable_id', text: 'second item', is_correct: false},
    {id: 'stable_id', text: 'third item', is_correct: true},
  ]);
  assert.deepEqual(contract.elimination_items, [
    {id: 'item_1', text: 'first item'},
    {id: 'stable_id', text: 'second item'},
    {id: 'stable_id_2', text: 'third item'},
  ]);
  assert.deepEqual(contract.answer_key.correct_items, ['item_1', 'stable_id_2']);
});

test('metadata parity excludes only review_status and ignores object key order', () => {
  const card = validCard();
  const source = validMetadata('agent_pass');
  const reviewMetadata = {
    review_status: source.review_status,
    box_progression_role: source.box_progression_role,
    exam_value: source.exam_value,
    material: {
      tts_audio_reviewed: source.material.tts_audio_reviewed,
      tts_text_reviewed: source.material.tts_text_reviewed,
      audio_generation_method: source.material.audio_generation_method,
      source_note: source.material.source_note,
      text_source_type: source.material.text_source_type,
    },
    card_prototype: source.card_prototype,
    difficulty: {
      secondary: [...source.difficulty.secondary],
      primary: source.difficulty.primary,
    },
    weak_point_tags: [...source.weak_point_tags],
    secondary_training_goals: [...source.secondary_training_goals],
    main_training_goal: source.main_training_goal,
  };
  assert.equal(deepEqualQualityMetadata(card.quality_metadata, reviewMetadata), true);

  const result = validateChangedCardSelfReviewParity(
    [{card, path: 'card_boxes_json/test.json'}],
    [{record: {cards: [{card_id: card.card_id, quality_metadata: reviewMetadata}]}, path: 'reviews/agent_self_review/test.json'}],
    POLICY,
    {required: true},
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats.parity_exception.excluded_fields, ['review_status']);
});

test('metadata parity catches every non-status field drift', () => {
  const card = validCard();
  const reviewMetadata = validMetadata('agent_pass');
  reviewMetadata.exam_value = '这是一条不同但仍通过结构校验的考试价值说明。';

  const result = validateChangedCardSelfReviewParity(
    card,
    {card_id: card.card_id, quality_metadata: reviewMetadata},
    POLICY,
    {required: true},
  );
  assert.equal(result.ok, false);
  const mismatch = result.issues.find(issue => issue.code === 'candidate_self_review_metadata_mismatch');
  assert.ok(mismatch);
  assert.deepEqual(mismatch.differing_paths, ['quality_metadata.exam_value']);
  assert.deepEqual(mismatch.parity_exception.excluded_fields, ['review_status']);
});

test('metadata parity rejects missing and ambiguous changed self-review snapshots', () => {
  const card = validCard();
  let result = validateChangedCardSelfReviewParity(card, [], POLICY, {required: true});
  assert.ok(codes(result).has('candidate_self_review_missing'));

  const snapshot = {card_id: card.card_id, quality_metadata: validMetadata('agent_pass')};
  result = validateChangedCardSelfReviewParity(card, [snapshot, clone(snapshot)], POLICY, {required: true});
  assert.ok(codes(result).has('candidate_self_review_ambiguous'));
});

test('current approval consumers reject forged replay, stale, template, traversal, and symlink evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-approval-integrity-'));
  const writeJson = (relativePath, value) => {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), {recursive: true});
    fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    const cardIds = ['000001', '000002', '000003'];
    const currentCards = cardIds.map(cardId => validCard({
      card_id: cardId,
      interaction_id: 'flip',
      knowledge_ref: {
        library_id: '0',
        library: 'fixture-library',
        group_id: '0',
        group: 'fixture-group',
        box_id: '0',
        box: 'fixture-box',
        box_prefix: '0000',
      },
    }));
    writeJson('card_boxes_json/card_boxes_seed_cet4_fixture_0000.json', {
      cards: currentCards,
    });
    const currentFingerprint = computeCardCorpusFingerprint(root);
    fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(root, 'spec'), {recursive: true});
    fs.copyFileSync(
      path.join(ROOT, 'scripts/audit_card_quality.mjs'),
      path.join(root, 'scripts/audit_card_quality.mjs'),
    );
    fs.copyFileSync(
      path.join(ROOT, 'spec/card-quality-audit.json'),
      path.join(root, 'spec/card-quality-audit.json'),
    );
    execFileSync(
      process.execPath,
      [
        'scripts/audit_card_quality.mjs',
        '--scope-card-ids',
        cardIds.join(','),
        '--write-scope-report',
        'reviews/audit_scopes/current-approval-audit.json',
      ],
      {cwd: root, encoding: 'utf8'},
    );
    fs.copyFileSync(
      path.join(root, 'reviews/audit_scopes/current-approval-audit.json'),
      path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
    );
    const currentScopedReport = JSON.parse(fs.readFileSync(
      path.join(root, 'reviews/audit_scopes/current-approval-audit.json'),
      'utf8',
    ));
    const reviewAuditSha256 = `sha256:${cryptoHashFile(
      path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
    )}`;
    const approvalAuditSha256 = `sha256:${cryptoHashFile(
      path.join(root, 'reviews/audit_scopes/current-approval-audit.json'),
    )}`;
    const reviewScope = {
      track: 'cet4',
      library: 'fixture-library',
      group: 'fixture-group',
      box: 'fixture-box',
      box_prefixes: ['0000'],
      card_ids: cardIds,
    };
    const currentReview = {
      schema_version: 'model-owned-card-review.v2',
      review_id: 'current-review',
      created_at: '2026-07-31T12:00:00+08:00',
      model_acceptance: modelAcceptance(buildModelAcceptanceInputSha256({
        decisionType: 'card_review',
        scope: reviewScope,
        corpusFingerprint: currentFingerprint.digest,
        auditSha256: reviewAuditSha256,
      }), [
        'card_semantic_review',
        'source_provenance_review',
      ]),
      scope: reviewScope,
      specs_read: ['spec/review-workflow.json'],
      quality_audit: {
        report: 'reviews/audit_scopes/current-review-audit.json',
        report_sha256: reviewAuditSha256,
        corpus_fingerprint: currentFingerprint.digest,
        scope_has_no_hard_blockers: true,
        scope_summary: structuredClone(currentScopedReport.scope_summary),
      },
      cards: currentCards.map(card => ({
        card_id: card.card_id,
        interaction_id: 'flip',
        knowledge_ref: structuredClone(card.knowledge_ref),
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
      })),
      batch_review: {
        status: 'model_accepted',
        box_progression: 'fixture progression',
        repetition_or_gap_risks: [],
        representative_cards: ['000001'],
        next_step: 'create model-owned authorization',
      },
      removed_cards: [],
    };
    writeJson('reviews/agent_self_review/current-review.json', currentReview);
    const linkedReviewSha256 = `sha256:${cryptoHashFile(
      path.join(root, 'reviews/agent_self_review/current-review.json'),
    )}`;
    const approvalPath = 'reviews/approved_batches/current-approval.json';
    const approvalScope = {
      track: 'cet4',
      purpose: 'formal_content',
      box_prefixes: ['0000'],
      card_ids: cardIds,
    };
    writeJson(approvalPath, {
      schema_version: 'model-owned-content-authorization.v2',
      authorization_id: 'current-authorization',
      authorized_at: '2026-07-31T12:00:00+08:00',
      model_acceptance: modelAcceptance(buildModelAcceptanceInputSha256({
        decisionType: 'content_authorization',
        scope: approvalScope,
        corpusFingerprint: currentFingerprint.digest,
        auditSha256: approvalAuditSha256,
        linkedReviewIdentity: {
          path: 'reviews/agent_self_review/current-review.json',
          sha256: linkedReviewSha256,
        },
      }), [
        'content_authorization',
      ]),
      scope: approvalScope,
      summary: 'Fixture current approval.',
      representative_cards: ['000001'],
      card_quality_audit: {
        report: 'reviews/audit_scopes/current-approval-audit.json',
        report_sha256: approvalAuditSha256,
        corpus_fingerprint: currentFingerprint.digest,
        scope_has_no_hard_blockers: true,
        scope_summary: structuredClone(currentScopedReport.scope_summary),
      },
      validation: {
        harness: 'node scripts/validate_harness.mjs',
        cards: 'node scripts/validate_cards.mjs',
        card_quality_audit: 'node scripts/audit_card_quality.mjs',
        model_review: 'reviews/agent_self_review/current-review.json',
        model_review_sha256: linkedReviewSha256,
      },
      authorization_limits: [
        'Only the listed scope is approved.',
        'No unrelated generation is approved.',
        'No product specification change is approved.',
      ],
    });
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['config', 'user.name', 'Fixture Reviewer'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'fixture@example.test'], {
      cwd: root,
    });
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'fixture current approval'], {
      cwd: root,
    });

    let result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));

    const standardApproval = JSON.parse(fs.readFileSync(
      path.join(root, approvalPath),
      'utf8',
    ));
    const runtimePayloadPath =
      'reviews/runtime_payloads/current-full-track-runtime.json';
    const runtimePayload = {
      source: {id: 'card-integrity-fixture', label: 'Card integrity fixture'},
      track: 'cet4',
      card_records: currentCards,
      release: null,
    };
    const contentVersionA =
      deriveRuntimePayloadContentIdentity(runtimePayload).content_version;
    runtimePayload.content_version = contentVersionA;
    writeJson(runtimePayloadPath, runtimePayload);
    const runtimePayloadSha256 = `sha256:${cryptoHashFile(
      path.join(root, runtimePayloadPath),
    )}`;
    const contentVersionB = `sha256:${'e'.repeat(64)}`;
    const fullTrackReviewPath =
      'reviews/agent_self_review/current-full-track-review.json';
    const fullTrackReviewScope = {
      track: 'cet4',
      box_prefixes: ['0000'],
      card_ids: cardIds,
    };
    const fullTrackReviewInput = buildModelAcceptanceInputSha256({
      decisionType: 'full_track_review',
      scope: fullTrackReviewScope,
      corpusFingerprint: currentFingerprint.digest,
      auditSha256: reviewAuditSha256,
    });
    writeJson(fullTrackReviewPath, {
      schema_version: 'model-owned-full-track-review.v2',
      review_id: 'current-full-track-review',
      created_at: '2026-07-31T12:15:00+08:00',
      model_acceptances: [
        modelAcceptance(
          fullTrackReviewInput,
          ['card_semantic_review', 'source_provenance_review'],
          'codex-task:full-track-review-a',
        ),
        modelAcceptance(
          fullTrackReviewInput,
          ['card_semantic_review', 'source_provenance_review'],
          'codex-task:full-track-review-b',
        ),
      ],
      scope: fullTrackReviewScope,
      specs_read: ['spec/review-workflow.json'],
      coverage: {
        expected_card_count: cardIds.length,
        reviewed_card_ids: cardIds,
        analysis_reference_check: {
          answer_matches_card: true,
          choice_or_bank_references_match_source: true,
          distractor_labels_match_explanations: true,
        },
        boxes: [{box_prefix: '0000', status: 'pass'}],
      },
      quality_audit: {
        report: 'reviews/audit_scopes/current-review-audit.json',
        report_sha256: reviewAuditSha256,
        corpus_fingerprint: currentFingerprint.digest,
        scope_has_no_hard_blockers: true,
        scope_summary: structuredClone(currentScopedReport.scope_summary),
      },
      representative_cards: ['000001'],
      removed_cards: [],
      batch_review: {
        status: 'ready_for_model_authorization',
        summary: 'Complete exact-track model review fixture.',
        remaining_risks: [],
        next_step: 'Create runtime-version-bound authorization.',
      },
    });
    const fullTrackReviewSha256 = `sha256:${cryptoHashFile(
      path.join(root, fullTrackReviewPath),
    )}`;
    const fullTrackInput = buildModelAcceptanceInputSha256({
      decisionType: 'full_track_content_authorization',
      scope: approvalScope,
      corpusFingerprint: currentFingerprint.digest,
      auditSha256: approvalAuditSha256,
      linkedReviewIdentity: {
        path: fullTrackReviewPath,
        sha256: fullTrackReviewSha256,
      },
      additionalBindings: buildContentAuthorizationAdditionalBindings({
        authorizationMode: 'full_track',
        contentVersion: contentVersionA,
      }),
    });
    const fullTrackApproval = {
      ...structuredClone(standardApproval),
      authorization_mode: 'full_track',
      content_version: contentVersionA,
      validation: {
        ...structuredClone(standardApproval.validation),
        runtime_payload: runtimePayloadPath,
        runtime_payload_sha256: runtimePayloadSha256,
        model_review: fullTrackReviewPath,
        model_review_sha256: fullTrackReviewSha256,
      },
      model_acceptances: [
        modelAcceptance(
          fullTrackInput,
          ['content_authorization'],
          'codex-task:full-track-authorization-a',
        ),
        modelAcceptance(
          fullTrackInput,
          ['content_authorization'],
          'codex-task:full-track-authorization-b',
        ),
      ],
    };
    delete fullTrackApproval.model_acceptance;
    writeJson(approvalPath, fullTrackApproval);
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'bind full-track runtime version'], {
      cwd: root,
    });
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));

    const runtimeShardPath =
      'reviews/runtime_payloads/current-full-track-runtime-001.json';
    const runtimeShard = {
      schema_version: 'card-make-runtime-card-shard.v1',
      track: 'cet4',
      card_records: currentCards,
    };
    writeJson(runtimeShardPath, runtimeShard);
    const runtimeShardSha256 = `sha256:${cryptoHashFile(
      path.join(root, runtimeShardPath),
    )}`;
    writeJson(runtimePayloadPath, {
      schema_version: 'card-make-runtime-payload-manifest.v1',
      source: runtimePayload.source,
      track: runtimePayload.track,
      content_version: contentVersionA,
      card_record_shards: [{
        path: runtimeShardPath,
        sha256: runtimeShardSha256,
        card_count: currentCards.length,
        first_card_id: currentCards[0].card_id,
        last_card_id: currentCards.at(-1).card_id,
      }],
      assets: [],
      release: null,
    });
    fullTrackApproval.validation.runtime_payload_sha256 =
      `sha256:${cryptoHashFile(path.join(root, runtimePayloadPath))}`;
    writeJson(approvalPath, fullTrackApproval);
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync(
      'git',
      ['commit', '-qm', 'replace direct runtime with tracked shard manifest'],
      {cwd: root},
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));

    const tamperedShard = structuredClone(runtimeShard);
    tamperedShard.card_records[0].dirty_shard_replay = true;
    writeJson(runtimeShardPath, tamperedShard);
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue =>
      issue.code === 'approval_runtime_payload_shard_not_committed_at_head'
      || issue.code === 'approval_runtime_payload_invalid'
    ));
    writeJson(runtimeShardPath, runtimeShard);

    fullTrackApproval.content_version = contentVersionB;
    writeJson(approvalPath, fullTrackApproval);
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'attempt full-track version replay'], {
      cwd: root,
    });
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'model_acceptance_input_scope_mismatch',
    ));

    writeJson(approvalPath, standardApproval);
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync('git', ['commit', '-qm', 'restore ordinary authorization'], {
      cwd: root,
    });

    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint: {
        ...currentFingerprint,
        digest: 'e'.repeat(64),
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_current_fingerprint_override_mismatch',
    ));

    fs.renameSync(
      path.join(root, 'scripts/audit_card_quality.mjs'),
      path.join(root, 'scripts/audit_card_quality.mjs.unavailable'),
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_current_audit_replay_unavailable',
    ));
    fs.renameSync(
      path.join(root, 'scripts/audit_card_quality.mjs.unavailable'),
      path.join(root, 'scripts/audit_card_quality.mjs'),
    );

    const restoreHeadFile = relativePath => {
      fs.writeFileSync(
        path.join(root, relativePath),
        execFileSync('git', ['show', `HEAD:${relativePath}`], {cwd: root}),
      );
    };
    const assertAuditAuthorityRejected = () => {
      const authorityResult = validateCurrentApprovalRecordReference({
        root,
        approvalPath,
        currentFingerprint,
      });
      assert.equal(authorityResult.ok, false);
      assert.ok(authorityResult.issues.some(
        issue => issue.code === 'approval_current_audit_replay_unavailable',
      ));
    };

    const snapshotProbe = path.join(root, 'snapshot-probe.txt');
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
      beforeFinalConsistencyCheck: () => {
        fs.writeFileSync(snapshotProbe, 'staged during validation\n');
        execFileSync('git', ['add', '--', 'snapshot-probe.txt'], {cwd: root});
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_git_snapshot_changed_during_validation',
    ));
    execFileSync(
      'git',
      ['restore', '--staged', '--', 'snapshot-probe.txt'],
      {cwd: root},
    );
    fs.unlinkSync(snapshotProbe);

    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
      beforeFinalConsistencyCheck: () => {
        fs.appendFileSync(
          path.join(root, 'reviews/audit_scopes/current-approval-audit.json'),
          '\n',
        );
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_authorization_file_changed_during_validation',
    ));
    restoreHeadFile('reviews/audit_scopes/current-approval-audit.json');

    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
      beforeFinalConsistencyCheck: () => {
        fs.appendFileSync(
          path.join(
            root,
            'card_boxes_json/card_boxes_seed_cet4_fixture_0000.json',
          ),
          '\n',
        );
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_current_corpus_changed_during_validation',
    ));
    restoreHeadFile(
      'card_boxes_json/card_boxes_seed_cet4_fixture_0000.json',
    );

    fs.appendFileSync(
      path.join(root, 'scripts/audit_card_quality.mjs'),
      '\n// uncommitted authority drift\n',
    );
    assertAuditAuthorityRejected();
    restoreHeadFile('scripts/audit_card_quality.mjs');

    fs.appendFileSync(
      path.join(root, 'scripts/audit_card_quality.mjs'),
      '\n// staged authority drift\n',
    );
    execFileSync(
      'git',
      ['add', '--', 'scripts/audit_card_quality.mjs'],
      {cwd: root},
    );
    restoreHeadFile('scripts/audit_card_quality.mjs');
    assertAuditAuthorityRejected();
    execFileSync(
      'git',
      ['restore', '--staged', '--', 'scripts/audit_card_quality.mjs'],
      {cwd: root},
    );

    fs.chmodSync(path.join(root, 'scripts/audit_card_quality.mjs'), 0o755);
    assertAuditAuthorityRejected();
    fs.chmodSync(path.join(root, 'scripts/audit_card_quality.mjs'), 0o644);

    fs.renameSync(
      path.join(root, 'scripts/audit_card_quality.mjs'),
      path.join(root, 'scripts/audit_card_quality.mjs.target'),
    );
    fs.symlinkSync(
      'audit_card_quality.mjs.target',
      path.join(root, 'scripts/audit_card_quality.mjs'),
    );
    assertAuditAuthorityRejected();
    fs.unlinkSync(path.join(root, 'scripts/audit_card_quality.mjs'));
    fs.renameSync(
      path.join(root, 'scripts/audit_card_quality.mjs.target'),
      path.join(root, 'scripts/audit_card_quality.mjs'),
    );

    fs.appendFileSync(
      path.join(root, 'spec/card-quality-audit.json'),
      '\n',
    );
    assertAuditAuthorityRejected();
    restoreHeadFile('spec/card-quality-audit.json');

    const forgedApprovalAudit = structuredClone(currentScopedReport);
    delete forgedApprovalAudit.audit_version;
    forgedApprovalAudit.scope_summary.by_rule = {};
    delete forgedApprovalAudit.scoped_card_issue_index;
    writeJson(
      'reviews/audit_scopes/current-approval-audit.json',
      forgedApprovalAudit,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_audit_report_replay_mismatch',
    ));
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_audit_report_not_committed_at_head',
    ));
    writeJson(
      'reviews/audit_scopes/current-approval-audit.json',
      currentScopedReport,
    );

    const forgedLinkedAudit = structuredClone(currentScopedReport);
    delete forgedLinkedAudit.mode;
    forgedLinkedAudit.scope.card_dir = 'forged_card_dir';
    writeJson(
      'reviews/audit_scopes/current-review-audit.json',
      forgedLinkedAudit,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue =>
        issue.code ===
        'approval_linked_self_review_audit_replay_mismatch',
    ));
    assert.ok(result.issues.some(
      issue =>
        issue.code ===
        'approval_linked_self_review_audit_not_committed_at_head',
    ));
    writeJson(
      'reviews/audit_scopes/current-review-audit.json',
      currentScopedReport,
    );

    fs.appendFileSync(
      path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
      '\n',
    );
    execFileSync(
      'git',
      ['add', '--', 'reviews/audit_scopes/current-review-audit.json'],
      {cwd: root},
    );
    writeJson(
      'reviews/audit_scopes/current-review-audit.json',
      currentScopedReport,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue =>
        issue.code ===
        'approval_linked_self_review_audit_not_committed_at_head',
    ));
    execFileSync(
      'git',
      ['restore', '--staged', '--', 'reviews/audit_scopes/current-review-audit.json'],
      {cwd: root},
    );

    fs.chmodSync(
      path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
      0o755,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue =>
        issue.code ===
        'approval_linked_self_review_audit_not_committed_at_head',
    ));
    fs.chmodSync(
      path.join(root, 'reviews/audit_scopes/current-review-audit.json'),
      0o644,
    );

    const validApproval = JSON.parse(fs.readFileSync(
      path.join(root, approvalPath),
      'utf8',
    ));
    const incompleteApproval = structuredClone(validApproval);
    delete incompleteApproval.summary;
    writeJson(approvalPath, incompleteApproval);
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_record_summary_missing',
    ));
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_record_not_committed_at_head',
    ));
    writeJson(approvalPath, validApproval);

    const validLinkedReview = JSON.parse(fs.readFileSync(
      path.join(root, 'reviews/agent_self_review/current-review.json'),
      'utf8',
    ));
    const blockedLinkedReview = structuredClone(validLinkedReview);
    blockedLinkedReview.batch_review.status = 'blocked';
    writeJson(
      'reviews/agent_self_review/current-review.json',
      blockedLinkedReview,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_linked_standard_review_batch_invalid',
    ));
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_linked_self_review_not_committed_at_head',
    ));
    writeJson('reviews/agent_self_review/current-review.json', validLinkedReview);

    const emptyMetadataReview = structuredClone(validLinkedReview);
    emptyMetadataReview.cards[0].quality_metadata = {};
    writeJson(
      'reviews/agent_self_review/current-review.json',
      emptyMetadataReview,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_linked_standard_review_current_corpus_mismatch',
    ));

    const staleSnapshotReview = structuredClone(validLinkedReview);
    staleSnapshotReview.cards[0].quality_metadata.exam_value =
      '这是一条结构完整但与当前卡片不同的陈旧审批快照。';
    writeJson(
      'reviews/agent_self_review/current-review.json',
      staleSnapshotReview,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_linked_standard_review_current_corpus_mismatch',
    ));

    const scalarMismatchReview = structuredClone(validLinkedReview);
    scalarMismatchReview.scope.track = 'cet6';
    writeJson(
      'reviews/agent_self_review/current-review.json',
      scalarMismatchReview,
    );
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code ===
        'approval_linked_self_review_scalar_scope_mismatch',
    ));
    writeJson('reviews/agent_self_review/current-review.json', validLinkedReview);

    const staleDigest = 'f'.repeat(64);
    writeJson(
      'reviews/audit_scopes/current-review-audit.json',
      {
        ...structuredClone(currentScopedReport),
        corpus_fingerprint: {
          ...structuredClone(currentScopedReport.corpus_fingerprint),
          digest: staleDigest,
        },
      },
    );
    const linkedReview = structuredClone(validLinkedReview);
    linkedReview.quality_audit.corpus_fingerprint = staleDigest;
    writeJson('reviews/agent_self_review/current-review.json', linkedReview);
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_linked_self_review_not_current',
    ));

    for (const invalidPath of [
      'reviews/approved_batches/TEMPLATE.json',
      'reviews/approved_batches/../forged.json',
    ]) {
      result = validateCurrentApprovalRecordReference({
        root,
        approvalPath: invalidPath,
        currentFingerprint,
      });
      assert.equal(result.ok, false);
      assert.equal(result.issues[0].code, 'approval_record_path_invalid');
    }

    const symlinkPath = path.join(
      root,
      'reviews/approved_batches/symlink-approval.json',
    );
    fs.symlinkSync('current-approval.json', symlinkPath);
    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath: 'reviews/approved_batches/symlink-approval.json',
      currentFingerprint,
    });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'approval_record_not_regular_file');
    fs.unlinkSync(symlinkPath);

    const blockedCards = structuredClone(currentCards);
    blockedCards[0].interaction_id = 'multiple_choice';
    writeJson('card_boxes_json/card_boxes_seed_cet4_fixture_0000.json', {
      cards: blockedCards,
    });
    const blockedFingerprint = computeCardCorpusFingerprint(root);
    const blockedOraclePath =
      'reviews/audit_scopes/blocked-current-oracle.json';
    try {
      execFileSync(
        process.execPath,
        [
          'scripts/audit_card_quality.mjs',
          '--scope-card-ids',
          cardIds.join(','),
          '--write-scope-report',
          blockedOraclePath,
        ],
        {cwd: root, encoding: 'utf8'},
      );
      assert.fail('hard-blocked scoped audit must exit non-zero');
    } catch (error) {
      assert.equal(error.status, 1);
    }
    const blockedOracle = JSON.parse(fs.readFileSync(
      path.join(root, blockedOraclePath),
      'utf8',
    ));
    assert.ok(
      blockedOracle.scope_summary.by_severity.hard_blocker > 0,
    );
    fs.unlinkSync(path.join(root, blockedOraclePath));

    const forgedClearReport = structuredClone(blockedOracle);
    forgedClearReport.ok = true;
    forgedClearReport.scope_summary.issue_count = 0;
    for (const severity of Object.keys(
      forgedClearReport.scope_summary.by_severity,
    )) {
      forgedClearReport.scope_summary.by_severity[severity] = 0;
    }
    for (const ruleId of Object.keys(
      forgedClearReport.scope_summary.by_rule,
    )) {
      forgedClearReport.scope_summary.by_rule[ruleId] = 0;
    }
    for (const entry of Object.values(
      forgedClearReport.scoped_card_issue_index,
    )) {
      entry.issue_count = 0;
      for (const severity of Object.keys(entry.by_severity)) {
        entry.by_severity[severity] = 0;
      }
      entry.by_rule = {};
    }
    forgedClearReport.scoped_hard_blocker_issues = [];
    writeJson(
      'reviews/audit_scopes/current-approval-audit.json',
      forgedClearReport,
    );
    writeJson(
      'reviews/audit_scopes/current-review-audit.json',
      forgedClearReport,
    );
    const blockedReview = structuredClone(validLinkedReview);
    blockedReview.cards[0].interaction_id = 'multiple_choice';
    blockedReview.quality_audit.corpus_fingerprint =
      blockedFingerprint.digest;
    blockedReview.quality_audit.scope_summary =
      structuredClone(forgedClearReport.scope_summary);
    writeJson(
      'reviews/agent_self_review/current-review.json',
      blockedReview,
    );
    const blockedApproval = structuredClone(validApproval);
    blockedApproval.card_quality_audit.corpus_fingerprint =
      blockedFingerprint.digest;
    blockedApproval.card_quality_audit.scope_summary =
      structuredClone(forgedClearReport.scope_summary);
    writeJson(approvalPath, blockedApproval);
    execFileSync('git', ['add', '--all'], {cwd: root});
    execFileSync(
      'git',
      ['commit', '-qm', 'fixture forged current digest evidence'],
      {cwd: root},
    );

    result = validateCurrentApprovalRecordReference({
      root,
      approvalPath,
      currentFingerprint: blockedFingerprint,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(
      issue => issue.code === 'approval_audit_report_replay_mismatch',
    ));
    assert.ok(result.issues.some(
      issue =>
        issue.code ===
        'approval_linked_self_review_audit_replay_mismatch',
    ));
    assert.equal(
      result.issues.some(issue => issue.code.endsWith('_not_committed_at_head')),
      false,
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
