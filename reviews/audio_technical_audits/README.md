# Audio technical audits

This directory stores immutable, track-complete technical audit inputs for a
trusted media run. Each JSON file must come from
`scripts/audit_audio_technical.mjs`, bind every referenced audio byte and
transcript, pass with zero errors, and be referenced by one pending v3
perceptual worklist.

A technical audit is not perceptual QC, model execution provenance, content
authorization, deployment evidence, or device playback evidence.
