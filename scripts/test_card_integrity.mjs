import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  deepEqualQualityMetadata,
  loadIntegrityPolicy,
  validateChangedCardSelfReviewParity,
  validateEliminationIntegrity,
  validateQualityMetadata,
} from './lib/card_integrity.mjs';
import {buildEliminationContract} from './migrate_cards_to_softbook_contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = loadIntegrityPolicy(ROOT);

function clone(value) {
  return structuredClone(value);
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
