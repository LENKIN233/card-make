# Runtime payload bindings

This directory holds direct immutable JSON payloads and shard manifests used
only to derive and verify a full-track authorization's canonical runtime
`content_version`.

Each current full-track authorization must bind one direct payload or manifest
path and its exact SHA-256. A
`card-make-runtime-payload-manifest.v1` manifest keeps assets and source identity
directly and lists direct `card-make-runtime-card-shard.v1` JSON files. Every
shard entry binds exact file bytes, card count, first/last card ID, strict order,
and a non-overlapping range. Validators capture all files in one fixed Git
snapshot, reconstruct the normalized payload, require the same track and card
IDs as the authorization scope, and reject missing, swapped, overlapping,
replayed, dirty, untracked, or hash-mismatched shards.

Use a manifest whenever a direct payload would violate the repository's normal
blob-size limit. These payloads and manifests do not prove deployment, device,
audio consumption, provider execution, or source authenticity.
