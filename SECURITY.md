# Security policy

## Vulnerability reporting

Do not open a public issue containing an exploit, credential, phone number, company data, ciphertext, database URL,
or message body. Use GitHub private vulnerability reporting/security advisories. Include the affected commit, impact,
synthetic reproduction, and proposed mitigation where possible.

Revoke and rotate any Meta, OpenAI, PostgreSQL, encryption, identifier-HMAC, audit-integrity, or safety-identifier
credential that may have been exposed before sharing redacted evidence.

## Supported deployment

Security fixes target the latest `main`. A supported production deployment must:

- run every migration through `006_finalize_security_controls.sql`;
- pass `npm run ops:readiness` and `npm run db:verify-audit`;
- use restricted app and view-only reporting roles;
- keep admin URLs and provisioning passwords out of the running service environment;
- use `verify-full` TLS for both PostgreSQL connections;
- load unique per-client keys from a secret manager or mounted secret files;
- keep Meta signature verification enabled;
- maintain lifecycle heartbeat and provider backup deletion procedures;
- export audit verification checkpoints to access-controlled append-only/WORM monitoring;
- require CI, CodeQL, dependency-audit and supply-chain checks before merge.

## Key compromise

Treat key exposure as an incident. Disable the webhook, stop workers, preserve non-sensitive evidence, rotate the
affected ring with dual-read compatibility, run the security backfill where applicable, verify the audit chain, and
revoke the old secret after the relevant database/backup retention boundary. Never remove an identifier or audit key
while retained records still reference its key ID.

## Data deletion

Individual erasure, assistant/client decommission, and explicitly authorized source-data erasure use different guarded
commands. An active legal hold blocks automated and operator-triggered assistant-data deletion under the same database
lock. Follow [docs/DATA_LIFECYCLE.md](docs/DATA_LIFECYCLE.md). Deletion evidence must contain references and counts, not
PII or secrets.
