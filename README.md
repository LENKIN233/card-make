# Softbook CET Card-Making Workspace

This repository produces CET4/CET6 card and audio content consumed by
`softbook_cet`. Product intent and card/runtime semantics remain owned by the
sibling product repository; content acceptance is owned here by
`spec/review-workflow.json`.

## Model-owned acceptance

The model+harness system has standing authority to generate, review, authorize,
revise, remove, deliver, and merge content without user or human confirmation.
New decisions use `model-acceptance.v2` and record:

- the real agent, model, and run ID;
- the exact input SHA-256 and review time;
- capabilities actually used;
- a non-empty semantic summary and structured findings;
- an accepted or rejected decision.

Accepted evidence cannot contain a blocking finding. Full-track, audio, and
controlled-pilot authorization require two independent run IDs over the same
immutable input. Legacy records containing `approved_by_user`,
`confirmed_by_user`, or human-review fields are frozen historical evidence and
cannot create current authorization.

A full-track formal content authorization also binds one direct immutable
runtime payload or hash-bound shard manifest and its SHA-256. Validators
reconstruct every direct regular JSON shard in one fixed snapshot, derive the
canonical `content_version`, require exact track/card scope, and include the
version plus the direct payload/manifest byte SHA-256 in the canonical
model-input hash. Missing, swapped, overlapping, or
cross-version shards cannot replay the two independent runs. Ordinary scoped
authorization does not require a runtime version before one exists.

`model-acceptance.v2` is structural decision evidence, not cryptographic proof
that a provider model executed. The pinned base-only `trusted-model-review`
workflow supplies repository execution provenance after bootstrap. Formal
media claims still require a separate trusted exact-asset consumption receipt.

## Non-negotiable facts

- Keep card scope, current corpus fingerprint, audit replay, answer/reference
  parity, and source provenance exact.
- Never present generated or simulated content as true-exam material.
- Never invent legacy audio provider/voice data, audio consumption, GitHub,
  deployment, device, or other external facts.
- Audio perceptual acceptance requires an audio-capable model to consume every
  complete bound asset; DSP, decoder, duration, hash, and transcript checks stay
  independent.
- Card removal requires destructive-change acceptance bound to the base card
  hash plus a passing current-reference and coverage scan.
- Keep harness/tooling, card payload, and audio asset changes in separate PRs.

## Main surfaces

- `card_boxes_json/`: 218 card-box documents.
- `ai_tts/`: Git LFS audio assets.
- `reviews/agent_self_review/`: semantic model reviews.
- `reviews/approved_batches/`: current content authorization.
- `reviews/audio_qc/`: current model audio acceptance.
- `reviews/audit_scopes/`: exact scoped audit evidence.
- `reviews/runtime_payloads/`: full-track runtime payload/version bindings.
- `spec/`: content, audio, review, delivery, and harness owners.
- `scripts/`: validators and evidence builders.

## Validation

For harness or policy changes:

```bash
node --test scripts/test_model_acceptance.mjs
python3 scripts/test_trusted_model_review.py
node scripts/validate_harness.mjs
node --test scripts/test_card_integrity.mjs
node --test scripts/test_validate_pr_scope.mjs
node --test scripts/test_validate_delivery_record.mjs
node --test scripts/test_manage_controlled_pilot_approval.mjs
node --test scripts/test_validate_audio_qc_model.mjs
node scripts/validate_audio_qc.mjs
git diff --check
```

For card JSON:

```bash
node scripts/validate_cards.mjs --report-path exports/card_validation_report.json
node scripts/audit_card_quality.mjs --report-path exports/card_quality_audit_report.json
```

For audio bytes:

```bash
node scripts/audit_audio_technical.mjs \
  --track cet4 \
  --report-path exports/cet4-audio-technical-audit.json
```

Current model audio authorization is validated by
`scripts/validate_audio_qc.mjs`. The active v3 perceptual worklist records two
exact-input model runs, `complete_asset_consumed`, and all seven per-card
results. Older v1/v2 person-authority worklists remain frozen archive evidence;
the executable browser review station has been removed.

Formal media execution provenance uses `.github/workflows/trusted-media-run.yml`.
That main-only workflow runs `scripts/run_trusted_media_review.py` from a
read-only exact-commit snapshot on a protected Apple Silicon runner. It locks
and rehashes the model and `mlx_audio` package, rejects truncated model input,
and requires two blind full transcriptions for every asset before it rebuilds
all 301 decisions with
`scripts/build_trusted_media_run_receipt.mjs`, and applies a GitHub Artifact
Attestation to the exact receipt bytes. A passing worklist or self-declared JSON
without that run and attestation is not formal media evidence.
An unprivileged GitHub-hosted verifier rebuilds the package and audio first; a
separate minimal signer job downloads only those verified bytes and executes no
repository code under OIDC authority. Failed model runs retain their raw package
before the review job fails. Formal QC later replays the matching tracked
`reviews/trusted_media_runs/<receipt-id>/` package with the product verifier.
`scripts/build_audio_qc_drafts.mjs` also requires the tracked receipt and
attestation bundle and binds their hashes, source commit, model identity and
reviewed-worklist identity into every formal QC acceptance input.

## Delivery

Use a scoped topic branch. After exact-head validation and model review, push,
open or update the PR, and merge automatically when required checks are green.
Do not write `main` directly and do not wait for a person or an approval label.
The trusted Codex workflow is installed through a one-time bootstrap: merge
under the current exact-head checks, configure `OPENAI_API_KEY`, prove both
isolated jobs plus the aggregate on a follow-up PR, then add
`trusted-model-review` to branch protection.

Generated reports under `reports/` and local output under `exports/` are not
durable authorization evidence. A tracked status field, PR state, or claimed
zero-blocker summary is not enough without the complete current v2 evidence.
