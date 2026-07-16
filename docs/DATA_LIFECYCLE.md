# Data lifecycle and verified offboarding

Agree retention, legal holds, backup windows, data residency, subprocessors, evidence owner, and source-data ownership
with the client before production use. A legal hold overrides automated deletion until formally released.

## Data map

| Data | Protection | Default lifetime | Deletion |
|---|---|---:|---|
| Phone, name, department | Record-bound AES-256-GCM v2; versioned phone HMAC | While whitelisted | User/client erasure |
| Authorized message body | Record-bound AES-256-GCM v2 | 30 days | Automatic minimizer |
| Unauthorized message/body | Not persisted | 0 days | Not applicable |
| WhatsApp message ID | Versioned HMAC only | Message-record lifetime | Automatic record purge |
| Terminal message metadata | Keyed pseudonymous identifiers | 90 days | Automatic record purge |
| Audit event | HMAC chain; no raw phone/body | 365 days | Prefix purge + retained anchor |
| Rate-limit bucket | Keyed subject hash | About 2 minutes | Automatic cleanup |
| Reporting source | View-only; source rows not copied | Client policy | Separate written authorization |

Keys are not database data. They must be unique per client and stored outside Git, images, logs, DB snapshots, and
ordinary application configuration exports.

## Automatic lifecycle

The runtime calls `assistant_run_data_lifecycle` at `DATA_LIFECYCLE_INTERVAL_MINUTES`. The function:

1. acquires a distributed advisory lock;
2. removes expired ciphertext and temporary metadata;
3. anchors and removes only a contiguous expired audit prefix;
4. deletes expired terminal message records while preserving active/retryable work;
5. deletes expired rate-limit buckets;
6. records a heartbeat and non-sensitive row counts.

An approved legal hold is persisted in `service_state` and checked under the same advisory lock before any deletion.
It also blocks individual and end-of-contract erasure until formally released. Use only a non-PII approval ticket:

```bash
npm run db:set-legal-hold -- --active true --reference LEGAL-2026-001
npm run db:set-legal-hold -- --active true --reference LEGAL-2026-001 \
  --confirm-database <exact-app-database-name> --confirm-legal-hold-change

npm run db:set-legal-hold -- --active false --reference RELEASE-2026-001 \
  --confirm-database <exact-app-database-name> --confirm-legal-hold-change --confirm-retention-resumes
```

It is `SECURITY DEFINER`, has a fixed search path, validates all retention values, and is revoked from `PUBLIC`.
The runtime role receives only `EXECUTE`; it does not receive message/audit `DELETE`.

Monitor `/health` and `maintenance_job_state.last_succeeded_at`. An optional manual trigger uses the same lock and
heartbeat:

```bash
npm run db:purge-expired
```

Verify the audit chain periodically and before/after sensitive administration:

```bash
npm run db:verify-audit
```

The verifier prints the authenticated tail sequence and hash. Forward that non-PII checkpoint and command result to
an access-controlled append-only/WORM monitoring system. A database-local chain detects modification, but an external
checkpoint is required to detect total deletion of the database, events, anchors, and state together.

## Individual erasure

1. Verify requester identity and authority outside the bot.
2. Confirm no applicable legal hold.
3. Run dry-run and record only its pseudonymous reference/counts:

   ```bash
   npm run db:erase-user-data -- --phone "+905551234567"
   ```

4. Stop every application/worker replica so no in-flight job can recreate or transmit data, then supply the exact
   reference and service-stop confirmation:

   ```bash
   npm run db:erase-user-data -- \
     --phone "+905551234567" \
     --confirm-reference <reference> \
     --confirm-service-stopped \
     --confirm-erase-user-data
   ```

5. Verify user, permission, message and subject-specific rate-limit rows are absent.

Audit FK links are nulled by PostgreSQL. Stable keyed references, rather than mutable FKs, are authenticated by the
audit chain, so erasure does not invalidate audit evidence or retain raw PII. Those references remain pseudonymous
personal data while the audit keys exist; retain them only under the approved audit purpose, legal basis, and lifetime.

## End-of-contract assistant erasure

1. Record approval, environment, legal-hold release, operators and expected provider scope.
2. Disable the Meta webhook and stop every application/worker replica.
3. Run dry-run against the dedicated assistant DB:

   ```bash
   npm run db:erase-client-data
   ```

4. Compare the displayed DB name with the approved environment and execute:

   ```bash
   npm run db:erase-client-data -- \
     --confirm-database <exact-database-name> \
     --confirm-service-stopped \
     --confirm-provider-webhook-disabled \
     --confirm-erase-client-data
   ```

5. Verify all reported assistant-owned counts are zero and `service_state.decommissioned_at` is non-null. Startup and
   webhook paths fail closed after this marker is committed.
6. Revoke/delete Meta/OpenAI tokens, DB roles/passwords, deploy keys, webhook secrets and all application key rings.
7. Delete instances, disks, DB/service, replicas, exports, logs, snapshots, PITR/WAL and backups. Where deletion is
   deferred, record the provider's final expiry date and ticket.
8. Verify Meta/OpenAI contractual retention, data-residency and deletion controls separately; application code cannot
   erase provider-held copies by itself.

## Client-owned reporting source

Assistant erasure deliberately does not touch source reporting data. If the contract requires source deletion, obtain
separate written authorization, run dry-run against `COMPANY_DATABASE_ADMIN_URL`, then use all confirmations:

```bash
npm run db:erase-company-source
npm run db:erase-company-source -- \
  --confirm-database <exact-company-database-name> \
  --confirm-client-authorization \
  --confirm-erase-company-source-data
```

Never infer authorization to delete the source from authorization to delete the bot database.

## Evidence

Keep only environment/client references, approvers, operators, UTC timestamps, commit/image digest, command exit
status, zero-row counts, audit verification result, provider ticket IDs, and final backup expiry. Do not store phone
numbers, names, message bodies, ciphertext, keys, tokens, URLs with credentials, or database exports as evidence.

SQL `DELETE` is a logical boundary, not immediate media overwrite. PostgreSQL row versions, WAL and backups require
provider controls and cryptographic erasure through key destruction.
