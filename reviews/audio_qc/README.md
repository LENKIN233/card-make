# Model-owned audio QC records

Current records bind exact audio and transcript identities to an audio-capable
model's complete-asset perceptual evidence plus the independent technical audit.
Every card records `complete_asset_consumed` and all seven perceptual results;
every box record carries two independent exact-input model acceptances. Use
`scripts/build_audio_qc_drafts.mjs --plan-model-inputs` to obtain the bound box
inputs, then rerun with `--acceptances-dir` and validate with
`scripts/validate_audio_qc.mjs`.

Audio QC does not prove text-source authenticity, provider or voice provenance,
deployment, or device behavior. Current content authorization remains a separate
model-owned artifact under `reviews/approved_batches/`.
