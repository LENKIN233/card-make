# Controlled Pilot Review Records

This directory stores the aggregate 120-card review evidence for the CET4
controlled pilot. A record must bind the exact 14 confirmed boxes, the 42
sample cards, the 78 reviewed expansion cards, a current 120-card scoped audit,
and the product content version.

`ready_for_user_approval` is not approval. Only the explicit `approve` command,
run after an actual user decision and with its source recorded, may transition a
review to `user_approved` and create the separate product-shaped approval
artifact. Audio QC and pilot publication remain independent gates.

Build is dry-run by default. Persisting the aggregate review requires
`--apply`; it must then be committed before approval can run:

```bash
node scripts/manage_controlled_pilot_approval.mjs build \
  --confirmation <tracked-sample-confirmation.json> \
  --audit <tracked-120-card-scoped-audit.json> \
  --runtime-payload <generated-runtime-payload.json> \
  --pilot-id <product-pilot-id> \
  --content-version sha256:<64-hex> \
  --output reviews/controlled_pilot_reviews/<review>.json
```
