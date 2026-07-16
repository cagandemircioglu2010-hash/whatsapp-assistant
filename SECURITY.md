# Security policy

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, phone number, company data, or message body.
Use GitHub's private vulnerability reporting / security-advisory flow for this repository. Include the affected
commit, impact, reproduction steps using synthetic data, and a suggested mitigation when possible.

Never include live Meta, OpenAI, PostgreSQL, or encryption credentials in a report. Revoke and rotate any
credential that may have been exposed before sharing redacted evidence.

## Supported version

Security fixes target the latest commit on `main`. Deployments should run Node.js 24 LTS and a supported PostgreSQL
release, apply every app migration, use the restricted runtime database roles, keep webhook signature verification
enabled, and schedule the documented lifecycle purge.

## Data handling and deletion

Production deployments must use a unique encryption key ring and HMAC secret per client. Do not reuse keys between
client environments. The default lifecycle is 30 days for message content, 90 days for terminal message records,
and 365 days for audit events; reduce these values when the contract or applicable policy requires it.

End-of-contract deletion is a controlled administrative operation, not a runtime API. Follow
[docs/DATA_LIFECYCLE.md](docs/DATA_LIFECYCLE.md), preserve no PII in the deletion evidence, and separately revoke
credentials and destroy provider backups and encryption material.
