# Operations Runbook — WhatsApp Assistant

This runbook covers diagnosing and fixing delivery failures, deploying on
Render, and operating the Meta (WhatsApp Cloud API) side of the service.

## 1. Quick diagnosis: "the bot does not answer"

Run the diagnostic tool locally with the **same values the deployment uses**
(copy them from Render → your service → Environment):

```bash
npm run whatsapp:diagnose
# then, to test an actual send:
npm run whatsapp:diagnose -- --send --to +905xxxxxxxxx
```

The tool prints the exact Meta error code plus a remediation hint. The most
common outcomes:

| Symptom | Meta code | Meaning | Fix |
|---|---|---|---|
| Send rejected, HTTP 400 | **131030** | Recipient not in the test number's allowed list | §3 below |
| Send rejected, HTTP 401 | **190** | Access token expired or invalid | §4 below |
| Send rejected, HTTP 400 | 131047 | 24-hour customer service window closed | The user must message the bot first; free-form replies only work for 24h after their last message |
| Send rejected, HTTP 400 | 100 / 33 | Wrong `WHATSAPP_PHONE_NUMBER_ID` | Copy the Phone number ID (not the phone number) from Meta → WhatsApp → API Setup |
| Send accepted but never arrives | 131026 | Recipient unreachable (no WhatsApp, blocked, old client) | Check the recipient's device/app |
| Everything accepted, no webhook events | — | Webhook not subscribed or wrong URL/token | §5 below |

Since the service now logs structured error details, the Render logs also show
the code directly, e.g.:

```json
{"error":{"name":"WhatsAppApiError","message":"[REDACTED]",
 "details":{"httpStatus":400,"metaErrorCode":131030,
 "hint":"Recipient is not in the test number's allowed list. ..."}},
 "msg":"WhatsApp message processing failed"}
```

`error.details.metaErrorCode` is the number to look up in this table.

## 2. How a message flows (what can break where)

```
User's WhatsApp
  → Meta Cloud API → POST /webhooks/whatsapp   (signature verified)
  → whitelist check (users table; npm run db:add-user)   → "unauthorized" if missing
  → rate limits → message stored → worker queue
  → LLM assistant (falls back to deterministic report router on LLM failure)
  → Graph API POST /{PHONE_NUMBER_ID}/messages   ← 131030 / 190 happen HERE
  → Meta delivers to the recipient               ← statuses[].errors arrive by webhook
```

Two separate allow-lists must both contain a tester:

1. **The app's whitelist** (Postgres `users` table): `npm run db:add-user --
   --phone "+905..." --name "Name" --permissions "company.sales,..."`.
   Missing → inbound message is ignored ("unauthorized"), no reply attempt.
2. **Meta's recipient allow-list** (test numbers only): §3. Missing → reply
   attempt fails with 131030.

## 3. Fixing 131030 (recipient not in allowed list)

Meta test numbers can only message up to **5 verified recipients**. Only the
app owner can change the list; nothing in Render or this repository can.

1. Open <https://developers.facebook.com/apps> and select the app.
2. Go to **WhatsApp → API Setup**.
3. Under **To** ("Manage phone number list"), click **Manage** and add the
   recipient number (e.g. your Turkish number, later Procon's number).
4. Meta sends a WhatsApp/SMS verification code to that number — enter it to
   complete verification.
5. Re-test: `npm run whatsapp:diagnose -- --send --to +90...`.

Also make sure the same number is in the app whitelist (§2, item 1) —
`npm run db:list-users` shows who is currently whitelisted and with which
permissions.

When Procon's production number arrives, register it as a real business phone
number (WhatsApp → API Setup → Add phone number). Real numbers have no
recipient allow-list, so 131030 disappears entirely.

## 4. Fixing 190 (expired access token)

The token shown on the **API Setup** page is temporary (~23 hours). If it was
pasted into Render, sends start failing about a day after deployment.

Create a permanent token instead:

1. Open **Meta Business Settings → Users → System users**.
2. Create (or select) a system user with **Admin** role.
3. **Add assets**: assign the app with full control.
4. **Generate new token**: select the app; permissions
   `whatsapp_business_messaging` and `whatsapp_business_management`;
   expiration **Never**.
5. Put the token in Render → Environment → `WHATSAPP_ACCESS_TOKEN` and
   redeploy.
6. Verify: `npm run whatsapp:diagnose` — step 3 should print
   `expires_at : never (permanent token)`.

## 5. Render deployment checklist

The repo ships a `render.yaml` infrastructure scaffold (Render → New →
Blueprint). It creates the database and web service, but deliberately does not
give the web runtime an owner URL or run migrations inside that service.
Render service environment variables are shared by pre-deploy and runtime
commands, while this app fail-closes if an admin URL reaches production.

After Render creates the database, use its external owner connection only on a
trusted workstation to run `npm run db:migrate`,
`npm run db:provision-app-role -- --confirm-dedicated-database`, and
`npm run db:provision-readonly -- --confirm-dedicated-database`. Then place only
the two restricted URLs in Render as `DATABASE_URL` and
`COMPANY_READONLY_DATABASE_URL`; never add `DATABASE_ADMIN_URL` to the web
service. Those URLs must use the full external Render PostgreSQL hostname that
matches the managed TLS certificate; do not assume an internal/private hostname
works with `verify-full`. Generate the remaining values with
`npm run setup:env -- --render`.
The first web deploy may remain unhealthy until this bootstrap is complete.

- [ ] `WHATSAPP_ENABLED=true`, `LLM_ENABLED` as desired. Set
      `LLM_GENERAL_CHAT_ENABLED=true` only on deployments that should answer
      general questions; it requires `LLM_ENABLED=true` and defaults to `false`.
- [ ] Keep `LLM_SCHEMA_DISCOVERY_ENABLED=false` unless an admin/executive needs
      schema-aware queries. When enabled, set `LLM_SCHEMA_ALLOWED_SCHEMAS` and
      the reviewed `LLM_SCHEMA_RELATION_MANIFEST`, use a SELECT-only company
      role, and grant the intended admin/executive both
      `company.database.explore` and each mapped relation resource.
- [ ] `WHATSAPP_ACCESS_TOKEN` — permanent System User token (§4).
- [ ] `WHATSAPP_PHONE_NUMBER_ID` — the numeric ID from API Setup (not the
      phone number itself).
- [ ] `META_APP_SECRET` + `REQUIRE_WHATSAPP_SIGNATURE=true`.
- [ ] `WHATSAPP_VERIFY_TOKEN` — any random string ≥16 chars; must match the
      value entered in Meta's webhook configuration.
- [ ] Webhook configured in Meta → WhatsApp → Configuration:
      URL `https://<your-service>.onrender.com/webhooks/whatsapp`, verify
      token as above, subscribed to the **messages** field.
- [ ] Database URLs, encryption/HMAC key rings, `SAFETY_IDENTIFIER_SECRET`
      set per `.env.example`.
- [ ] Confirm the web service environment contains no `DATABASE_ADMIN_URL`,
      `COMPANY_DATABASE_ADMIN_URL`, owner password, or provisioning password.
- [ ] Migrations applied (`npm run db:migrate:prod`) and each tester added
      with `npm run db:add-user`.
- [ ] After deploy, check the boot logs for
      `"WhatsApp configuration verified against the Graph API"`. If the line
      says the check **failed**, the details include the Meta error code —
      fix it before testing by phone.
- [ ] `GET /health` returns `"status":"ok"`; after a broken-config incident
      look at `checks.whatsappDelivery` and `checks.lastMetaErrorCode`.

## 6. Reading the logs

- `WhatsApp message processing failed` + `details.metaErrorCode` — the reply
  send was rejected; look the code up in §1.
- `details.terminal: true` (audit) / no more recovery retries — the failure is
  permanent; fix the configuration and ask the user to message again.
- `Meta reported the outbound WhatsApp message as failed` — the send was
  accepted but delivery failed later; `metaErrorCodes` carries the reasons.
- `LLM assistant failed; using deterministic fallback` — the LLM call broke;
  the user still gets the deterministic report answer. Check the LLM key,
  model name, and provider status. In hybrid mode, a general question receives
  the localized temporary-failure notice instead of the unrelated report menu.
- `Ignored WhatsApp message from a non-whitelisted sender` — add the sender
  with `npm run db:add-user` (§2).
- `Recovered pending WhatsApp messages` — the recovery worker re-queued
  stored messages after a crash or transient failure; normal in small counts.

## 7. Local end-to-end test (no real credentials)

```bash
docker compose up -d          # local Postgres
npm run db:migrate            # apply migrations
npm run e2e:local             # full webhook → assistant → send loop
```

`npm run e2e:local` boots the app against a fake Graph API
(`scripts/mock-meta-server.ts`), seeds a whitelisted user, sends signed
webhooks, and asserts replies, permanent-failure handling (131030), retry
behavior, and read receipts. Use `npm run mock:meta` to run the fake Graph API
standalone and point a locally running service at it.

## 8. Day-2 operations

- `npm run ops:status` — one-shot overview from the database: schema state,
  whitelist size, queue depth (pending / stuck / delivery-unknown /
  undeliverable), 24h traffic, and failure counts. Exit code 1 when something
  needs attention, so it can drive a cron alert.
- `ASSISTANT_LOCALE` (tr default / en) controls the language of the notices
  the bot sends on its own: unsupported-message-type replies, "slow down"
  rate-limit feedback, and the best-effort "can't answer right now" apology
  sent when processing fails before the reply (never when the send layer
  itself is broken).
- CI runs the mock-Meta end-to-end bridge test on every push/PR, so a
  regression in the webhook → assistant → send path fails the build before it
  reaches Render.
- `GET /health/whatsapp` with header `x-ops-token: <OPS_TOKEN>` —
  live Meta configuration probe: verified name, quality rating, token expiry
  in hours, and current delivery health. 503 with the Meta error code and
  hint when the configuration is broken; wire it to an uptime monitor.
- `npm run db:export-audit -- --days 90 --format csv` — compliance export of
  the audit log (metadata only, no message content).
- Users can send `menü` (or `help`/`?`) for a permission-aware report menu
  with numeric shortcuts (`1` = sales, `2` = projects, `3` = overdue tasks).
- Per-user notice language: `npm run db:add-user -- ... --locale en`
  overrides `ASSISTANT_LOCALE` for that user.
- With the LLM enabled, the assistant now receives the last few decrypted
  exchanges as context, so follow-up questions ("peki geciken görevler?")
  resolve naturally. History respects retention: purged content is skipped.
  In hybrid mode, prior outbound company answers are omitted so a later
  permission revocation cannot be bypassed by asking the model to repeat them.
- `LLM_GENERAL_CHAT_ENABLED=true` enables hybrid behavior: general knowledge,
  writing, translation, arithmetic, and everyday conversation use the LLM;
  company facts still require the permission-filtered read-only tools. Leave
  it `false` on report-only deployments. General turns are audited as
  `assistant.conversation`, separately from `company.report_request` events.
- `LLM_SCHEMA_DISCOVERY_ENABLED=true` adds schema discovery plus a constrained
  query DSL for permitted admin/executive users. It never executes model SQL:
  the server allowlists discovered relations/columns, parameterizes values,
  permits one bounded query per message, and enforces read-only transactions,
  timeouts, concurrency, row, cell, and byte limits. Only manifest-approved
  views and scalar columns are visible; public/system schemas, tables, foreign
  tables, JSON/binary/custom types, and unmapped columns are rejected. For a non-standard
  PostgreSQL database, set `COMPANY_REPORTS_ENABLED=false` only after the
  SELECT-only role, allowed schemas, relation manifest, per-relation permission,
  and view query cost have been reviewed. With `allowUnfiltered=false`, provide
  selective/indexed `filterColumns`; only equality, range, IN, or a three-character
  prefix on one of those columns satisfies the guard. Keep it false unless a
  view is demonstrably small or already aggregated.
- Treat the manifest and every view definition as a human-reviewed trust
  boundary. Direct foreign relations are rejected, but the runtime cannot prove
  that a normal view does not wrap an FDW, call a volatile/security-definer
  function, expose unintended semantics, or contain an unexpectedly expensive
  plan. Prefer a dedicated reporting/export database; review dependencies and
  query plans, and keep view/schema DDL ownership unavailable to application,
  source-system, and read-only runtime roles.
- `npm run db:whitelist-batch -- --file users.json` — onboard many users in
  one atomic transaction (all rows validated first; the error names the bad
  row). Same fields as `db:add-user`.
- `npm run db:list-access-requests [-- --days 30 --full]` — the access and
  right-to-erasure requests users raised from WhatsApp ("erişim istiyorum" /
  "verilerimi sil"). The running service only writes these as audit events; an
  operator fulfils them with `db:add-user` / `db:erase-user-data`.

## 8a. Abuse lockout, replay protection, and integration events

- **Sender lockout**: more than `ABUSE_LOCKOUT_THRESHOLD_PER_MINUTE` (default
  10) unauthorized messages from one sender within a minute trips a silent
  lockout for the rest of the window — no reply, audited as `whatsapp.lockout`,
  counted as `lockedOutSenders` in `GET /health`. Legitimate whitelisted users
  are never affected.
- **Replay protection**: set `WEBHOOK_MESSAGE_MAX_AGE_SECONDS` (e.g. 300) to
  reject inbound webhook messages whose Meta timestamp is outside the window,
  on top of the existing signature check and message-id dedup. `0` (default)
  disables it. Rejected messages are audited as `whatsapp.replay_rejected`.
- **Integration webhook**: set `INTEGRATION_WEBHOOK_URL` +
  `INTEGRATION_WEBHOOK_SECRET` to forward operational events (`sender.locked_out`,
  `send.permanent_failure`) as HMAC-signed POSTs. The receiver recomputes
  `sha256=HMAC(secret, body)` and compares against `x-assistant-signature`;
  `x-assistant-timestamp` is inside the signed body for freshness. Payloads
  carry only non-reversible references (hashes, Meta error codes) — never
  message content. Disabled by default; delivery never blocks the pipeline.

## 9. Stress / health testing

- `npm run test:stress` — worker queue saturation, rate-limit behavior.
- `npm run check` — typecheck + full test suite with coverage + build.
- `GET /health/live` — liveness only; `GET /health` — full readiness
  (schema, lifecycle, reporting views, queue depth, delivery health).
