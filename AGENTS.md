---
authority: agent_entrypoint
audience:
  - agent
load_when:
  - every active task in this workspace
depends_on:
  - spec/doc-manifest.json
status: active
---
# Card Make Agent Entry

This workspace produces CET4/CET6 card and audio content for `softbook_cet`.
The model and harness own generation, semantic review, current content
authorization, governed removal, Git delivery, and merge under the standing
authority in `spec/review-workflow.json`. Do not pause for person review or
confirmation.

## Read Order

Read only the minimum relevant subset:

1. `spec/doc-manifest.json`
2. `spec/authority-map.json`
3. `spec/workspace-contract.json`
4. `spec/review-workflow.json`
5. `spec/content-quality-contract.json`
6. `spec/audio-generation-contract.json` for audio work
7. `spec/trusted-media-run-producer.json` for formal media execution or attestation work
8. `spec/git-workflow.json` for tracked delivery
9. the relevant `../softbook_cet/spec/*.json` product owners

`spec/review-workflow.json` is the sole owner of model-owned acceptance. Older
records under sample-confirmation or controlled-pilot person-authority paths are
immutable historical evidence only and cannot authorize current content.

## Hard Rules

- Keep this a CET4/CET6 micro-coaching card product, not generic English study,
  a vocabulary-only tool, or a true-exam archive.
- New review, content-authorization, audio-acceptance, removal, and merge
  decisions require exact `model-acceptance.v2` actor and evidence data.
- Never populate legacy person-authority fields for a new artifact and never
  rewrite old records to look model-owned.
- Never invent source authenticity, true-exam provenance, legacy audio provider
  or voice, audio consumption, GitHub state, deployment, device, or other
  external facts.
- A model may pass perceptual audio checks only when it actually consumed the
  complete exact asset and has the declared audio capability. Otherwise record
  a capability blocker and continue independent work.
- Keep exact scope, immutable commit/input SHA, current corpus fingerprint,
  scoped-audit replay, answer/reference parity, and technical audio invariants.
- Full-track authorization must bind one direct immutable runtime payload or
  shard manifest, its exact byte SHA-256, and the derived canonical
  `content_version`; caller-chosen versions fail closed.
- Authorized runtime cards must not carry authoring-only prompt, model,
  harness, credential, token, secret, or private-key fields. Source-workspace
  review metadata stays outside the product payload.
- Treat `model-acceptance.v2` as structural evidence. Repository authority also
  requires the trusted base-only model check after its documented bootstrap.
- Do not delete a card without governed destructive-change evidence bound to
  the base card and a successful current-reference and coverage scan.
- Do not mix harness/tooling changes with bulk card content or audio asset
  changes in one PR.
- Do not use back-side answers or analysis to reverse-engineer the front side.
- Do not label generated or simulated content as true-exam content.
- Do not treat TTS audio as evidence of text-source authenticity.

## Execution

Restate the task and specs briefly, then proceed from active authority without a
review pause. When evidence is unavailable, reject or reduce only the affected
scope; do not fabricate it and do not stop unrelated work.

For tracked changes, inspect branch/status, use a scoped topic branch, validate,
commit, push, open or update the PR, and merge after the exact PR head has passed
all required checks. `main` remains read-only for development. A failed gate,
ambiguous target, or mixed change scope blocks merge.

## Validation

For harness or policy changes run at least:

```bash
node --test scripts/test_model_acceptance.mjs
node scripts/validate_harness.mjs
node --test scripts/test_card_integrity.mjs
node --test scripts/test_validate_pr_scope.mjs
node --test scripts/test_validate_delivery_record.mjs
node --test scripts/test_manage_controlled_pilot_approval.mjs
node --test scripts/test_audio_perceptual_worklist.mjs
node --test scripts/test_build_audio_qc_drafts.mjs
node --test scripts/test_validate_audio_qc_model.mjs
node scripts/validate_audio_qc.mjs
git diff --check
```

For card JSON also run:

```bash
node scripts/validate_cards.mjs --report-path exports/card_validation_report.json
node scripts/audit_card_quality.mjs --report-path exports/card_quality_audit_report.json
```

Changed review or authorization evidence must be a direct regular JSON file at
immutable HEAD and link a direct current scoped audit. Historical evidence is
append-only. Git paths, modes, payload history, patch hashes, PR identity, and
required checks remain governed by `spec/git-workflow.json` and the delivery
validators.

Generated global reports under `reports/` and local health output under
`exports/` are not durable authorization evidence.
