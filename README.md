# Softbook CET Card-Making Workspace

This workspace contains card content and preview tooling for the `softbook_cet` project.

## Active Outputs

- `card_boxes_json/`: card-box JSON files.
- `ai_tts/`: referenced TTS audio assets.
- `card_viewer_interactive.html`: local card preview reader.
- `schemas/softbook_card_contract.schema.json`: product card contract anchor.
- `scripts/validate_cards.mjs`: repeatable card validation.
- `reports/`: ignored default output location for generated validation reports.
- `AGENTS.md` and `spec/`: agent harness for content-quality control.
- `reviews/`: agent self-review records, user-approved batches, and drafts.

## Validation

Run this after editing card JSON or the reader:

```bash
node scripts/validate_cards.mjs --report-path exports/card_validation_report.json
```

The validator enforces the product contract fields required by `softbook_cet`:

- `card_id`
- `track`
- `knowledge_ref`
- `interaction_id`
- `front`
- `analysis`

It also checks interaction IDs, audio file references, provenance status, and visible template leakage.
The report keeps explicit legacy flags separate from derived source-risk counts so
`quality_metadata.material.text_source_type` can expose simulated or AI-generated
candidate material even when legacy `source_ref.type` is still `content_pool`.

## Migration

The current JSON files keep the legacy preview-reader fields for compatibility, but now also include the product contract fields. Re-run the migration only when legacy cards are added or regenerated:

```bash
node scripts/migrate_cards_to_softbook_contract.mjs
node scripts/validate_cards.mjs --report-path exports/card_validation_report.json
```

Cards with `production_status: "needs_review"` are structurally valid but still need content/source audit before product release.

## Harness

This workspace uses a content-quality harness to control agent-authored card work.
The harness treats legacy fields such as `production_status`, `contract_ready`,
and `needs_review` as migration/status fields, not final release approval.

Run this after editing harness files:

```bash
node scripts/validate_harness.mjs
```

Run this after editing card JSON, review records, or the quality-audit harness:

```bash
node scripts/audit_card_quality.mjs --report-path exports/card_quality_audit_report.json
```

Validate repository delivery state:

```bash
node scripts/validate_candidate_review_queue.mjs
node scripts/report_repo_health.mjs --base origin/main --strict --expected-max-worktrees 7 --expected-max-stashes 0 --require-upstreams
```

The local health check covers every linked worktree, not only the current path.
The seven-worktree ceiling allows `main`, five candidate branches, and one
isolated tooling or harness branch; stashes and branches without upstreams are
not accepted as durable work state, and deleted upstreams fail strict checks.

The 627 tracked MP3 files are managed by Git LFS. Their pre-cutover byte hashes
are recorded in `ai_tts/audio-lfs-manifest.json` and checked with
`node scripts/validate_audio_lfs.mjs`. Generated global validation reports remain
ignored; immutable legacy review references resolve through
`reports/pre-cutover-report-index.json`, while new candidate work must commit a
current scoped audit under `reviews/audit_scopes/`.

Run the read-only technical audio audit before perceptual QC:

```bash
node scripts/audit_audio_technical.mjs --track cet4 --report-path exports/cet4-audio-technical-audit.json
```

The audit verifies exact bytes, manifest hashes, decoder metadata, declared
duration, and transcript presence. It deliberately does not claim that speech
matches the transcript or that pronunciation, noise, clipping, rhythm, stress,
or pauses pass; those require records under `reviews/audio_qc/`.

Before bulk TTS regeneration, compare providers with the fixed 20-case blind
suite under `reviews/audio_vendor_selection/`. A named human reviewer must lock
1–5 listening scores and blockers before provider identities are revealed. Run
`node scripts/validate_audio_vendor_selection.mjs`; only blocker-free candidates
with a mean score of at least 4 are eligible, with Tencent Cloud preferred on an
equal-score tie. This selection evidence does not replace per-card audio QC.

Candidate review WIP is capped at five active content PRs plus one separate
tooling or harness PR. Passing checks do not create formal content approval.

Agent self-review and approval records must link the current audit fingerprint
and include a scoped audit summary for their own `card_ids`; corpus-level totals
alone are not enough to support sample review.

Formal content usability requires explicit user approval recorded under
`reviews/approved_batches/`. Agent self-review records belong under
`reviews/agent_self_review/`; unapproved samples and blocked candidates belong
under `reviews/drafts/`.
