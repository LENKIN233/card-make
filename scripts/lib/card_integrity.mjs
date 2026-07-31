import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const REVIEW_STATUS_PARITY_EXCEPTION = Object.freeze({
  excluded_fields: ['review_status'],
  reason: 'card_authoring_status_and_self_review_snapshot_status_are_distinct; both remain independently schema-validated',
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values) {
  return [...new Set(values)];
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return unique(left.filter(value => rightSet.has(value)));
}

function issue(code, card, details = {}) {
  return {
    code,
    card_id: typeof card?.card_id === 'string' ? card.card_id : null,
    ...details,
  };
}

function schemaEnum(schema, pathParts) {
  let value = schema;
  for (const part of pathParts) value = value?.[part];
  return Array.isArray(value?.enum) ? value.enum : [];
}

/**
 * Loads the active schema and content-quality contract into a serializable policy.
 * Shared enums are intersected so a candidate must satisfy both authorities.
 */
export function loadIntegrityPolicy(root) {
  const schemaPath = path.join(root, 'spec', 'card-metadata.schema.json');
  const qualityPath = path.join(root, 'spec', 'content-quality-contract.json');
  const schema = readJson(schemaPath);
  const quality = readJson(qualityPath);
  const metadataSchema = schema.properties?.quality_metadata || {};
  const metadataProperties = metadataSchema.properties || {};

  const schemaWeakPointTags = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'weak_point_tags', 'items',
  ]);
  const schemaDifficulties = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'difficulty', 'properties', 'primary',
  ]);
  const schemaPrototypes = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'card_prototype',
  ]);
  const schemaSourceTypes = schemaEnum(schema, [
    'properties', 'quality_metadata', 'properties', 'material', 'properties', 'text_source_type',
  ]);

  return {
    schema_paths: {
      card_metadata: path.relative(root, schemaPath).replaceAll('\\', '/'),
      content_quality: path.relative(root, qualityPath).replaceAll('\\', '/'),
    },
    card_required_fields: [...(schema.required || [])],
    quality_metadata_required_fields: [...(metadataSchema.required || [])],
    difficulty_required_fields: [...(metadataProperties.difficulty?.required || [])],
    material_required_fields: [...(metadataProperties.material?.required || [])],
    constraints: {
      card_id_pattern: schema.properties?.card_id?.pattern || null,
      main_training_goal_min_length: metadataProperties.main_training_goal?.minLength || 0,
      exam_value_min_length: metadataProperties.exam_value?.minLength || 0,
      weak_point_tags_min_items: metadataProperties.weak_point_tags?.minItems || 0,
    },
    allowed: {
      tracks: [...(schema.properties?.track?.enum || [])],
      interactions: [...(schema.properties?.interaction_id?.enum || [])],
      weak_point_tags: intersect(
        schemaWeakPointTags,
        quality.default_user_model?.weak_point_tags || [],
      ),
      difficulties: intersect(
        schemaDifficulties,
        quality.difficulty_policy?.tiers || [],
      ),
      card_prototypes: intersect(
        schemaPrototypes,
        quality.allowed_card_prototypes || [],
      ),
      text_source_types: intersect(
        schemaSourceTypes,
        quality.source_policy?.allowed_text_source_types || [],
      ),
      box_progression_roles: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'box_progression_role',
      ]),
      review_statuses: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'review_status',
      ]),
      audio_generation_methods: schemaEnum(schema, [
        'properties', 'quality_metadata', 'properties', 'material', 'properties', 'audio_generation_method',
      ]),
    },
  };
}

function pushInvalidMetadata(issues, card, pathName, reason, actual, extra = {}) {
  issues.push(issue('candidate_quality_metadata_invalid', card, {
    path: pathName,
    reason,
    actual,
    ...extra,
  }));
}

function validateOptionalString(issues, card, object, field, pathName) {
  if (hasOwn(object, field) && typeof object[field] !== 'string') {
    pushInvalidMetadata(issues, card, pathName, 'must_be_string', object[field]);
  }
}

function validateOptionalBoolean(issues, card, object, field, pathName) {
  if (hasOwn(object, field) && typeof object[field] !== 'boolean') {
    pushInvalidMetadata(issues, card, pathName, 'must_be_boolean', object[field]);
  }
}

/**
 * Validates the card-metadata schema envelope and quality_metadata content.
 * Legacy cards without quality_metadata are skipped unless required=true.
 */
export function validateQualityMetadata(card, policy, {required = false} = {}) {
  const issues = [];
  const metadataPresent = hasOwn(card, 'quality_metadata');

  if (!metadataPresent) {
    if (required) {
      issues.push(issue('candidate_quality_metadata_missing', card, {
        path: 'quality_metadata',
        required,
      }));
    }
    return {ok: issues.length === 0, issues, present: false, skipped: !required};
  }

  for (const field of policy.card_required_fields || []) {
    if (!hasOwn(card, field)) {
      issues.push(issue('candidate_card_schema_required_field_missing', card, {
        path: field,
        field,
      }));
    }
  }

  if (typeof card.card_id !== 'string' || (
    policy.constraints?.card_id_pattern &&
    !(new RegExp(policy.constraints.card_id_pattern)).test(card.card_id)
  )) {
    issues.push(issue('candidate_card_id_invalid', card, {
      path: 'card_id',
      actual: card.card_id,
      pattern: policy.constraints?.card_id_pattern || null,
    }));
  }

  if (!(policy.allowed?.tracks || []).includes(card.track)) {
    issues.push(issue('candidate_track_invalid', card, {
      path: 'track',
      actual: card.track,
      allowed: policy.allowed?.tracks || [],
    }));
  }

  if (!isObject(card.knowledge_ref)) {
    issues.push(issue('candidate_knowledge_ref_invalid', card, {
      path: 'knowledge_ref',
      reason: 'must_be_object',
      actual: card.knowledge_ref,
    }));
  }

  if (!(policy.allowed?.interactions || []).includes(card.interaction_id)) {
    issues.push(issue('candidate_interaction_id_invalid', card, {
      path: 'interaction_id',
      actual: card.interaction_id,
      allowed: policy.allowed?.interactions || [],
    }));
  }

  const metadata = card.quality_metadata;
  if (!isObject(metadata)) {
    pushInvalidMetadata(issues, card, 'quality_metadata', 'must_be_object', metadata);
    return {ok: false, issues, present: true, skipped: false};
  }

  for (const field of policy.quality_metadata_required_fields || []) {
    if (!hasOwn(metadata, field)) {
      issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
        path: `quality_metadata.${field}`,
        field,
      }));
    }
  }

  const mainGoalMinimum = policy.constraints?.main_training_goal_min_length || 0;
  if (typeof metadata.main_training_goal !== 'string') {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.main_training_goal',
      'must_be_string',
      metadata.main_training_goal,
    );
  } else if (metadata.main_training_goal.length < mainGoalMinimum) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.main_training_goal',
      'min_length',
      metadata.main_training_goal,
      {minimum: mainGoalMinimum},
    );
  }

  if (hasOwn(metadata, 'secondary_training_goals')) {
    if (!Array.isArray(metadata.secondary_training_goals)) {
      pushInvalidMetadata(
        issues,
        card,
        'quality_metadata.secondary_training_goals',
        'must_be_array',
        metadata.secondary_training_goals,
      );
    } else {
      metadata.secondary_training_goals.forEach((goal, index) => {
        if (typeof goal !== 'string') {
          pushInvalidMetadata(
            issues,
            card,
            `quality_metadata.secondary_training_goals[${index}]`,
            'must_be_string',
            goal,
          );
        }
      });
    }
  }

  const weakTags = metadata.weak_point_tags;
  if (!Array.isArray(weakTags)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.weak_point_tags',
      'must_be_array',
      weakTags,
    );
  } else {
    const minimum = policy.constraints?.weak_point_tags_min_items || 0;
    if (weakTags.length < minimum) {
      pushInvalidMetadata(
        issues,
        card,
        'quality_metadata.weak_point_tags',
        'min_items',
        weakTags,
        {minimum},
      );
    }
    weakTags.forEach((tag, index) => {
      if (!(policy.allowed?.weak_point_tags || []).includes(tag)) {
        issues.push(issue('invalid_weak_point_tag', card, {
          path: `quality_metadata.weak_point_tags[${index}]`,
          tag,
          allowed: policy.allowed?.weak_point_tags || [],
        }));
      }
    });
  }

  const difficulty = metadata.difficulty;
  if (!isObject(difficulty)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.difficulty',
      'must_be_object',
      difficulty,
    );
  } else {
    for (const field of policy.difficulty_required_fields || []) {
      if (!hasOwn(difficulty, field)) {
        issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
          path: `quality_metadata.difficulty.${field}`,
          field,
        }));
      }
    }
    if (!(policy.allowed?.difficulties || []).includes(difficulty.primary)) {
      issues.push(issue('invalid_difficulty', card, {
        path: 'quality_metadata.difficulty.primary',
        difficulty: difficulty.primary,
        allowed: policy.allowed?.difficulties || [],
      }));
    }
    if (hasOwn(difficulty, 'secondary')) {
      if (!Array.isArray(difficulty.secondary)) {
        pushInvalidMetadata(
          issues,
          card,
          'quality_metadata.difficulty.secondary',
          'must_be_array',
          difficulty.secondary,
        );
      } else {
        difficulty.secondary.forEach((tier, index) => {
          if (!(policy.allowed?.difficulties || []).includes(tier)) {
            issues.push(issue('invalid_difficulty', card, {
              path: `quality_metadata.difficulty.secondary[${index}]`,
              difficulty: tier,
              allowed: policy.allowed?.difficulties || [],
            }));
          }
        });
      }
    }
    validateOptionalString(
      issues,
      card,
      difficulty,
      'advanced_in_foundation_reason',
      'quality_metadata.difficulty.advanced_in_foundation_reason',
    );
  }

  if (!(policy.allowed?.card_prototypes || []).includes(metadata.card_prototype)) {
    issues.push(issue('invalid_card_prototype', card, {
      path: 'quality_metadata.card_prototype',
      card_prototype: metadata.card_prototype,
      allowed: policy.allowed?.card_prototypes || [],
    }));
  }

  const material = metadata.material;
  if (!isObject(material)) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.material',
      'must_be_object',
      material,
    );
  } else {
    for (const field of policy.material_required_fields || []) {
      if (!hasOwn(material, field)) {
        issues.push(issue('candidate_quality_metadata_required_field_missing', card, {
          path: `quality_metadata.material.${field}`,
          field,
        }));
      }
    }
    if (!(policy.allowed?.text_source_types || []).includes(material.text_source_type)) {
      issues.push(issue('invalid_text_source_type', card, {
        path: 'quality_metadata.material.text_source_type',
        text_source_type: material.text_source_type,
        allowed: policy.allowed?.text_source_types || [],
      }));
    }
    validateOptionalString(
      issues,
      card,
      material,
      'source_note',
      'quality_metadata.material.source_note',
    );
    if (
      hasOwn(material, 'audio_generation_method') &&
      !(policy.allowed?.audio_generation_methods || []).includes(material.audio_generation_method)
    ) {
      issues.push(issue('invalid_audio_generation_method', card, {
        path: 'quality_metadata.material.audio_generation_method',
        audio_generation_method: material.audio_generation_method,
        allowed: policy.allowed?.audio_generation_methods || [],
      }));
    }
    validateOptionalBoolean(
      issues,
      card,
      material,
      'tts_text_reviewed',
      'quality_metadata.material.tts_text_reviewed',
    );
    validateOptionalBoolean(
      issues,
      card,
      material,
      'tts_audio_reviewed',
      'quality_metadata.material.tts_audio_reviewed',
    );
  }

  const examValueMinimum = policy.constraints?.exam_value_min_length || 0;
  if (typeof metadata.exam_value !== 'string') {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.exam_value',
      'must_be_string',
      metadata.exam_value,
    );
  } else if (metadata.exam_value.length < examValueMinimum) {
    pushInvalidMetadata(
      issues,
      card,
      'quality_metadata.exam_value',
      'min_length',
      metadata.exam_value,
      {minimum: examValueMinimum},
    );
  }

  if (!(policy.allowed?.box_progression_roles || []).includes(metadata.box_progression_role)) {
    issues.push(issue('invalid_box_progression_role', card, {
      path: 'quality_metadata.box_progression_role',
      box_progression_role: metadata.box_progression_role,
      allowed: policy.allowed?.box_progression_roles || [],
    }));
  }

  if (!(policy.allowed?.review_statuses || []).includes(metadata.review_status)) {
    issues.push(issue('invalid_review_status', card, {
      path: 'quality_metadata.review_status',
      review_status: metadata.review_status,
      allowed: policy.allowed?.review_statuses || [],
    }));
  }

  return {ok: issues.length === 0, issues, present: true, skipped: false};
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Validates the runtime elimination payload, the local preview projection, and
 * answer truth. Runtime identity is elimination_items[].id and correct_items
 * contains those IDs. Untouched corpus migrations may opt into the explicit
 * text/is_correct compatibility mode; changed candidates must not.
 */
export function validateEliminationIntegrity(
  card,
  {
    requireLegacyMirror = true,
    allowLegacyContract = false,
  } = {},
) {
  const issues = [];
  if (card?.interaction_id !== 'elimination') {
    return {ok: true, issues, applicable: false};
  }

  const canonical = card.elimination_items;
  const canonicalIsNonEmptyArray = Array.isArray(canonical) && canonical.length > 0;
  if (!canonicalIsNonEmptyArray) {
    issues.push(issue(
      canonical === undefined || canonical === null || (Array.isArray(canonical) && canonical.length === 0)
        ? 'elimination_items_missing'
        : 'elimination_items_invalid',
      card,
      {
        path: 'elimination_items',
        reason: Array.isArray(canonical) ? 'must_not_be_empty' : 'must_be_non_empty_array',
      },
    ));
  }

  const legacyCompatibilityShape = canonicalIsNonEmptyArray && canonical.every(item =>
    isObject(item) &&
    (typeof item.id !== 'string' || item.id.trim().length === 0) &&
    typeof item.text === 'string' &&
    item.text.trim().length > 0 &&
    typeof item.is_correct === 'boolean'
  );
  const compatibilityMode = allowLegacyContract && legacyCompatibilityShape;
  const mode = compatibilityMode
    ? 'legacy_text_answer_compatibility'
    : 'runtime_id_contract';

  const validCanonicalItems = [];
  if (Array.isArray(canonical)) {
    canonical.forEach((item, index) => {
      if (!isObject(item)) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}]`,
          reason: 'must_be_object',
        }));
        return;
      }
      if (typeof item.text !== 'string' || item.text.trim().length === 0) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].text`,
          reason: 'must_be_non_empty_string',
          actual: item.text,
        }));
      }
      if (compatibilityMode && typeof item.is_correct !== 'boolean') {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].is_correct`,
          reason: 'must_be_boolean',
          actual: item.is_correct,
        }));
      }
      if (!compatibilityMode && (typeof item.id !== 'string' || item.id.trim().length === 0)) {
        issues.push(issue('elimination_items_invalid', card, {
          path: `elimination_items[${index}].id`,
          reason: 'runtime_contract_requires_non_empty_string_id',
          actual: item.id,
        }));
      }
      if (
        typeof item.text === 'string' &&
        item.text.trim().length > 0 &&
        (
          compatibilityMode
            ? typeof item.is_correct === 'boolean'
            : typeof item.id === 'string' && item.id.trim().length > 0
        )
      ) {
        validCanonicalItems.push(item);
      }
    });
  }

  const duplicateCanonicalIdentities = duplicateValues(
    (Array.isArray(canonical) ? canonical : []).map(item => {
      if (compatibilityMode) {
        return typeof item?.text === 'string' ? item.text.trim() : null;
      }
      return typeof item?.id === 'string' ? item.id.trim() : null;
    }),
  );
  if (duplicateCanonicalIdentities.length > 0) {
    issues.push(issue('elimination_duplicate_item_identity', card, {
      path: 'elimination_items',
      identities: duplicateCanonicalIdentities,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  const legacyMirror = card.eliminable_items;
  if (requireLegacyMirror && (!Array.isArray(legacyMirror) || legacyMirror.length === 0)) {
    issues.push(issue('elimination_legacy_mirror_missing', card, {
      path: 'eliminable_items',
      reason: 'local_preview_compatibility_requires_non_empty_mirror',
    }));
  }

  const validLegacyItems = [];
  if (Array.isArray(legacyMirror)) {
    legacyMirror.forEach((item, index) => {
      if (!isObject(item)) {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}]`,
          reason: 'must_be_object',
        }));
        return;
      }
      if (typeof item.text !== 'string' || item.text.trim().length === 0) {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}].text`,
          reason: 'must_be_non_empty_string',
          actual: item.text,
        }));
      }
      if (typeof item.is_correct !== 'boolean') {
        issues.push(issue('elimination_legacy_mirror_invalid', card, {
          path: `eliminable_items[${index}].is_correct`,
          reason: 'must_be_boolean',
          actual: item.is_correct,
        }));
      }
      if (
        typeof item.text === 'string' &&
        item.text.trim().length > 0 &&
        typeof item.is_correct === 'boolean'
      ) {
        validLegacyItems.push(item);
      }
    });
  }

  if (Array.isArray(legacyMirror) && Array.isArray(canonical)) {
    if (compatibilityMode) {
      if (!isDeepStrictEqual(legacyMirror, canonical)) {
        issues.push(issue('elimination_legacy_mirror_mismatch', card, {
          path: 'eliminable_items',
          canonical_path: 'elimination_items',
          reason: 'legacy_compatibility_requires_exact_mirror',
        }));
      }
    } else {
      const projectionMismatches = [];
      if (legacyMirror.length !== canonical.length) {
        projectionMismatches.push({
          reason: 'length_mismatch',
          canonical_length: canonical.length,
          legacy_length: legacyMirror.length,
        });
      }
      const sharedLength = Math.min(legacyMirror.length, canonical.length);
      for (let index = 0; index < sharedLength; index += 1) {
        if (legacyMirror[index]?.text !== canonical[index]?.text) {
          projectionMismatches.push({
            index,
            reason: 'text_mismatch',
            canonical_text: canonical[index]?.text,
            legacy_text: legacyMirror[index]?.text,
          });
        }
      }
      if (projectionMismatches.length > 0) {
        issues.push(issue('elimination_legacy_mirror_mismatch', card, {
          path: 'eliminable_items',
          canonical_path: 'elimination_items',
          reason: 'legacy_preview_must_project_canonical_items_by_position',
          mismatches: projectionMismatches,
        }));
      }
    }
  }

  const correctItems = card.answer_key?.correct_items;
  const correctItemsIsNonEmptyArray = Array.isArray(correctItems) && correctItems.length > 0;
  if (!correctItemsIsNonEmptyArray) {
    issues.push(issue('elimination_correct_items_missing', card, {
      path: 'answer_key.correct_items',
      reason: Array.isArray(correctItems) ? 'must_not_be_empty' : 'must_be_non_empty_array',
    }));
  }

  const validCorrectItems = [];
  if (Array.isArray(correctItems)) {
    correctItems.forEach((value, index) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        issues.push(issue('elimination_correct_items_invalid', card, {
          path: `answer_key.correct_items[${index}]`,
          reason: 'must_be_non_empty_string',
          actual: value,
        }));
      } else {
        validCorrectItems.push(value);
      }
    });
  }

  const duplicateCorrectIdentities = duplicateValues(validCorrectItems.map(value => value.trim()));
  if (duplicateCorrectIdentities.length > 0) {
    issues.push(issue('elimination_duplicate_item_identity', card, {
      path: 'answer_key.correct_items',
      identities: duplicateCorrectIdentities,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  const canonicalIdentities = new Set(validCanonicalItems.map(item =>
    compatibilityMode ? item.text : item.id
  ));
  const staleCorrectItems = unique(validCorrectItems.filter(value => !canonicalIdentities.has(value)));
  if (staleCorrectItems.length > 0) {
    issues.push(issue('elimination_correct_items_not_in_items', card, {
      path: 'answer_key.correct_items',
      values: staleCorrectItems,
      identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
    }));
  }

  if (correctItemsIsNonEmptyArray && canonicalIsNonEmptyArray) {
    let expected = [];
    let truthComparable = false;
    if (compatibilityMode) {
      expected = unique(validCanonicalItems.filter(item => item.is_correct).map(item => item.text));
      truthComparable = validCanonicalItems.length === canonical.length;
    } else if (
      Array.isArray(legacyMirror) &&
      legacyMirror.length === canonical.length &&
      validLegacyItems.length === legacyMirror.length
    ) {
      expected = unique(canonical
        .filter((_item, index) => legacyMirror[index].is_correct)
        .map(item => item.id)
        .filter(value => typeof value === 'string' && value.trim().length > 0));
      truthComparable = validCanonicalItems.length === canonical.length;
    }
    const actual = unique(validCorrectItems);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter(value => !actualSet.has(value));
    const unexpected = actual.filter(value => !expectedSet.has(value));
    if (
      truthComparable &&
      (missing.length > 0 || unexpected.length > 0 || duplicateCorrectIdentities.length > 0)
    ) {
      issues.push(issue('elimination_correct_items_truth_mismatch', card, {
        path: 'answer_key.correct_items',
        expected,
        actual: validCorrectItems,
        missing,
        unexpected,
        comparison: 'order_independent_set_with_unique_identities',
        identity_kind: compatibilityMode ? 'legacy_text' : 'runtime_id',
      }));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    applicable: true,
    mode,
    legacy_compatible: compatibilityMode,
  };
}

export function metadataParityProjection(metadata) {
  if (!isObject(metadata)) return metadata;
  const {review_status: _reviewStatus, ...comparable} = metadata;
  return comparable;
}

export function deepEqualQualityMetadata(left, right) {
  return isDeepStrictEqual(metadataParityProjection(left), metadataParityProjection(right));
}

function differencePaths(left, right, currentPath = 'quality_metadata') {
  if (isDeepStrictEqual(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) return [currentPath];
  if (isObject(left) && isObject(right)) {
    const keys = unique([...Object.keys(left), ...Object.keys(right)]).sort();
    return keys.flatMap(key => differencePaths(left[key], right[key], `${currentPath}.${key}`));
  }
  return [currentPath];
}

function normalizeChangedCards(input) {
  const normalized = [];
  for (const item of asArray(input)) {
    if (Array.isArray(item?.cards)) {
      for (const card of item.cards) normalized.push({card, path: item.path || null});
      continue;
    }
    if (isObject(item?.card)) {
      normalized.push({card: item.card, path: item.path || item.file || null});
      continue;
    }
    normalized.push({card: item, path: item?.path || item?.file || null});
  }
  return normalized;
}

function normalizeReviewCards(input) {
  const normalized = [];
  for (const item of asArray(input)) {
    const source = isObject(item?.record) ? item.record : item;
    const sourcePath = item?.path || item?.file || item?.source || null;
    if (Array.isArray(source?.cards)) {
      for (const reviewCard of source.cards) normalized.push({reviewCard, path: sourcePath});
      continue;
    }
    if (isObject(source?.card)) {
      normalized.push({reviewCard: source.card, path: sourcePath});
      continue;
    }
    normalized.push({reviewCard: source, path: sourcePath});
  }
  return normalized;
}

/**
 * Validates changed cards against changed self-review snapshots without any Git
 * or filesystem coupling. Every metadata field is compared deeply except the
 * explicitly documented review_status lifecycle boundary.
 */
export function validateChangedCardSelfReviewParity(
  changedCards,
  changedReviewRecords,
  policy,
  {required = true} = {},
) {
  const issues = [];
  const cards = normalizeChangedCards(changedCards);
  const reviewCards = normalizeReviewCards(changedReviewRecords);
  const matchesByCardId = new Map();

  for (const entry of reviewCards) {
    const cardId = entry.reviewCard?.card_id;
    if (typeof cardId !== 'string') continue;
    const matches = matchesByCardId.get(cardId) || [];
    matches.push(entry);
    matchesByCardId.set(cardId, matches);
  }

  const stats = {
    changed_cards: cards.length,
    changed_self_review_cards: reviewCards.length,
    matched: 0,
    missing: 0,
    ambiguous: 0,
    metadata_mismatches: 0,
    parity_exception: REVIEW_STATUS_PARITY_EXCEPTION,
  };

  for (const entry of cards) {
    const card = entry.card;
    const cardValidation = validateQualityMetadata(card, policy, {required});
    issues.push(...cardValidation.issues.map(record => ({
      ...record,
      artifact: 'candidate_card',
      card_path: entry.path,
    })));

    const matches = matchesByCardId.get(card?.card_id) || [];
    if (matches.length === 0) {
      stats.missing += 1;
      if (required) {
        issues.push(issue('candidate_self_review_missing', card, {
          card_path: entry.path,
          message: 'Changed candidate cards require one changed self-review snapshot with the same card_id.',
        }));
      }
      continue;
    }
    if (matches.length > 1) {
      stats.ambiguous += 1;
      issues.push(issue('candidate_self_review_ambiguous', card, {
        card_path: entry.path,
        review_paths: matches.map(match => match.path),
        match_count: matches.length,
      }));
      continue;
    }

    stats.matched += 1;
    const match = matches[0];
    const reviewCard = match.reviewCard;
    const reviewCandidate = {...card};
    if (hasOwn(reviewCard, 'quality_metadata')) {
      reviewCandidate.quality_metadata = reviewCard.quality_metadata;
    } else {
      delete reviewCandidate.quality_metadata;
    }
    const reviewValidation = validateQualityMetadata(reviewCandidate, policy, {required});
    issues.push(...reviewValidation.issues.map(record => ({
      ...record,
      artifact: 'candidate_self_review',
      review_path: match.path,
    })));

    if (
      isObject(card?.quality_metadata) &&
      isObject(reviewCard?.quality_metadata) &&
      !deepEqualQualityMetadata(card.quality_metadata, reviewCard.quality_metadata)
    ) {
      stats.metadata_mismatches += 1;
      const cardComparable = metadataParityProjection(card.quality_metadata);
      const reviewComparable = metadataParityProjection(reviewCard.quality_metadata);
      issues.push(issue('candidate_self_review_metadata_mismatch', card, {
        card_path: entry.path,
        review_path: match.path,
        differing_paths: differencePaths(cardComparable, reviewComparable),
        parity_exception: REVIEW_STATUS_PARITY_EXCEPTION,
      }));
    }
  }

  return {ok: issues.length === 0, issues, stats};
}
