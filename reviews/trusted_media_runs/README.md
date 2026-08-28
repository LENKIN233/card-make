# Trusted media run artifacts

Each accepted receipt named `reviews/trusted_media_receipts/<id>.json` has one
matching direct child directory `reviews/trusted_media_runs/<id>/`. That
directory retains the exact run package, raw JSONL runs, model/package/runtime
manifests, audio manifest, and reviewed worklist downloaded from the verified
GitHub workflow artifact. Files are append-only regular HEAD blobs; audio bytes
remain in the existing Git LFS `ai_tts/` paths.

Formal audio QC replays this directory with the product-owned
`softbook_cet/scripts/verify_trusted_media_run_receipt.mjs` verifier and the
exact tracked audio bytes. A receipt and Sigstore bundle without this replayable
package cannot create `formal_audio_ready=true`.
