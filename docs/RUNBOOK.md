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

Fast path: the repo ships a `render.yaml` Blueprint (Render → New →
Blueprint). It creates the database and the web service with migrations in
`preDeployCommand`; generate the secret values with
`npm run setup:env -- --render` and paste them into the dashboard. The manual
checklist below applies either way.

- [ ] `WHATSAPP_ENABLED=true`, `LLM_ENABLED` as desired.
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
  model name, and provider status.
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
- `GET /health/whatsapp` with header `x-ops-token: <WHATSAPP_VERIFY_TOKEN>` —
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

## 9. Stress / health testing

- `npm run test:stress` — worker queue saturation, rate-limit behavior.
- `npm run check` — typecheck + full test suite with coverage + build.
- `GET /health/live` — liveness only; `GET /health` — full readiness
  (schema, lifecycle, reporting views, queue depth, delivery health).
