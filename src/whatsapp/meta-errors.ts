export type MetaErrorClassification = "permanent" | "retryable";

type KnownMetaError = {
  classification: MetaErrorClassification;
  hint: string;
};

// Cloud API error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const KNOWN_META_ERRORS: Record<number, KnownMetaError> = {
  0: {
    classification: "permanent",
    hint: "Authentication failed. Regenerate the access token and update WHATSAPP_ACCESS_TOKEN."
  },
  3: {
    classification: "permanent",
    hint: "The token is missing the whatsapp_business_messaging capability. Use a System User token with WhatsApp permissions."
  },
  4: {
    classification: "retryable",
    hint: "App-level API throttling. Reduce send volume and retry later."
  },
  10: {
    classification: "permanent",
    hint: "Permission denied for this endpoint. Grant whatsapp_business_messaging to the token in Meta Business settings."
  },
  33: {
    classification: "permanent",
    hint: "The phone number ID does not exist or is not visible to this token. Check WHATSAPP_PHONE_NUMBER_ID."
  },
  100: {
    classification: "permanent",
    hint: "Invalid request parameter. Usually a wrong WHATSAPP_PHONE_NUMBER_ID or a malformed recipient number."
  },
  190: {
    classification: "permanent",
    hint: "Access token expired or invalidated. Temporary API Setup tokens last ~23 hours; create a permanent System User token and update WHATSAPP_ACCESS_TOKEN."
  },
  80007: {
    classification: "retryable",
    hint: "WhatsApp Business Account rate limit reached. Retry after backing off."
  },
  130429: {
    classification: "retryable",
    hint: "Cloud API throughput limit reached. Retry after backing off."
  },
  131000: {
    classification: "retryable",
    hint: "Generic Meta-side failure. Retry later; check the WhatsApp status page if it persists."
  },
  131016: {
    classification: "retryable",
    hint: "Meta service temporarily unavailable. Retry later."
  },
  131026: {
    classification: "permanent",
    hint: "Message undeliverable: the recipient may not have WhatsApp, has not accepted the latest terms, or blocked the sender."
  },
  131030: {
    classification: "permanent",
    hint: "Recipient is not in the test number's allowed list. Open Meta Developers > WhatsApp > API Setup, add the recipient under the allowed phone number list, and complete the verification code step."
  },
  131031: {
    classification: "permanent",
    hint: "The WhatsApp Business Account is locked or restricted. Check account quality and policy status in the Meta Business Manager."
  },
  131047: {
    classification: "permanent",
    hint: "More than 24 hours passed since the user's last message, so free-form replies are blocked. The user must message the bot again, or an approved template message is required."
  },
  131048: {
    classification: "retryable",
    hint: "Sending is paused due to spam-rate limits on the phone number. Retry later and review number quality."
  },
  131051: {
    classification: "permanent",
    hint: "Unsupported message type for this recipient or channel."
  },
  131056: {
    classification: "retryable",
    hint: "Too many messages sent to this recipient in a short window. Retry after backing off."
  },
  133010: {
    classification: "permanent",
    hint: "The phone number is not registered on the WhatsApp Cloud API. Register it in Meta Developers > WhatsApp > API Setup."
  }
};

function knownError(code: number | null): KnownMetaError | null {
  if (code === null) return null;
  if (code >= 200 && code < 300) {
    return {
      classification: "permanent",
      hint: "The token lacks a required permission for this operation. Review the token's WhatsApp permissions in Meta Business settings."
    };
  }
  return KNOWN_META_ERRORS[code] ?? null;
}

export function metaErrorHint(code: number | null, httpStatus: number): string {
  const known = knownError(code);
  if (known) return known.hint;
  if (httpStatus === 401) return KNOWN_META_ERRORS[190]!.hint;
  if (httpStatus === 429) return "Rate limited by the Graph API. Retry after backing off.";
  return "Unrecognized Graph API error. Look up the Meta error code in the Cloud API error reference.";
}

export function classifyMetaError(code: number | null, httpStatus: number): MetaErrorClassification {
  const known = knownError(code);
  if (known) return known.classification;
  if (httpStatus === 429) return "retryable";
  if (httpStatus >= 400 && httpStatus < 500) return "permanent";
  return "retryable";
}
