# Audio QC Records

This directory stores review records for generated or replaced listening-card
audio assets.

Candidate card samples may reference existing `ai_tts/` files when the audio is
marked as sample-only. Formal audio readiness requires a scoped record based on
`TEMPLATE.json`, including transcript review, generation details, per-card audio
QC, and the boundary that TTS audio is not source-authenticity evidence.

Do not use this directory to approve card content. User-approved formal content
scope remains owned by `reviews/approved_batches/`.

A completely human-reviewed worklist may be converted with
`scripts/build_audio_qc_drafts.mjs`. The command is dry-run by default, emits
one record per box, verifies current technical and card identity, and refuses
to overwrite an existing QC record. Its output still keeps the user content
approval boundary explicit.
