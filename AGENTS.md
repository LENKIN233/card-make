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

This workspace is the content-production and review workspace for `softbook_cet`.
Its purpose is to produce high-quality CET4/CET6 card content that can become
formal product content after user approval. It is not the main app repository.

## Read Order

For every active task, read the minimum relevant subset:

1. `spec/doc-manifest.json`
2. `spec/authority-map.json`
3. `spec/workspace-contract.json`
4. `spec/content-quality-contract.json`
5. `spec/review-workflow.json`
6. `../softbook_cet/spec/product-core.json`
7. `../softbook_cet/spec/card-system.json`
8. `../softbook_cet/spec/box-catalog.json`

Escalate to `../softbook_cet/spec/interactions.json` or
`../softbook_cet/spec/knowledge-map.json` when the task touches interaction
semantics, TLGBNN ownership, or box hierarchy.

## Hard Rules

- Do not treat this as a generic English teaching project, a vocabulary-only
  tool, or a true-exam-only archive.
- Do not treat `production_status`, `contract_ready`, or `needs_review` as final
  release approval. They are legacy migration/status fields only.
- Do not claim content is formally usable. The user is the only final approval
  authority.
- Do not batch-generate formal content before a 3-card-per-box sample has passed
  agent self-review and then user confirmation.
- Do not edit card content without stating the concrete quality issue and the
  user-authorized scope.
- Do not delete cards directly. Mark discard candidates and wait for user
  confirmation.
- Do not put harness changes and bulk card-content changes in the same PR.
- Do not use back-side answers or analysis to reverse-engineer the front side.
  The front side must stand as a valid learning task, prompt, question, or input.
- Do not label AI-generated or simulated content as true exam content.
- Do not treat TTS audio as evidence of source authenticity. TTS audio is always
  generated from text; the text source and audio generation method are separate.

## Task Start

Before producing or editing cards, restate the task briefly and list the specs
you used. If the restatement is wrong, stop and ask for correction.

## Validation

After editing harness files, run:

```bash
node scripts/validate_harness.mjs
```

After editing card JSON or the preview reader, also run:

```bash
node scripts/validate_cards.mjs --write-report
```

## Agent-Managed Git

For tracked-file changes authored by an agent, the agent owns the Git lifecycle:
inspect current branch/status before editing, keep branch scope narrow, validate,
commit, push, and open or update a draft PR unless the user explicitly requests
local-only work.

Default branch policy:

- Continue an existing open PR only when the new work belongs to the same
  requirement domain and base branch.
- Create a new `harness/`, `content/`, `fix/`, or `tooling/` branch when the
  work is a separate review unit or would blur an existing PR.
- Do not force-push shared base branches such as `main` or
  `fix/review-findings-card-contract`.
- Do not merge harness or formal content PRs without explicit user
  authorization.

## Delivery

Harness changes require commit, push, and PR. Formal bulk card changes also
require commit, push, and PR after user-confirmed samples. Small samples may be
delivered locally for review. Do not auto-merge harness or formal content PRs.
