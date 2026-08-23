# Scoped Audit Reports

This directory stores per-sample card quality audit evidence.

Use scoped reports for candidate content PRs so a single box sample can carry
its own audit fingerprint and scoped issue summary without committing global
report refreshes under `reports/`.

Current model-owned review and content-authorization records must link direct
scoped reports replayed against immutable HEAD. Archived legacy approvals may
retain their historical global-report references, but those references never
create current authorization.
