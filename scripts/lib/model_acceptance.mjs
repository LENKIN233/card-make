import crypto from 'node:crypto';

export const MODEL_ACCEPTANCE_SCHEMA = 'model-acceptance.v2';

export const MODEL_ACCEPTANCE_DECISIONS = Object.freeze([
  'accepted',
  'rejected',
]);

export const MODEL_ACCEPTANCE_CAPABILITIES = Object.freeze([
  'card_semantic_review',
  'content_authorization',
  'audio_perceptual_review',
  'destructive_change_review',
  'merge_authorization',
  'source_provenance_review',
]);

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const RFC3339_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$/;
const RUNTIME_MANIFEST_SCHEMA = 'card-make-runtime-payload-manifest.v1';
const RUNTIME_CARD_SHARD_SCHEMA = 'card-make-runtime-card-shard.v1';
const RUNTIME_SHARD_PATH_RE =
  /^reviews\/runtime_payloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function requireSha256(value, label) {
  const normalized = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? `sha256:${value}`
    : value;
  if (!SHA256_RE.test(String(normalized || ''))) {
    throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return normalized;
}

function normalizedScope(scope) {
  if (!isPlainObject(scope)) throw new Error('model acceptance scope must be an object');
  const cardIds = [...(scope.card_ids || [])].map(String).sort();
  const boxPrefixes = [...(scope.box_prefixes || [])].map(String).sort();
  if (
    cardIds.length === 0 ||
    new Set(cardIds).size !== cardIds.length ||
    new Set(boxPrefixes).size !== boxPrefixes.length
  ) {
    throw new Error('model acceptance scope must contain non-empty unique card_ids and unique box_prefixes');
  }
  return {
    track: scope.track ?? null,
    purpose: scope.purpose ?? null,
    library: scope.library ?? null,
    group: scope.group ?? null,
    box: scope.box ?? null,
    box_prefixes: boxPrefixes,
    card_ids: cardIds,
  };
}

export function buildModelAcceptanceInputSha256({
  additionalBindings = {},
  auditSha256,
  corpusFingerprint,
  decisionType,
  linkedReviewIdentity = null,
  scope,
} = {}) {
  if (!hasText(decisionType) || !/^[a-z][a-z0-9_]{2,95}$/.test(decisionType)) {
    throw new Error('model acceptance decisionType is invalid');
  }
  if (!isPlainObject(additionalBindings)) {
    throw new Error('model acceptance additionalBindings must be an object');
  }
  let linkedReview = null;
  if (linkedReviewIdentity !== null) {
    if (
      !isPlainObject(linkedReviewIdentity) ||
      !hasText(linkedReviewIdentity.path)
    ) {
      throw new Error('model acceptance linked review identity is invalid');
    }
    linkedReview = {
      path: linkedReviewIdentity.path,
      sha256: requireSha256(linkedReviewIdentity.sha256, 'linked review sha256'),
    };
  }
  const payload = canonicalize({
    schema_version: 'model-acceptance-input.v1',
    decision_type: decisionType,
    scope: normalizedScope(scope),
    corpus_fingerprint: requireSha256(corpusFingerprint, 'corpus fingerprint'),
    audit_sha256: requireSha256(auditSha256, 'audit sha256'),
    linked_review: linkedReview,
    additional_bindings: additionalBindings,
  });
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}

export function buildContentAuthorizationAdditionalBindings({
  authorizationMode,
  contentVersion,
} = {}) {
  const required = authorizationMode === 'full_track';
  if (!required && (contentVersion === undefined || contentVersion === null)) {
    return {};
  }
  if (!SHA256_RE.test(String(contentVersion || ''))) {
    throw new Error(
      `${required ? 'full-track ' : ''}content authorization content_version must be sha256:<64 lowercase hex characters>`,
    );
  }
  return {content_version: contentVersion};
}

export function resolveRuntimePayloadForIdentity(payload, {loadShard} = {}) {
  if (payload?.schema_version !== RUNTIME_MANIFEST_SCHEMA) return payload;
  if (
    !isPlainObject(payload.source) ||
    !hasText(payload.source.id) ||
    !hasText(payload.source.label) ||
    !['cet4', 'cet6'].includes(payload.track) ||
    !Array.isArray(payload.card_record_shards) ||
    payload.card_record_shards.length === 0 ||
    typeof loadShard !== 'function'
  ) {
    throw new Error('runtime payload manifest is incomplete');
  }
  const assets = payload.assets === undefined ? [] : payload.assets;
  if (!Array.isArray(assets)) {
    throw new Error('runtime payload manifest assets must be an array');
  }
  const paths = new Set();
  const cardRecords = [];
  let previousLastCardId = null;
  for (const descriptor of payload.card_record_shards) {
    if (
      !isPlainObject(descriptor) ||
      !RUNTIME_SHARD_PATH_RE.test(String(descriptor.path || '')) ||
      !SHA256_RE.test(String(descriptor.sha256 || '')) ||
      !Number.isSafeInteger(descriptor.card_count) ||
      descriptor.card_count <= 0 ||
      !/^\d{6}$/.test(String(descriptor.first_card_id || '')) ||
      !/^\d{6}$/.test(String(descriptor.last_card_id || '')) ||
      paths.has(descriptor.path)
    ) {
      throw new Error('runtime payload manifest shard descriptor is invalid');
    }
    paths.add(descriptor.path);
    const loaded = loadShard(descriptor.path);
    if (
      !isPlainObject(loaded) ||
      loaded.sha256 !== descriptor.sha256 ||
      !isPlainObject(loaded.payload) ||
      loaded.payload.schema_version !== RUNTIME_CARD_SHARD_SCHEMA ||
      loaded.payload.track !== payload.track ||
      !Array.isArray(loaded.payload.card_records) ||
      loaded.payload.card_records.length !== descriptor.card_count
    ) {
      throw new Error(`runtime payload shard is invalid: ${descriptor.path}`);
    }
    const shardIds = loaded.payload.card_records.map(card =>
      String(card?.card_id || '')
    );
    if (
      shardIds.some(cardId => !/^\d{6}$/.test(cardId)) ||
      new Set(shardIds).size !== shardIds.length ||
      shardIds.some((cardId, index) => index > 0 && cardId <= shardIds[index - 1]) ||
      shardIds[0] !== descriptor.first_card_id ||
      shardIds.at(-1) !== descriptor.last_card_id ||
      (previousLastCardId !== null && shardIds[0] <= previousLastCardId)
    ) {
      throw new Error(`runtime payload shard card range is invalid: ${descriptor.path}`);
    }
    previousLastCardId = shardIds.at(-1);
    cardRecords.push(...loaded.payload.card_records);
  }
  return {
    assets,
    card_records: cardRecords,
    content_version: payload.content_version,
    release: payload.release ?? null,
    source: payload.source,
    track: payload.track,
  };
}

export function deriveRuntimePayloadContentIdentity(payload, options = {}) {
  payload = resolveRuntimePayloadForIdentity(payload, options);
  if (
    !isPlainObject(payload) ||
    !isPlainObject(payload.source) ||
    !hasText(payload.source.id) ||
    !hasText(payload.source.label) ||
    !['cet4', 'cet6'].includes(payload.track) ||
    !Array.isArray(payload.card_records) ||
    payload.card_records.length === 0
  ) {
    throw new Error('runtime payload must contain source, track, and non-empty card_records');
  }
  const cardIds = payload.card_records.map(card => String(card?.card_id || ''));
  if (cardIds.some(cardId => !cardId) || new Set(cardIds).size !== cardIds.length) {
    throw new Error('runtime payload card_records must have unique non-empty card_id values');
  }
  const assets = payload.assets === undefined ? [] : payload.assets;
  if (!Array.isArray(assets)) throw new Error('runtime payload assets must be an array');
  const assetIds = assets.map(asset => String(asset?.asset_id || ''));
  if (assetIds.some(assetId => !assetId) || new Set(assetIds).size !== assetIds.length) {
    throw new Error('runtime payload assets must have unique non-empty asset_id values');
  }
  const versionedContent = {
    card_records: payload.card_records,
    source: {id: payload.source.id, label: payload.source.label},
    track: payload.track,
  };
  if (assets.length > 0) {
    versionedContent.assets = assets
      .map(asset => ({
        asset_id: asset.asset_id,
        duration_ms: asset.duration_ms,
        media_type: asset.media_type,
        sha256: asset.sha256,
        size_bytes: asset.size_bytes,
      }))
      .sort((left, right) => String(left.asset_id).localeCompare(String(right.asset_id)));
  }
  const contentVersion = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(versionedContent)))
    .digest('hex')}`;
  if (
    payload.content_version !== undefined &&
    payload.content_version !== contentVersion
  ) {
    throw new Error('runtime payload content_version does not match normalized content');
  }
  return {
    card_ids: [...cardIds].sort(),
    content_version: contentVersion,
    track: payload.track,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(value, expected, label, issues) {
  if (!isPlainObject(value)) {
    issues.push({code: `${label}_not_object`});
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    issues.push({
      code: `${label}_keys_invalid`,
      expected: wanted,
      actual,
    });
  }
}

export function isLegacyV1HumanAuthorityRecord(record) {
  return isPlainObject(record) && (
    Object.hasOwn(record, 'approved_by_user') ||
    Object.hasOwn(record, 'confirmed_by_user') ||
    Object.hasOwn(record, 'human_reviewer') ||
    Object.hasOwn(record.coverage || {}, 'human_reviewer')
  );
}

export function validateModelAcceptance(
  acceptance,
  {
    allowTemplatePlaceholders = false,
    requiredCapabilities = [],
    requireAccepted = false,
  } = {},
) {
  const issues = [];
  exactKeys(
    acceptance,
    ['schema_version', 'actor', 'evidence', 'decision'],
    'model_acceptance',
    issues,
  );
  if (!isPlainObject(acceptance)) return issues;

  if (acceptance.schema_version !== MODEL_ACCEPTANCE_SCHEMA) {
    issues.push({
      code: 'model_acceptance_schema_invalid',
      actual: acceptance.schema_version ?? null,
    });
  }

  exactKeys(
    acceptance.actor,
    ['kind', 'agent', 'model', 'run_id'],
    'model_acceptance_actor',
    issues,
  );
  if (isPlainObject(acceptance.actor)) {
    if (acceptance.actor.kind !== 'model_harness') {
      issues.push({code: 'model_acceptance_actor_kind_invalid'});
    }
    for (const field of ['agent', 'model', 'run_id']) {
      const value = acceptance.actor[field];
      const placeholder = allowTemplatePlaceholders && /^<[^>]+>$/.test(String(value || ''));
      if (!placeholder && (!hasText(value) || !ID_RE.test(value))) {
        issues.push({code: `model_acceptance_actor_${field}_invalid`});
      }
    }
  }

  exactKeys(
    acceptance.evidence,
    ['reviewed_at', 'input_sha256', 'capabilities', 'summary', 'findings'],
    'model_acceptance_evidence',
    issues,
  );
  if (isPlainObject(acceptance.evidence)) {
    const timestampPlaceholder =
      allowTemplatePlaceholders && acceptance.evidence.reviewed_at === '<RFC3339_WITH_TIMEZONE>';
    if (
      !timestampPlaceholder &&
      (!RFC3339_WITH_ZONE_RE.test(String(acceptance.evidence.reviewed_at || '')) ||
        Number.isNaN(Date.parse(acceptance.evidence.reviewed_at)))
    ) {
      issues.push({code: 'model_acceptance_reviewed_at_invalid'});
    }
    const shaPlaceholder =
      allowTemplatePlaceholders && acceptance.evidence.input_sha256 === 'sha256:<64 lowercase hex characters>';
    if (!shaPlaceholder && !SHA256_RE.test(String(acceptance.evidence.input_sha256 || ''))) {
      issues.push({code: 'model_acceptance_input_sha256_invalid'});
    }
    const capabilities = acceptance.evidence.capabilities;
    if (
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      !capabilities.every(capability => MODEL_ACCEPTANCE_CAPABILITIES.includes(capability)) ||
      new Set(capabilities).size !== capabilities.length
    ) {
      issues.push({code: 'model_acceptance_capabilities_invalid'});
    } else {
      for (const capability of requiredCapabilities) {
        if (!capabilities.includes(capability)) {
          issues.push({
            code: 'model_acceptance_required_capability_missing',
            capability,
          });
        }
      }
    }
    const summaryPlaceholder =
      allowTemplatePlaceholders && acceptance.evidence.summary === '<semantic-review-summary>';
    if (!summaryPlaceholder && !hasText(acceptance.evidence.summary)) {
      issues.push({code: 'model_acceptance_summary_missing'});
    }
    const findings = acceptance.evidence.findings;
    if (!Array.isArray(findings)) {
      issues.push({code: 'model_acceptance_findings_invalid'});
    } else {
      const findingCodes = new Set();
      for (let index = 0; index < findings.length; index += 1) {
        const finding = findings[index];
        exactKeys(
          finding,
          ['code', 'severity', 'message'],
          'model_acceptance_finding',
          issues,
        );
        if (!isPlainObject(finding)) continue;
        if (!hasText(finding.code) || !/^[a-z][a-z0-9_]{2,95}$/.test(finding.code)) {
          issues.push({code: 'model_acceptance_finding_code_invalid', index});
        } else if (findingCodes.has(finding.code)) {
          issues.push({code: 'model_acceptance_finding_code_duplicate', index});
        } else {
          findingCodes.add(finding.code);
        }
        if (!['blocking', 'warning', 'info'].includes(finding.severity)) {
          issues.push({code: 'model_acceptance_finding_severity_invalid', index});
        }
        if (!hasText(finding.message)) {
          issues.push({code: 'model_acceptance_finding_message_missing', index});
        }
      }
      if (
        acceptance.decision === 'accepted' &&
        findings.some(finding => finding?.severity === 'blocking')
      ) {
        issues.push({code: 'model_acceptance_accepted_with_blocking_finding'});
      }
    }
  }

  if (!MODEL_ACCEPTANCE_DECISIONS.includes(acceptance.decision)) {
    issues.push({code: 'model_acceptance_decision_invalid'});
  } else if (requireAccepted && acceptance.decision !== 'accepted') {
    issues.push({code: 'model_acceptance_not_accepted'});
  }

  return issues;
}

export function isCurrentModelAcceptance(acceptance, options = {}) {
  return validateModelAcceptance(acceptance, options).length === 0;
}

export function requireCurrentModelAcceptance(acceptance, options = {}) {
  const issues = validateModelAcceptance(acceptance, options);
  if (issues.length > 0) {
    const error = new Error(
      `Current model acceptance is invalid: ${issues.map(issue => issue.code).join(', ')}`,
    );
    error.issues = issues;
    throw error;
  }
  return acceptance;
}

export function validateIndependentModelAcceptances(
  acceptances,
  {
    allowTemplatePlaceholders = false,
    minimum = 2,
    requiredCapabilities = [],
  } = {},
) {
  const issues = [];
  if (!Array.isArray(acceptances) || acceptances.length < minimum) {
    return [{
      code: 'independent_model_acceptance_count_invalid',
      expected_minimum: minimum,
      actual: Array.isArray(acceptances) ? acceptances.length : null,
    }];
  }
  const runIds = new Set();
  for (let index = 0; index < acceptances.length; index += 1) {
    const acceptance = acceptances[index];
    for (const issue of validateModelAcceptance(acceptance, {
      allowTemplatePlaceholders,
      requireAccepted: true,
      requiredCapabilities,
    })) {
      issues.push({...issue, acceptance_index: index});
    }
    const runId = acceptance?.actor?.run_id;
    if (typeof runId === 'string') runIds.add(runId);
  }
  if (runIds.size !== acceptances.length) {
    issues.push({code: 'independent_model_acceptance_run_id_duplicate'});
  }
  const inputHashes = new Set(
    acceptances.map(acceptance => acceptance?.evidence?.input_sha256),
  );
  if (inputHashes.size !== 1) {
    issues.push({code: 'independent_model_acceptance_input_mismatch'});
  }
  return issues;
}
