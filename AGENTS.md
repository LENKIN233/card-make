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
  agent self-review and then user confirmation recorded under
  `reviews/sample_confirmations/`. A confirmation authorizes only the exact
  recorded boxes and targets; it is not formal content approval.
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
node --test scripts/test_card_integrity.mjs
node --test scripts/test_validate_pr_scope.mjs
node --test scripts/test_validate_delivery_record.mjs
```

After editing card JSON or the preview reader, also run:

```bash
node scripts/validate_cards.mjs --report-path exports/card_validation_report.json
```

For candidate sample PRs, do not commit global report refreshes from
`reports/`. Commit a scoped audit report instead:

```bash
node scripts/audit_card_quality.mjs --scope-card-ids <comma-separated-card-ids> --write-scope-report reviews/audit_scopes/<review-id>-scope-audit.json
node scripts/validate_pr_scope.mjs --base origin/fix/review-findings-card-contract --head HEAD
```

The PR-scope command is an immutable-snapshot check and therefore runs after
the payload commit; worktree-only content validation fails closed. Any
JSON change under `reviews/agent_self_review/`, `reviews/approved_batches/`,
`reviews/sample_confirmations/`, `reviews/drafts/`, or `reviews/audit_scopes/` triggers the content gate even
without a four-digit box prefix. Only the five exact repository-declared
template paths are excluded; a filename that merely ends in `TEMPLATE.json`
remains governed. Self-review, sample-confirmation, and approval evidence must be direct regular JSON
children of their governed directories; nested and symlinked records fail closed. Git
paths are preserved exactly, while literal backslashes, controls, and Unicode
line separators are rejected. The current scoped audit
replays the complete `HEAD:card_boxes_json` tree rather than overlaying only
changed paths. Every new or changed review or approval uses a direct current scoped audit;
archived global audit references are limited to byte-for-byte immutable records
named by the immutable pre-cutover index. Every new or changed scoped report,
linked or unlinked, exactly matches a current immutable-HEAD replay; unchanged
historical reports may retain a structurally valid historical fingerprint.
Unchanged historical self-reviews stay bound to that artifact and skip
current-card parity; changed reviews must prove current parity, and formal
approval records with historical fingerprints remain immutable archive evidence,
not current authorization. Current formal authorization requires the consumer
to prove the approval, linked self-review, both scoped reports, active audit
script, and active audit rule spec have identical worktree/index/fixed-`HEAD`
modes and bytes, regenerate the complete current audit, exactly replay both
scoped reports, and recheck the snapshot before returning. Standard reviews require complete
policy, audit, blocker-scan, batch progression/risk/representative-card/next-step
conclusions, and per-card metadata evidence before coverage can count, with
exactly three current-corpus-matching snapshots per declared box. A
`confirmed_box_expansion` review may cover only one box, must link a direct
validated sample-confirmation record, and must add exactly the recorded target
minus the three confirmed sample cards. It remains non-formal and requires a
later explicit user approval of the complete batch. Residual
closure evidence requires its explicit scope type and a direct scoped audit,
and cannot authorize newly added cards. Canonical
full-track records instead use strict equal aggregate scope/coverage IDs bound
to the complete declared track card and box-prefix sets in immutable HEAD, and
the track membership must remain the same non-empty set from merge-base to
HEAD. They also require structured non-automation human identities, matching
per-box human passes, a complete zero-hard-blocker audit summary, non-empty
in-scope representative cards, and complete ready batch summary/empty-risk/
next-step evidence. They must not attach a separate `cards` payload or authorize added cards.
The five exact review/approval/confirmation templates are regular-file authorities with fixed, complete governed
placeholder shapes. Formal approvals require a timezone-qualified timestamp,
non-empty summary, unique non-empty scope arrays, and non-empty in-scope representative cards.
Git handoff discovery excludes only `reviews/git_handoffs/TEMPLATE.json`.
The current record must be one direct, safe, non-executable `100644` JSON blob
at the fixed PR head; symlinks, executable blobs, gitlinks, nested or anomalous
paths, legacy/no-hash evidence, and Git replace refs fail closed. The complete
record schema is type-checked, its authority must match its change type, and the
record is append-only: it cannot overwrite, delete/re-add, or rename historical
handoffs. All Git semantic reads resolve fixed commit OIDs under the canonical
no-replace/no-grafts environment; a non-empty common-dir `info/grafts` fails
closed, including from linked worktrees. Mandatory v2 patch evidence uses the canonical Git config, diff
options, and commit-sourced attributes declared by `spec/git-workflow.json`,
fatally and byte-preservingly decodes Git paths as UTF-8, forces
gitlink-inclusive path discovery, audits the full reachable pre- and post-payload
history including merged side branches, rejects transient/restored paths, and fails closed on repository info
attributes or custom diff-driver config.
The GitHub delivery-record job passes the exact pull-request head SHA plus PR
number, URL, state, draft, branch, and repository metadata to its history
validator; parked records instead require a remote-tracking ref at the exact
head. The other PR jobs retain the default synthetic-merge
checkout for base-integration coverage.

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
- Keep at most five active candidate content PRs and one separate tooling or
  harness PR. Park additional candidates as closed, recoverable queue entries.
- Green checks and a mergeable PR never create formal approval. Current formal
  authorization additionally requires a direct canonical non-template record
  under `reviews/approved_batches/`, explicit user confirmation, a complete
  direct linked self-review with matching scope, and both scoped reports plus
  the active audit script/rule spec to be regular committed evidence or authority
  whose worktree/index/fixed-`HEAD` modes and bytes agree. Both reports must
  exactly replay an independently regenerated complete current audit and the
  snapshot must be rechecked before return; tracked status, a current corpus
  digest, or a self-declared zero-blocker summary is insufficient, and historical
  approval records remain archive-only.
- The user has delegated automatic merge for validated harness/tooling PRs in
  this workspace. After validation passes and GitHub reports the PR as
  mergeable, merge the PR instead of stopping for another confirmation.
- Do not auto-merge formal bulk content PRs unless the batch has user-confirmed
  sample approval and the user has delegated merge authority for that content
  scope.

## Delivery

Harness changes require commit, push, and PR. Formal bulk card changes also
require commit, push, and PR after user-confirmed samples. Small samples may be
delivered locally for review. Validated harness/tooling PRs are auto-merged
under the standing user delegation; formal content merge remains gated by
content approval and scope-specific merge delegation.

Generated global reports under `reports/` and local health output under
`exports/` are ignored. CI and local validation must use explicit
`--report-path` destinations rather than committing report refreshes.
