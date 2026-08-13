# Controlled Pilot Approval Artifacts

This directory stores the exact eight-field `controlled-pilot-approval.v1`
artifacts consumed by the product publisher. Each non-template artifact must be
derived from a matching tracked aggregate record under
`reviews/controlled_pilot_reviews/`; it cannot be handwritten, inferred from
green checks, or created from sample confirmation alone.

Approval is also dry-run by default and refuses an aggregate review whose mode
or bytes differ from `HEAD`. After the user has actually approved the exact
scope, the command requires all of `--attest-user-approved`, `--approved-at`,
`--approval-source`, and `--apply` to persist the transition and artifact.
