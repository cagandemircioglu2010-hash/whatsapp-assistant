import "dotenv/config";
import { classifyMetaError, metaErrorHint } from "../src/whatsapp/meta-errors.js";

// Interactive operator tool: checks the WhatsApp Cloud API configuration the
// service will use and optionally sends a live test message, printing the full
// Meta error (code, subcode, message, fbtrace_id) with a remediation hint.
//
//   npm run whatsapp:diagnose
//   npm run whatsapp:diagnose -- --send --to +905xxxxxxxxx
//
// Requires WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in the
// environment (or .env). Run it locally with the same values Render uses to
// diagnose the deployed service.

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type MetaFailure = {
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  message: string | null;
  fbtraceId: string | null;
};

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function describeFailure(failure: MetaFailure): void {
  line(`  HTTP status : ${failure.httpStatus}`);
  line(`  Meta code   : ${failure.code ?? "unknown"}${failure.subcode !== null ? ` (subcode ${failure.subcode})` : ""}`);
  if (failure.message) line(`  Meta message: ${failure.message}`);
  if (failure.fbtraceId) line(`  fbtrace_id  : ${failure.fbtraceId}`);
  line(`  Class       : ${classifyMetaError(failure.code, failure.httpStatus)}`);
  line(`  Hint        : ${metaErrorHint(failure.code, failure.httpStatus)}`);
}

async function graphRequest(
  path: string,
  init: RequestInit
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; failure: MetaFailure }> {
  const version = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v25.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000)
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Keep the empty body; the status code is still meaningful.
  }
  if (response.ok) return { ok: true, body };
  const error =
    body.error !== null && typeof body.error === "object" && !Array.isArray(body.error)
      ? (body.error as Record<string, unknown>)
      : {};
  return {
    ok: false,
    failure: {
      httpStatus: response.status,
      code: typeof error.code === "number" ? error.code : null,
      subcode: typeof error.error_subcode === "number" ? error.error_subcode : null,
      message: typeof error.message === "string" ? error.message : null,
      fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id : null
    }
  };
}

const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

line("WhatsApp Cloud API diagnosis");
line("============================");
line();

let failed = false;

// 1. Environment sanity
line("[1/4] Environment variables");
const environmentProblems: string[] = [];
if (!accessToken) environmentProblems.push("WHATSAPP_ACCESS_TOKEN is not set");
else if (accessToken.length < 20) environmentProblems.push("WHATSAPP_ACCESS_TOKEN looks too short");
if (!phoneNumberId) environmentProblems.push("WHATSAPP_PHONE_NUMBER_ID is not set");
else if (!/^\d{5,30}$/.test(phoneNumberId)) environmentProblems.push("WHATSAPP_PHONE_NUMBER_ID must be only digits");
if (process.env.WHATSAPP_ENABLED !== "true") {
  environmentProblems.push("WHATSAPP_ENABLED is not 'true' (the service will not register the webhook routes)");
}
if (environmentProblems.length === 0) {
  line("  OK");
} else {
  for (const problem of environmentProblems) line(`  PROBLEM: ${problem}`);
  failed = true;
}
line();

if (!accessToken || !phoneNumberId) {
  line("Cannot continue without WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.");
  process.exit(1);
}

const authorization = { Authorization: `Bearer ${accessToken}` };

// 2. Token + phone number pairing
line("[2/4] Token can read the configured phone number");
const phoneCheck = await graphRequest(
  `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`,
  { method: "GET", headers: authorization }
);
if (phoneCheck.ok) {
  line("  OK");
  line(`  display_phone_number     : ${String(phoneCheck.body.display_phone_number ?? "unknown")}`);
  line(`  verified_name            : ${String(phoneCheck.body.verified_name ?? "unknown")}`);
  line(`  quality_rating           : ${String(phoneCheck.body.quality_rating ?? "unknown")}`);
  line(`  code_verification_status : ${String(phoneCheck.body.code_verification_status ?? "unknown")}`);
} else {
  failed = true;
  line("  FAILED — the token cannot read this phone number ID:");
  describeFailure(phoneCheck.failure);
}
line();

// 3. Token metadata (works only when the token can inspect itself; a failure
// here is informational, not fatal).
line("[3/4] Token expiry (debug_token, best effort)");
const tokenCheck = await graphRequest(
  `debug_token?input_token=${encodeURIComponent(accessToken)}`,
  { method: "GET", headers: authorization }
);
if (tokenCheck.ok) {
  const data =
    tokenCheck.body.data !== null && typeof tokenCheck.body.data === "object" && !Array.isArray(tokenCheck.body.data)
      ? (tokenCheck.body.data as Record<string, unknown>)
      : {};
  const expiresAt = typeof data.expires_at === "number" ? data.expires_at : null;
  const dataAccessExpiresAt = typeof data.data_access_expires_at === "number" ? data.data_access_expires_at : null;
  line(`  type       : ${String(data.type ?? "unknown")}`);
  line(`  is_valid   : ${String(data.is_valid ?? "unknown")}`);
  if (expiresAt !== null) {
    line(
      expiresAt === 0
        ? "  expires_at : never (permanent token)"
        : `  expires_at : ${new Date(expiresAt * 1000).toISOString()}${expiresAt * 1000 < Date.now() ? "  <-- EXPIRED" : ""}`
    );
    if (expiresAt !== 0 && expiresAt * 1000 < Date.now() + 24 * 3600 * 1000) {
      line("  WARNING: this token expires within 24 hours. Temporary API Setup tokens");
      line("  last ~23 hours; use a permanent System User token for Render.");
    }
  }
  if (dataAccessExpiresAt !== null && dataAccessExpiresAt !== 0) {
    line(`  data_access_expires_at : ${new Date(dataAccessExpiresAt * 1000).toISOString()}`);
  }
} else {
  line("  Skipped — debug_token is not readable with this token (this is normal");
  line("  for some token types and does not indicate a problem by itself).");
}
line();

// 4. Optional live send
line("[4/4] Test message");
if (!flag("send")) {
  line("  Skipped. Re-run with --send --to +90xxxxxxxxxx to send a live test message.");
} else {
  const to = argument("to");
  if (!to || !/^\+?[1-9]\d{7,14}$/.test(to)) {
    line("  PROBLEM: --send requires --to with an E.164 number, e.g. --to +905xxxxxxxxx");
    failed = true;
  } else {
    const sendResult = await graphRequest(`${phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: "Diagnostic test message from company-whatsapp-assistant." }
      })
    });
    if (sendResult.ok) {
      const messages = Array.isArray(sendResult.body.messages) ? sendResult.body.messages : [];
      const first =
        messages[0] !== null && typeof messages[0] === "object" ? (messages[0] as Record<string, unknown>) : {};
      line("  OK — message accepted by Meta");
      line(`  message id: ${String(first.id ?? "unknown")}`);
      line("  If it does not arrive on the phone, watch the service logs for a");
      line("  'Meta reported the outbound WhatsApp message as failed' status event.");
    } else {
      failed = true;
      line("  FAILED — Meta rejected the send:");
      describeFailure(sendResult.failure);
    }
  }
}
line();
line(failed ? "Result: PROBLEMS FOUND (see above)" : "Result: configuration looks healthy");
process.exit(failed ? 1 : 0);
