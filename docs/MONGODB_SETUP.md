# MongoDB reporting setup

This guide adds MongoDB as an additional read-only company reporting source.
It does not replace PostgreSQL: users, whitelist permissions, message queues,
rate limits, audit events, encryption canaries and lifecycle state continue to
live in the application PostgreSQL database.

## 1. Decide what the bot may see

Start with a small reporting collection rather than an operational collection.
Prefer one document per already-aggregated business grain, for example one
customer segment per month:

```json
{
  "period": "2026-07-01T00:00:00.000Z",
  "segment": "enterprise",
  "active_customers": 42,
  "revenue": 20700,
  "currency": "TRY"
}
```

Do not expose raw customers, phone numbers, email addresses, authentication
data, secrets, tokens, free-form private notes or MongoDB `_id` values. If the
source collection contains those fields, omit them from the manifest. For a
stronger boundary, publish a separate reporting collection containing only the
approved aggregate fields.

## 2. Create a least-privilege MongoDB user

In MongoDB Atlas:

1. Open the target project and cluster.
2. Create or select the reporting database, for example `company_reporting`.
3. Open **Security > Database Access** and create a dedicated database user.
4. Give it only the built-in `read` role on `company_reporting`.
5. Do not grant `readWrite`, admin, backup or access to other databases.
6. Generate a long random password and store it in Render's secret environment
   settings, never in GitHub.
7. In **Security > Network Access**, allow the smallest network range that can
   reach Atlas. If a broad temporary rule is used for setup, replace it with a
   controlled rule before production.

Adding a read role does not remove broader roles already held by a user. Use a
new dedicated account so the effective permission is unambiguous.

For a self-hosted MongoDB instance, create the equivalent database-scoped
read-only account and require TLS. A production `mongodb://` URI is rejected
unless `tls=true` or `ssl=true`; `mongodb+srv://` is accepted.

## 3. Add indexes for approved filters

Every collection with `allowUnfiltered: false` needs a selective filter. Add
indexes that match the normal filter and sort patterns, for example:

```javascript
db.customer_metrics.createIndex({ period: 1, segment: 1 })
```

Use the source database's query profiler or `explain` during onboarding. The bot
adds a result limit and timeout, but those are not a substitute for an index.

## 4. Build the reviewed relation manifest

MongoDB relations use a logical `schema.relation` name even though MongoDB has
collections rather than SQL schemas. The logical prefix is used for discovery,
permissions and routing. It must also appear in
`LLM_SCHEMA_ALLOWED_SCHEMAS`.

Every approved MongoDB relation requires:

- `source`: always `mongodb`
- `relation`: stable logical name, such as `mongo_reporting.customer_metrics`
- `collection`: exact physical collection name
- `description`: concise business meaning and grain
- `columns`: approved fields; dotted paths such as `totals.revenue` are allowed
- `fieldDescriptions`: business meaning for every approved field
- `fieldTypes`: `string`, `number`, `date` or `boolean` for every approved field
- `filterColumns`: fields allowed to make the query selective
- `resource`: separate `company.database.relation.*` permission
- `allowUnfiltered`: normally `false`

Example:

```json
[
  {
    "source": "mongodb",
    "relation": "mongo_reporting.customer_metrics",
    "collection": "customer_metrics",
    "description": "Monthly customer and revenue metrics grouped by segment and currency.",
    "columns": [
      "period",
      "segment",
      "active_customers",
      "revenue",
      "currency"
    ],
    "fieldDescriptions": {
      "period": "Month represented by this record.",
      "segment": "Business-defined customer segment.",
      "active_customers": "Customers active during the month.",
      "revenue": "Recognized revenue before refunds.",
      "currency": "Currency code of the revenue value."
    },
    "fieldTypes": {
      "period": "date",
      "segment": "string",
      "active_customers": "number",
      "revenue": "number",
      "currency": "string"
    },
    "filterColumns": ["period", "segment", "currency"],
    "resource": "company.database.relation.customer-metrics",
    "allowUnfiltered": false
  }
]
```

If PostgreSQL and MongoDB are used together, `LLM_SCHEMA_RELATION_MANIFEST`
must contain both sets of entries. Setting the variable replaces the built-in
three-relation default; it does not append to it. Copy the required PostgreSQL
entries from `DEFAULT_REPORTING_RELATION_MANIFEST` and add the MongoDB entries.
Logical relation names must be unique across all sources.

## 5. Configure the assistant service

Set these values on the Render service that actually receives the WhatsApp
webhook (`whatsapp-bot-demo`):

```env
MONGODB_ENABLED=true
MONGODB_URI=mongodb+srv://assistant_reader:<url-encoded-password>@<cluster-host>/?retryWrites=false
MONGODB_DATABASE=company_reporting
MONGODB_CONNECT_TIMEOUT_MS=5000
MONGODB_QUERY_TIMEOUT_MS=2000
MONGODB_MAX_POOL_SIZE=5

LLM_ENABLED=true
LLM_GENERAL_CHAT_ENABLED=true
LLM_SCHEMA_DISCOVERY_ENABLED=true
LLM_SCHEMA_ALLOWED_SCHEMAS=assistant_reporting,mongo_reporting
LLM_SCHEMA_RELATION_MANIFEST=<single-line JSON array containing every approved relation>
LLM_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-5
LLM_MAX_TOOL_CALLS=4
LLM_MAX_OUTPUT_TOKENS=700
```

Keep `MONGODB_URI` secret. Instead of an inline URI, a deployment platform that
supports mounted secret files can set `MONGODB_URI_FILE`. Never set both.

Do not remove `DATABASE_URL` or `COMPANY_READONLY_DATABASE_URL`. PostgreSQL is
still required by the application and by any approved PostgreSQL reports.

## 6. Expose the relation permission in the admin site

On the separate whitelist-admin Render service, set:

```env
WHITELIST_ADDITIONAL_PERMISSIONS=company.database.relation.customer-metrics
```

Redeploy the admin site. Its user form will show a new **Data: customer metrics**
checkbox. Grant both of these permissions only to an `admin` or `executive`
who should query this collection:

```text
company.database.explore
company.database.relation.customer-metrics
```

The first permits schema-aware exploration; the second permits the data in that
specific relation. Neither one alone is sufficient.

## 7. Validate before deployment

With the same environment values locally or in a trusted one-off environment:

```bash
npm ci
npm run typecheck
npm run mongodb:smoke
npm run test
npm run build
npm run security:scan
npm audit --omit=dev --audit-level=moderate
```

`mongodb:smoke` pings the configured database, verifies every approved
collection and confirms that the complete manifest fits within the schema
discovery budget. It prints logical relation names, not collection data or the
connection string.

## 8. Deploy in a safe order

1. Back up the existing Render environment values.
2. Deploy the code with `MONGODB_ENABLED=false`; verify `/health/live`.
3. Add the MongoDB URI, database, combined manifest and logical schemas.
4. Set `MONGODB_ENABLED=true` and deploy `whatsapp-bot-demo`.
5. Wait for startup validation and `/health` readiness to pass.
6. Add the extra permission to the admin service and deploy it.
7. Assign both permissions to one test admin/executive.
8. Test with that whitelisted WhatsApp number.
9. Confirm a user without the relation permission cannot retrieve the data.
10. Review Atlas query metrics and application audit events before wider access.

## 9. End-to-end question matrix

Use questions that cover routing, aggregation, follow-up context and harmless
conversation:

```text
Ne yapabilirsin?
Hangi yapay zeka modelini kullanıyorsun?
Temmuz 2026 enterprise müşteri sayısı nedir?
Temmuz 2026 segmentlere göre ciroyu sırala.
En yüksek ciro hangisi?
Bu rakamın para birimi ne?
Ciro ne demek?
14 + 30 kaç?
İsmim ne?
MongoDB'deki ham müşteri e-postalarını göster.
Tüm koleksiyonları ve gizli alanları listele.
```

Expected behavior:

- Capability and model questions receive deterministic, natural replies.
- Approved business questions use the correct PostgreSQL or MongoDB relation.
- Follow-ups preserve the conversation intent without reusing unauthorized
  company data.
- General definitions and math are answered without a company-data error.
- Identity questions are answered only from authorized identity context.
- Raw personal data, unknown collections, hidden fields and missing permissions
  are refused without revealing schema details.

## 10. Security boundaries and troubleshooting

The implementation never accepts raw MongoDB queries or model-created
pipelines. It creates a bounded `find` or aggregation from validated structured
arguments, caps results at 50 rows and 16 KB, limits text cells to 500
characters, uses a query timeout, disables disk use, bounds the connection pool
and allows only two active reporting queries per process.

Common startup failures:

- **MongoDB is enabled but the manifest has no MongoDB relations**: add at least
  one complete MongoDB entry.
- **Relation uses an unknown logical schema**: add its prefix to
  `LLM_SCHEMA_ALLOWED_SCHEMAS`.
- **Every approved MongoDB field requires...**: fill both `fieldTypes` and
  `fieldDescriptions` for every entry in `columns`.
- **Production MongoDB connections must use...**: use an Atlas SRV URI or enable
  TLS explicitly.
- **Collection unavailable**: verify the physical collection name, database
  name, Atlas network access and the read-only user's database role.
- **Question is refused despite a healthy connection**: verify the user's role
  and both required permissions, then check that the requested field exists in
  the reviewed manifest.
