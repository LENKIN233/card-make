# Softbook CET Card-Making Workspace

This workspace contains card content and preview tooling for the `softbook_cet` project.

## Active Outputs

- `card_boxes_json/`: card-box JSON files.
- `ai_tts/`: referenced TTS audio assets.
- `card_viewer_interactive.html`: local card preview reader.
- `schemas/softbook_card_contract.schema.json`: product card contract anchor.
- `scripts/validate_cards.mjs`: repeatable card validation.
- `reports/card_validation_report.json`: latest validation report.
- `AGENTS.md` and `spec/`: agent harness for content-quality control.
- `reviews/`: agent self-review records, user-approved batches, and drafts.

## Validation

Run this after editing card JSON or the reader:

```bash
node scripts/validate_cards.mjs --write-report
```

The validator enforces the product contract fields required by `softbook_cet`:

- `card_id`
- `track`
- `knowledge_ref`
- `interaction_id`
- `front`
- `analysis`

It also checks interaction IDs, audio file references, provenance status, and visible template leakage.

## Migration

The current JSON files keep the legacy preview-reader fields for compatibility, but now also include the product contract fields. Re-run the migration only when legacy cards are added or regenerated:

```bash
node scripts/migrate_cards_to_softbook_contract.mjs
node scripts/validate_cards.mjs --write-report
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

Formal content usability requires explicit user approval recorded under
`reviews/approved_batches/`. Agent self-review records belong under
`reviews/agent_self_review/`; unapproved samples and blocked candidates belong
under `reviews/drafts/`.
