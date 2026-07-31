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

It also checks interaction IDs, audio file references, provenance status, visible template leakage,
canonical card-box filenames, schema-valid metadata whenever `quality_metadata` is present, and
runtime-ID/preview/answer-key consistency for elimination cards. Untouched legacy cards may still
omit metadata and use the recorded text-as-ID elimination migration; any card changed by a
candidate PR is validated against the complete current metadata and explicit runtime-ID contract.
The report keeps explicit legacy flags separate from derived source-risk counts so
`quality_metadata.material.text_source_type` can expose simulated or AI-generated
candidate material even when legacy `source_ref.type` is still `content_pool`.

## Migration

The current JSON files keep the legacy preview-reader fields for compatibility. The migration now
emits runtime `elimination_items` as `{id,text}`, keeps `eliminable_items` as the local
`text/is_correct` projection, and writes `answer_key.correct_items` as IDs. Re-run it only when
legacy cards are added or regenerated:

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
node --test scripts/test_card_integrity.mjs
node --test scripts/test_validate_pr_scope.mjs
node --test scripts/test_validate_delivery_record.mjs
```

Candidate PR scope validation uses NUL-delimited Git paths, discovers changed cards from the
merge-base-to-head objects, requires exactly one changed self-review snapshot for each changed card,
and compares every entry in every changed self-review with its unique HEAD corpus card. The only
parity exception is the independently validated artifact-local `review_status`. JSON under
`reviews/agent_self_review/`, `reviews/approved_batches/`, `reviews/drafts/`, or
`reviews/audit_scopes/` enters this gate even
when the filename has no four-digit box prefix; only the exact repository-declared template paths
are excluded, not arbitrary names ending in `TEMPLATE.json`. Self-review and approval evidence must
be direct regular JSON children of their governed directories; nested or symlinked records fail
closed. Git paths
are preserved exactly, and literal backslashes, controls, or Unicode line separators are rejected
instead of rewritten. The replayed scoped audit materializes
the complete `HEAD:card_boxes_json` tree, so a renamed or deleted base path cannot leak into the result.
Every new or changed review or approval uses a direct current scoped audit; global audit references are limited
to byte-for-byte immutable records in the immutable pre-cutover index. Every new or changed scoped
report, linked or unlinked, must exactly match a current immutable-HEAD replay. The standalone
harness rejects malformed tracked reports but allows structurally valid unchanged historical
fingerprints. An unchanged historical self-review remains historical evidence bound to its recorded
artifact and skips current-card parity; a changed review must prove current parity, and formal
approval records with historical fingerprints remain immutable archive evidence rather than current
authorization. Only an approval whose linked audit fingerprint is current may authorize current
formal use. Standard reviews must carry
their complete sample policy, scoped audit, blocker scans, and batch conclusion (progression, risks,
representative cards, and next step) before their per-card metadata snapshots can count. A standard
sample proves exactly three snapshots per declared box, with interaction, knowledge, and all
quality metadata except review status matching the current corpus in both gates; residual
closure evidence requires its explicit scope type and a direct scoped audit, and cannot authorize
newly added cards. Canonical `full_track_remediation` records carry
aggregate human-review coverage instead: strict equal, unique, non-empty scope/reviewed card IDs and
the expected count must match the complete declared track card and box-prefix sets in immutable HEAD,
the track ID set must be the same non-empty set at merge-base and HEAD, and the record must not attach
a separate `cards` payload. They also require exact policy flags, a structured non-automation human
reviewer identity, matching per-box human passes, a complete zero-hard-blocker audit summary,
non-empty in-scope representative cards, and complete ready-for-user-approval summary, empty-risk,
and next-step evidence. Newly added cards use the standard per-card workflow in a separate unit.
The four exact review/approval templates are regular-file authorities with fixed, complete standard
or full-track placeholder shapes. Formal approvals require a timezone-qualified timestamp,
non-empty summary, unique non-empty scope arrays, and non-empty in-scope representative cards.
Run it against an immutable commit after the payload commit:

```bash
node scripts/validate_pr_scope.mjs --base origin/fix/review-findings-card-contract --head HEAD
```

Git handoffs bind the complete payload path set to the final payload commit and require one direct,
safe, non-executable `100644` JSON blob at the fixed PR head. Symlinks, executable blobs, gitlinks,
nested or anomalous paths, legacy/no-hash evidence, and Git replace refs fail closed. Current records
use the complete typed template schema, match change type to merge authority, and are append-only;
historical records cannot be overwritten, deleted/re-added, or renamed. All Git semantic reads resolve
fixed commit OIDs under the canonical no-replace/no-grafts environment, and non-empty common-dir
`info/grafts` fails closed even from linked worktrees.
The mandatory v2 patch digest fatally and byte-preservingly decodes Git paths as UTF-8, audits the
full reachable pre- and post-payload history (including merged side branches), rejects transient or
restored paths, forces gitlink-inclusive path
discovery, and uses the canonical Git config, diff options, and commit-sourced attributes declared by
`spec/git-workflow.json`; repository info attributes and custom diff drivers fail closed.
The delivery-record gate validates the explicit true PR head SHA and exact PR number, URL, state,
draft, branch, and repository metadata; parked records require the remote-tracking ref to match the
explicit head. The other PR jobs keep GitHub's synthetic merge checkout for integration coverage.

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
`reports/pre-cutover-report-index.json`. The index and every referenced legacy
record are byte-frozen against the active repository commit that introduced the
index, while new candidate work must commit a current scoped audit under
`reviews/audit_scopes/`.

Run the read-only technical audio audit before perceptual QC:

```bash
node scripts/audit_audio_technical.mjs --track cet4 --report-path exports/cet4-audio-technical-audit.json
```

The audit verifies exact bytes, manifest hashes, decoder metadata, declared
duration, and transcript presence. It deliberately does not claim that speech
matches the transcript or that pronunciation, noise, clipping, rhythm, stress,
or pauses pass; those require records under `reviews/audio_qc/`.

Build the human perceptual-review queue from that exact passing audit:

```bash
node scripts/manage_audio_perceptual_worklist.mjs build \
  --track cet4 \
  --technical-audit exports/cet4-audio-technical-audit.json \
  --output exports/cet4-audio-perceptual-worklist.json

node scripts/manage_audio_perceptual_worklist.mjs next \
  --file exports/cet4-audio-perceptual-worklist.json
```

The `next` result contains one local audio path, its bound transcript, box
context, and seven pending perceptual checks. After listening, record only that
card with a human reviewer identity. Run without `--apply` first; append
`--apply` only when the proposed review state is correct:

```bash
node scripts/manage_audio_perceptual_worklist.mjs review \
  --file exports/cet4-audio-perceptual-worklist.json \
  --card-id <card-id> \
  --reviewer github:<human-account> \
  --attest-listened \
  --check audio_matches_text=pass \
  --check target_signal_audible=pass
```

The queue supports partial `in_progress` reviews and resumes them before the
next pending card. It has no bulk-pass command, rejects Agent/bot reviewers,
re-hashes current audio bytes, and refuses to preserve a human verdict when the
card transcript or asset identity changes. Validate with `--require-complete`
only after all 301 entries are terminal. A completed worklist is still not a
formal QC record or content approval; it must be converted into validated
`reviews/audio_qc/` evidence and remain bound to the final user-approved batch.

Candidate review WIP is capped at five active content PRs plus one separate
tooling or harness PR. Passing checks do not create formal content approval.

New or changed self-review and approval records must link the current audit
fingerprint and include a scoped audit summary for their own `card_ids`;
corpus-level totals alone are not enough. Historical records remain archive
evidence, and queue/release-gap consumers count current authorization only after
the complete direct approval, complete linked self-review, both scoped reports,
the active audit script, and the active audit rule spec are regular committed
evidence or authority whose worktree, index, and one fixed `HEAD` modes and bytes
agree. Their scope must match, both reports must exactly replay an independently
regenerated complete current audit, and the snapshot is rechecked before return.
Tracked status, a current corpus digest, or a self-declared zero-blocker summary
alone is not authorization.

Formal content usability requires explicit user approval recorded under
`reviews/approved_batches/`. Agent self-review records belong under
`reviews/agent_self_review/`; unapproved samples and blocked candidates belong
under `reviews/drafts/`.
