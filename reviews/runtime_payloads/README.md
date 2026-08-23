# Runtime payload bindings

This directory holds direct immutable JSON payloads used only to derive and
verify a full-track authorization's canonical runtime `content_version`.

Each current full-track authorization must bind one direct payload path and its
exact SHA-256. Validators recompute the normalized content identity, require the
same track and card IDs as the authorization scope, and reject caller-chosen or
cross-payload versions. These payloads do not prove deployment, device, audio
consumption, provider execution, or source authenticity.
