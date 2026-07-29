import type { ConversationTurn } from "../assistant/types.js";

export type MessageIntent = "company_data" | "general_chat" | "uncertain";

export type IntentClassification = {
  intent: MessageIntent;
  confidence: number;
  signals: readonly string[];
};

const BUSINESS_SUBJECT =
  /\b(?:satis\w*|sales?|gelir\w*|revenue|ciro\w*|kar|profit|kazanc\w*|earnings?|gider\w*|expenses?|maliyet\w*|costs?|butce\w*|budgets?|fatura\w*|invoices?|odeme\w*|payments?|tahsilat\w*|stok\w*|stocks?|envanter\w*|inventor(?:y|ies)|urun\w*|products?|siparis\w*|orders?|sevkiyat\w*|shipments?|teslimat\w*|deliver(?:y|ies)|depo\w*|warehouses?|tedarik\w*|suppliers?|procurement|proje\w*|projects?|gorev\w*|tasks?|musteri\w*|customers?|leads?|calisan\w*|employees?|personel\w*|staff|ik|hr|maas\w*|salar(?:y|ies)|departman\w*|departments?|kampanya\w*|campaigns?|pazarlama\w*|marketing|donusum\w*|conversion\w*|destek\w*|support|ticket\w*|sozlesme\w*|contracts?|abonelik\w*|subscriptions?|iade\w*|refunds?|kpi\w*|metrik\w*|metrics?|rapor\w*|reports?|performans\w*|performance|hedef\w*|targets?|forecast\w*|tahmin\w*|veritabani\w*|database\w*|sema\w*|schema\w*|tablo\w*|tables?|kolon\w*|columns?|sutun\w*)\b/;

const OWNERSHIP_CONTEXT =
  /\b(?:sirket(?:imiz|imizin|imize|imizde|imizden|imi|imin|in)?|firm(?:amiz|amizin|amiza|amizda|amizdan)|bizim|our|my\s+company|company'?s|the\s+company|company\s+database|demo\s+database)\b/;

const POSSESSED_BUSINESS_TERM =
  /\b(?:satis|gelir|ciro|kar|kazanc|gider|maliyet|butce|fatura|odeme|tahsilat|stok|envanter|urun|siparis|sevkiyat|teslimat|depo|tedarikci|proje|gorev|musteri|calisan|personel|maas|departman|kampanya|pazarlama|donusum|destek|ticket|sozlesme|abonelik|iade|kpi|metrik|rapor|performans|hedef|tahmin|veritabani|tablo)(?:lar|ler)?(?:imiz|umuz)(?:in|un|e|a|de|da|den|dan|i|u)?\w*\b/;

const POSSESSED_QUALIFIER =
  /\b(?:durum|sayi|oran|sonuc|performans|butce|hedef|toplam|gelir|gider)(?:lar|ler)?(?:imiz|umuz)(?:in|un|e|a|de|da|den|dan|i|u)?\w*\b/;

const FIXED_COMPANY_REQUEST =
  /\b(?:satis\w*\s+ozet\w*|sales\s+summar(?:y|ies)|aktif\w*\s+proje\w*|active\s+projects?|gecik\w*\s+gorev\w*|overdue\s+tasks?)\b/;

const SCHEMA_INSPECTION_REQUEST =
  /\b(?:veritabani\w*|database\w*|sema\w*|schema\w*|tablo\w*|tables?|kolon\w*|columns?|sutun\w*)\b.*\b(?:liste\w*|list|show|goster\w*|describe|tanimla\w*|inspect|incele\w*|tara\w*|scan|enumerate)\b/;

const COMPANY_MUTATION_REQUEST =
  /\b(?:sil\w*|delete|drop|update|guncelle\w*|insert|ekle\w*|degistir\w*|modify)\b.*\b(?:veritabani\w*|database\w*|tablo\w*|tables?|satis\w*|sales?|proje\w*|projects?|musteri\w*|customers?)\b|\b(?:veritabani\w*|database\w*|tablo\w*|tables?)\b.*\b(?:sil\w*|delete|drop|update|guncelle\w*|insert|ekle\w*|degistir\w*|modify)\b/;

const COMPANY_PERFORMANCE =
  /\b(?:ne\s+kadar\s+(?:kazandik|sattik|harcadik|urettik)|kar\s+ettik|islerimiz\s+nasil\s+gidiyor|how\s+much\s+did\s+we\s+(?:make|sell|spend)|did\s+we\s+make\s+(?:a\s+)?profit|how\s+is\s+(?:our\s+)?business\s+going)\b/;

const COMPANY_CLARIFICATION =
  /\b(?:sirket\s+veri\w*|sirketimiz\w*\s+icin|sirket\w*\s+gore|bizim\s+sirket|company\s+data|for\s+(?:our|the)\s+company|according\s+to\s+(?:our|the)\s+company)\b/;

const GENERAL_CLARIFICATION =
  /\b(?:genel\s+olarak|genel\s+bilgi|sirketten\s+bagimsiz|in\s+general|generally|general\s+knowledge|not\s+(?:about|for)\s+the\s+company)\b/;

const STRONG_DATA_QUALIFIER =
  /\b(?:kac|how\s+(?:many|much)|ne\s+kadar|toplam\w*|totals?|count|adet|amount|ortalama\w*|averages?|en\s+(?:cok|az|iyi|kotu|yuksek|dusuk)|highest|lowest|best|worst|top\s+\d+|bu\s+(?:ay|hafta|yil)(?:ki)?|gecen\s+(?:ay|hafta|yil)|this\s+(?:month|week|year)|last\s+(?:month|week|year)|today|bugun|current|latest|son\w*|onceki|previous|tekrar\w*|repeat|gecik\w*|overdue|odenmem\w*|unpaid|basarisiz\w*|failed|karsilastir\w*|compare|analiz\w*|analy[sz]e|trend\w*|dagilim\w*|breakdown)\b/;

const AMBIGUOUS_DATA_QUALIFIER =
  /\b(?:durum\w*|status|nasil|how\s+are|how\s+is|liste\w*|list|show|goster\w*|get|getir\w*|bak\w*|goruntule\w*|display|incele\w*|check)\b/;

const GENERAL_KNOWLEDGE_REQUEST =
  /\b(?:nedir|ne\s+demek|what\s+is|what\s+does|define|definition|tanimla\w*|explain|acikla\w*|how\s+to|how\s+do\s+(?:i|you|we)|nasil\s+\w*(?:ilir|ulur)|ogret\w*|teach|example|ornek\w*|fikir\w*|ideas?|brainstorm|avantaj\w*|dezavantaj\w*|pros?\s+and\s+cons?)\b/;

const CONTENT_TASK =
  /\b(?:translate|translation|cevir\w*|write|compose|draft|rewrite|yaz\w*|duzelt\w*|summarize|summarise|ozetle\w*|proofread|email|e-?posta|hikaye\w*|story|siir\w*|poem)\b/;

const GENERAL_CONVERSATION =
  /\b(?:merhaba|selam|gunaydin|iyi\s+(?:gunler|aksamlar|geceler)|hello|hi|hey|thanks?|thank\s+you|tesekkur\w*|nasilsin|how\s+are\s+you|ismin\s+ne|adin\s+ne|who\s+are\s+you|sen\s+kimsin|ne\s+yapabilirsin|what\s+can\s+you\s+do|yardim|help|menu)\b/;

const MATH_EXPRESSION =
  /(?:^|\s)(?:[-+*/%().\d]+\s*){3,}(?:$|[=?])/;

const FOLLOW_UP_REFERENCE =
  /^(?:peki|ya|ve|ayrica|tamam|what\s+about|how\s+about|and|also)\b|\b(?:gecen\s+(?:ay|hafta|yil)|last\s+(?:month|week|year)|onceki|previous|ayni|same|onlar|those|it|that\s+one)\b/;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("ı", "i")
    .replace(/[^a-z0-9$%+\-*/=?.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classification(
  intent: MessageIntent,
  confidence: number,
  ...signals: string[]
): IntentClassification {
  return { intent, confidence, signals };
}

function classifyStandalone(value: string): IntentClassification {
  const normalized = normalize(value);
  const hasBusinessSubject = BUSINESS_SUBJECT.test(normalized);
  const hasOwnership =
    OWNERSHIP_CONTEXT.test(normalized) ||
    POSSESSED_BUSINESS_TERM.test(normalized) ||
    (hasBusinessSubject && POSSESSED_QUALIFIER.test(normalized));

  if (COMPANY_CLARIFICATION.test(normalized)) {
    return classification("company_data", 0.99, "company-clarification");
  }
  if (GENERAL_CLARIFICATION.test(normalized)) {
    return classification("general_chat", 0.99, "general-clarification");
  }
  if (hasBusinessSubject && hasOwnership) {
    return classification("company_data", 0.99, "business-subject", "company-ownership");
  }
  if (FIXED_COMPANY_REQUEST.test(normalized)) {
    return classification("company_data", 0.98, "fixed-company-request");
  }
  if (SCHEMA_INSPECTION_REQUEST.test(normalized)) {
    return classification("company_data", 0.98, "schema-inspection");
  }
  if (COMPANY_MUTATION_REQUEST.test(normalized)) {
    return classification("company_data", 0.98, "company-mutation-attempt");
  }
  if (COMPANY_PERFORMANCE.test(normalized)) {
    return classification("company_data", 0.98, "company-performance");
  }

  const hasGeneralKnowledgeRequest = GENERAL_KNOWLEDGE_REQUEST.test(normalized);
  const hasContentTask = CONTENT_TASK.test(normalized);
  if (hasGeneralKnowledgeRequest || hasContentTask) {
    return classification(
      "general_chat",
      0.97,
      hasGeneralKnowledgeRequest ? "general-knowledge" : "content-task"
    );
  }
  if (GENERAL_CONVERSATION.test(normalized)) {
    return classification("general_chat", 0.99, "general-conversation");
  }
  if (MATH_EXPRESSION.test(normalized)) {
    return classification("general_chat", 0.99, "calculation");
  }

  if (hasBusinessSubject && STRONG_DATA_QUALIFIER.test(normalized)) {
    return classification("company_data", 0.92, "business-subject", "data-query");
  }
  if (hasBusinessSubject) {
    return classification(
      "uncertain",
      AMBIGUOUS_DATA_QUALIFIER.test(normalized) ? 0.45 : 0.5,
      "business-subject",
      "missing-company-context"
    );
  }
  return classification("general_chat", 0.85, "default-general");
}

export function classifyMessageIntent(
  value: string,
  history: readonly ConversationTurn[] = []
): IntentClassification {
  const current = classifyStandalone(value);
  if (
    current.signals.includes("default-general") &&
    FOLLOW_UP_REFERENCE.test(normalize(value))
  ) {
    const previousInbound = [...history].reverse().find((turn) => turn.direction === "inbound");
    if (!previousInbound) {
      return classification("uncertain", 0.35, "context-dependent-follow-up");
    }
    const previous = classifyStandalone(previousInbound.text);
    if (previous.intent === "company_data") {
      return classification("company_data", 0.9, "company-follow-up");
    }
    if (previous.intent === "uncertain") {
      return classification("uncertain", 0.4, "ambiguous-follow-up");
    }
  }
  return current;
}
