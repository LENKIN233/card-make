# Audio Perceptual Review Worklists

This directory may store human-reviewed `audio-perceptual-worklist.v2` files.
Generate the initial CET4 queue under ignored `exports/`, listen to one card at
a time, and use the manager's dry-run-first `review` command to record outcomes.
Every non-pending update requires the reviewer to attest that the complete asset
was heard with its transcript and target context.

For a controlled subset such as the 24 audio cards referenced by one pilot
candidate, build with `--scope-card-ids <comma-separated-card-ids>`. The v2
worklist binds the exact non-empty card IDs, canonical order, expected entry
count, complete-track audio count and scope fingerprint. Validation still
rechecks the complete passing technical audit before resolving the subset, so a
scoped queue cannot hide an unknown asset or be mistaken for whole-track QC.
Legacy v1 files remain valid only as complete-track queues.

A worklist is operational review state only. Even when all entries are passed,
it does not create formal audio QC, establish text source authenticity, or
approve card content. Formal audio evidence still requires a validated record
under `reviews/audio_qc/`, and formal content remains gated by the complete
user-approved batch record.

Do not mark a reviewer as an Agent, bot, CI identity, or automation. Do not use
bulk “pass all” operations. If transcript or asset identity changes after a
human review, the manager fails closed unless the reset is explicitly
acknowledged; the affected audio must be listened to again.
