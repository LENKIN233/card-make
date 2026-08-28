# Trusted media receipts

This directory stores exact downloaded `trusted-media-run-receipt.v1` JSON and
its GitHub Artifact Attestation bundle only after the protected `card-make`
main workflow completes. Records are append-only, direct regular files. The
matching raw package is retained under `reviews/trusted_media_runs/<receipt-id>/`.
The
receipt, bundle, source commit, model identity, reviewed worklist and current
content authorization are rehashed before any `model-owned-audio-qc.v2` record
can claim `formal_audio_ready=true`.

A locally authored receipt, a missing bundle, an attestation for different
bytes, or a receipt that does not bind the exact tracked reviewed worklist and
authorization cannot create formal QC. These records still do not prove
deployment, playback, distribution, provider identity or source authenticity.
