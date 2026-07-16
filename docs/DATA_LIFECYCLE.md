# Data lifecycle and client offboarding

This runbook covers data written by the WhatsApp assistant. It does not authorize deletion of the client's source
company database. Agree the actual retention values, legal holds, backup windows, and evidence owner with the client
before production use.

## Stored-data map

| Data | Protection | Default lifetime | Deletion path |
|---|---|---:|---|
| Phone number | AES-256-GCM; HMAC lookup index | While user is whitelisted | Client offboarding |
| Name and department | AES-256-GCM | While user is whitelisted | Client offboarding |
| Authorized message body | AES-256-GCM | 30 days | Runtime minimizer or admin purge |
| Unauthorized message body | Not stored | 0 days | Not applicable |
| WhatsApp message ID | Domain-separated HMAC only | With message record | Message-record purge |
| Terminal message record and phone HMAC | Pseudonymous identifiers; no body after content expiry | 90 days | Admin purge |
| Audit event | No message body or raw phone | 365 days | Admin purge |
| Company reporting source | Read-only access; not copied as source rows | Client-controlled | Client-owned process |

Set `MESSAGE_RETENTION_DAYS`, `MESSAGE_RECORD_RETENTION_DAYS`, and `AUDIT_RETENTION_DAYS` to the approved values.
Message-record retention cannot be shorter than content retention. Use a separate key ring and HMAC secret for every
client; keep them outside Git, images, logs, and database backups.

## Scheduled lifecycle purge

Run this command daily from a restricted administrative cron/job with `DATABASE_ADMIN_URL` supplied only to that job:

```bash
npm run db:purge-expired
```

The command takes a transaction-scoped advisory lock, clears expired body/metadata, deletes only terminal message
records, and deletes expired audit events. It deliberately preserves active/retryable inbound and outbound work.
The application runtime role remains unable to delete audit or message records.

Monitor the job exit status and row counts without copying database URLs, phone numbers, message bodies, ciphertext,
or keys into monitoring labels. Review retention values whenever the contract, data classification, or legal-hold
status changes.

## End-of-contract erasure

1. Record the approved client/environment and confirm there is no active legal hold.
2. Disable the Meta webhook and stop every application/worker instance so no new rows can be created.
3. Point `DATABASE_ADMIN_URL` at the dedicated assistant database and run the non-mutating inventory:

   ```bash
   npm run db:erase-client-data
   ```

4. Compare the displayed database name with the approved environment. Then execute the guarded erasure:

   ```bash
   npm run db:erase-client-data -- \
     --confirm-database <exact-database-name> \
     --confirm-erase-client-data
   ```

5. Verify the command reports all four application tables empty. Do not restart the service.
6. Revoke/delete Meta and OpenAI tokens, database users/passwords, deploy keys, webhook secrets, and service access.
7. Destroy `DATA_ENCRYPTION_KEYS` and `PHONE_HASH_SECRET` in every secret manager and deployment revision.
8. Delete the dedicated assistant database/service, application instances, persistent disks, logs, exports, snapshots,
   point-in-time recovery/WAL data, and backups through each provider. Wait for documented provider expiry where
   immediate deletion is unavailable.
9. Confirm ownership of the source company/reporting database with the client. This repository's erasure command never
   modifies it.
10. Store only non-PII evidence: client/environment reference, approver, operator, timestamps, command exit status,
    zero-row verification, provider deletion ticket IDs, and the final backup-expiry date.

SQL `DELETE` is a logical deletion boundary, not a promise of immediate physical overwrite. PostgreSQL documents that
old row versions remain until vacuum can reclaim them, and backups/WAL are separate copies. For that reason the process
combines verified row deletion, encryption-key destruction, credential revocation, and provider media/backup disposal.
Choose sanitization controls proportionate to the client's data sensitivity and the current NIST SP 800-88 guidance.

References:

- [PostgreSQL: routine vacuuming and deleted row versions](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [NIST SP 800-88 Rev. 2: Guidelines for Media Sanitization](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
