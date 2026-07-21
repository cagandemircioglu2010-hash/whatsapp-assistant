export type AssistantLocale = "tr" | "en";

export type SystemMessageKey =
  | "unsupportedType"
  | "rateLimited"
  | "processingFailed"
  | "privacyInfo"
  | "erasureRequested"
  | "accessRequested";

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
  },
  privacyInfo: {
    tr:
      "Gizlilik: Hakkınızda yalnızca şifreli telefon numaranız, departman/rol bilginiz, saklama süresi boyunca mesaj içerikleriniz ve işlem kayıtlarının denetim üst verisi tutulur. Verilerinizin silinmesini istemek için \"verilerimi sil\" yazın.",
    en:
      "Privacy: We hold only your encrypted phone number, your department/role, your message content for the retention window, and audit metadata of actions. To request erasure of your data, reply \"delete my data\"."
  },
  erasureRequested: {
    tr: "Silme talebiniz alındı ve kaydedildi. Bir yönetici talebinizi işleme alacaktır.",
    en: "Your erasure request has been received and logged. An administrator will process it."
  },
  accessRequested: {
    tr: "Erişim talebiniz alındı ve kaydedildi. Bir yönetici en kısa sürede değerlendirecektir.",
    en: "Your access request has been received and logged. An administrator will review it shortly."
  }
};

export function systemMessage(key: SystemMessageKey, locale: AssistantLocale): string {
  return SYSTEM_MESSAGES[key][locale];
}
