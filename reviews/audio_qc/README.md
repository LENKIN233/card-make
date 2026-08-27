# Model-owned audio QC records

Current records bind exact audio and transcript identities to an audio-capable
model's complete-asset perceptual evidence plus the independent technical audit.
Every card records `complete_asset_consumed` and all seven perceptual results;
every box record carries two deterministic evidence lanes aggregated from the
first and second exact-input audio-capable acceptance of every scoped card. The
builder requires a tracked current model-owned content authorization and binds
it in `source_records.linked_approved_batch`; it does not request redundant new
box-level model runs. Validate the output with `scripts/validate_audio_qc.mjs`.

Audio QC does not prove text-source authenticity, provider or voice provenance,
deployment, or device behavior. Current content authorization remains a separate
model-owned artifact under `reviews/approved_batches/`.
