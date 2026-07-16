# Security policy

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, phone number, company data, or message body.
Use GitHub's private vulnerability reporting / security-advisory flow for this repository. Include the affected
commit, impact, reproduction steps using synthetic data, and a suggested mitigation when possible.

Never include live Meta, OpenAI, PostgreSQL, or encryption credentials in a report. Revoke and rotate any
credential that may have been exposed before sharing redacted evidence.

## Supported version

Security fixes target the latest commit on `main`. Deployments should run Node.js 24 LTS, apply every app migration,
use the restricted runtime database roles, and keep webhook signature verification enabled.
