export type AssistantLocale = "tr" | "en";

export type SystemMessageKey = "unsupportedType" | "rateLimited" | "processingFailed";

// User-facing notices the pipeline sends on its own (no LLM involved).
// ASSISTANT_LOCALE picks the language; report content itself is produced by
// the router/LLM and is not affected.
const SYSTEM_MESSAGES: Record<SystemMessageKey, Record<AssistantLocale, string>> = {
  unsupportedType: {
    tr: "Şimdilik yalnızca metin mesajlarını okuyabiliyorum. Lütfen isteğinizi metin olarak gönderin.",
    en: "I can only read text messages for now. Please send your request as text."
  },
  rateLimited: {
    tr: "Çok hızlı mesaj gönderiyorsunuz. Lütfen bir dakika bekleyip tekrar deneyin.",
    en: "You're sending messages too quickly. Please wait a minute and try again."
  },
  processingFailed: {
    tr: "Üzgünüm, şu anda cevap veremiyorum. Lütfen kısa bir süre sonra tekrar deneyin.",
    en: "Sorry, I can't answer right now. Please try again shortly."
  }
};

export function systemMessage(key: SystemMessageKey, locale: AssistantLocale): string {
  return SYSTEM_MESSAGES[key][locale];
}
