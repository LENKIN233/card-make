# Audio model-review worklists

Tracked worklists use `audio-perceptual-worklist.v3`. Every non-pending entry
must contain exact `model-acceptance.v2` evidence with
`audio_perceptual_review`, bind the current asset bytes and transcript, and
attest complete asset consumption. A model without that capability records a
capability blocker and cannot pass the entry.
Each terminal pass uses two distinct run IDs bound to the exact entry identity,
`complete_asset_consumed=true`, and all seven per-card results.

Passing worklist evidence may be converted into audio QC records, but it does
not prove source authenticity, trusted model execution, deployment, or device
behavior. Formal media execution additionally requires the fixed trusted-media
workflow and GitHub-attested receipt defined by
`spec/trusted-media-run-producer.json`.
