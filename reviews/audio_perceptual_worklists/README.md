# Audio Perceptual Review Worklists

This directory may store human-reviewed `audio-perceptual-worklist.v1` files.
Generate the initial CET4 queue under ignored `exports/`, listen to one card at
a time, and use the manager's dry-run-first `review` command to record outcomes.
Every non-pending update requires the reviewer to attest that the complete asset
was heard with its transcript and target context.

A worklist is operational review state only. Even when all entries are passed,
it does not create formal audio QC, establish text source authenticity, or
approve card content. Formal audio evidence still requires a validated record
under `reviews/audio_qc/`, and formal content remains gated by the complete
user-approved batch record.

Do not mark a reviewer as an Agent, bot, CI identity, or automation. Do not use
bulk “pass all” operations. If transcript or asset identity changes after a
human review, the manager fails closed unless the reset is explicitly
acknowledged; the affected audio must be listened to again.
