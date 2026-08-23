# Controlled-pilot model reviews

New controlled-pilot review records use `controlled-pilot-review.v2` and reach
`ready_for_model_authorization` only after exact-scope review and deterministic
audit checks. The compatibility manager creates the v2 authorization transition
without a person-review pause.

The review binds the exact runtime payload and scoped audit hashes, fourteen-box
coverage, 120 card IDs, zero non-source blockers, the corpus fingerprint, and
the complete set of linked model-owned card reviews.

The existing `controlled-pilot-review.v1` record remains immutable historical
evidence. It is not rewritten and cannot authorize a changed current input.
