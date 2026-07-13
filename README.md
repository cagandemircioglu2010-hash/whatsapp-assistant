# Company WhatsApp Assistant

WhatsApp üzerinden yetkili çalışanlara şirket satış, proje ve görev bilgilerini veren güvenli TypeScript/PostgreSQL, MCP ve OpenAI backend'i.

Bu sürüm 3–6. gün kapsamını tamamlar:

- `users`, `permissions`, `messages` ve `audit_events` tabloları
- E.164 telefon numarasıyla whitelist kontrolü
- Yetkisiz numaralara cevap göndermeme
- Yetkisiz mesajların içeriğini saklamama
- İdempotent gelen mesaj kaydı ve en fazla üç işleme denemesi
- Gelen ve giden konuşma geçmişi
- Hassas alanları ve metin içindeki telefon/e-posta/token/DB URL değerlerini loglardan maskeleme
- Meta webhook HMAC imza doğrulaması
- Ayrı ve salt-okunur şirket DB bağlantısı
- Yalnızca kontrollü reporting view'larına erişebilen PostgreSQL rolü
- Parametreli satış özeti, aktif proje ve geciken görev sorguları
- Kaynak bazlı kullanıcı izin kontrolü
- Doğrulanmış kullanıcıya bağlanan gerçek MCP client/server oturumu
- `get_sales_summary`, `get_active_projects` ve `get_overdue_tasks` MCP araçları
- OpenAI Responses API function-calling döngüsü
- Model hatasında deterministik komut yönlendiriciye otomatik dönüş
- Stateless API kullanımı (`store=false`) ve hash'lenmiş `safety_identifier`

## Mesaj akışı

```text
WhatsApp webhook
  -> Meta imza doğrulaması
  -> mesaj ID ile idempotency kontrolü
  -> telefon normalizasyonu ve whitelist
  -> OpenAI Responses tool seçimi
  -> kullanıcıya bağlı MCP oturumu
  -> resource permission kontrolü
  -> READ ONLY şirket sorgusu/view
  -> tool sonucunun modele dönmesi
  -> WhatsApp cevabı
  -> mesaj, MCP çağrısı ve audit kaydı
```

## Gereksinimler

- Node.js 20 veya üzeri
- PostgreSQL 13 veya üzeri
- Yerel geliştirme için Docker Desktop kullanılabilir

## 1. Yerel kurulum

```bash
cp .env.example .env
npm install
docker compose up -d
npm run db:migrate
npm run db:provision-readonly
```

`.env` içindeki şu değerleri mutlaka değiştir:

```env
COMPANY_READONLY_PASSWORD=<uzun-rastgele-parola>
COMPANY_READONLY_DATABASE_URL=postgresql://company_assistant_reader:<aynı-parola>@localhost:5432/company_assistant
PHONE_HASH_SECRET=<en-az-32-rastgele-karakter>
```

Mac'te güvenli rastgele değer üretmek için:

```bash
openssl rand -hex 32
```

## 2. Whitelist kullanıcısı ekleme

Tüm üç rapora erişebilen kullanıcı:

```bash
npm run db:add-user -- \
  --phone "+905551234567" \
  --name "Test Kullanıcı" \
  --department "Management" \
  --role "manager"
```

Yalnızca satış raporuna erişebilen kullanıcı:

```bash
npm run db:add-user -- \
  --phone "+905551234567" \
  --name "Satış Kullanıcısı" \
  --department "Sales" \
  --permissions "company.sales"
```

Desteklenen permission kaynakları:

| Kaynak | Verdiği erişim |
|---|---|
| `company.sales` | Son yedi günlük toplu satış özeti |
| `company.projects` | Aktif projeler |
| `company.tasks` | Geciken görevler |

Bir kullanıcıyı kapatmak için:

```sql
UPDATE users SET is_active = FALSE, updated_at = NOW()
WHERE phone_e164 = '+905551234567';
```

## 3. Demo şirket verisi

```bash
npm run db:seed-demo
npm run reports:smoke
```

Smoke test üç sorguyu `COMPANY_READONLY_DATABASE_URL` üzerinden çalıştırır. Bu nedenle admin bağlantısıyla yanlışlıkla yazma yetkisi kullanmaz.

## 4. Gerçek şirket veritabanına bağlama

Yerel örnekte uygulama ve şirket verisi aynı PostgreSQL database'inde bulunabilir. Üretimde iki bağlantı ayrı tutulur:

```env
DATABASE_URL=<users-permissions-messages-db>
DATABASE_ADMIN_URL=<uygulama-db-migration-bağlantısı>

COMPANY_DATABASE_ADMIN_URL=<şirket-db-view-kurulum-bağlantısı>
COMPANY_READONLY_DATABASE_URL=<yalnızca-reporting-view-okuyabilen-bağlantı>
```

Uygulama tablolarını kur:

```bash
npm run db:migrate:app
```

`migrations/002_company_reporting.sql` içindeki üç view'ı şirketin mevcut tablo ve kolon isimlerine eşleştir. Bu migration'daki `company_source` tabloları çalıştırılabilir referans şemadır. Gerçek şemaya eşleştirdikten sonra şirket DB tarafını kur:

```bash
npm run db:migrate:company
npm run db:provision-readonly
npm run reports:smoke
```

Read-only rol şu korumaları birlikte kullanır:

- `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`
- Bağlantı limiti `5`
- `default_transaction_read_only=on`
- Sorgu timeout'u `5s`
- Lock timeout'u `2s`
- Kaynak tablolara erişim yok
- Yalnızca `assistant_reporting` altındaki üç view için `SELECT`
- Uygulama kodunda ayrıca `BEGIN READ ONLY`

## 5. WhatsApp'ı açma

Meta test numarası ve webhook hazır olduğunda:

```env
WHATSAPP_ENABLED=true
WHATSAPP_VERIFY_TOKEN=<rastgele-token>
WHATSAPP_ACCESS_TOKEN=<meta-access-token>
WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
WHATSAPP_GRAPH_API_VERSION=<Meta-dashboard-sürümü>
META_APP_SECRET=<meta-app-secret>
REQUIRE_WHATSAPP_SIGNATURE=true
```

Webhook URL'leri:

```text
GET  https://<domain>/webhooks/whatsapp
POST https://<domain>/webhooks/whatsapp
```

Sunucuyu başlat:

```bash
npm run dev
```

Şu mesajlar doğrudan çalışır:

```text
satış özeti
aktif projeler
geciken görevler
```

Yetkisiz numaranın mesaj içeriği kaydedilmez ve numaraya hiçbir WhatsApp cevabı gönderilmez. Yetkili fakat ilgili kaynağa izni olmayan kullanıcıya erişim reddi cevabı gönderilir.

## 6. MCP sunucusu

WhatsApp uygulaması her mesaj için gerçek bir MCP client/server oturumu açar. Oturum, backend'in whitelist'ten doğruladığı kullanıcıya bağlanır. Modelin tool argümanlarında kullanıcı veya telefon alanı bulunmaz.

MCP araçları:

| Araç | Permission | İşlev |
|---|---|---|
| `get_sales_summary` | `company.sales` | Tarih aralığında satış ve iade özeti |
| `get_active_projects` | `company.projects` | Aktif proje ve görev sayıları |
| `get_overdue_tasks` | `company.tasks` | Geciken görevler |

Sunucuyu Claude Desktop veya MCP Inspector gibi ayrı bir istemcide stdio üzerinden çalıştırmak için whitelist'teki bir kullanıcıyı servis kimliği olarak seç:

```bash
MCP_ACTOR_PHONE="+905551234567" npm run mcp:stdio
```

STDIO sunucusu stdout'a uygulama logu yazmaz; JSON-RPC kanalı korunur. Araç çağrıları yine DB audit tablosuna kaydedilir.

## 7. OpenAI Responses entegrasyonu

`.env` içinde:

```env
LLM_ENABLED=true
OPENAI_API_KEY=<project-api-key>
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=low
LLM_MAX_TOOL_CALLS=4
LLM_MAX_OUTPUT_TOKENS=700
LLM_TIMEOUT_MS=25000
```

Akış:

1. Model MCP araçlarının JSON Schema tanımlarını alır.
2. Uygun aracı seçip yapılandırılmış argüman üretir.
3. Backend çağrıyı kullanıcıya bağlı MCP oturumunda çalıştırır.
4. MCP permission ve input validation uygular.
5. Tool sonucu Responses API'ye `function_call_output` olarak döner.
6. Model kısa Türkçe WhatsApp cevabını üretir.

API tarafında `store=false` kullanılır. Model servisi hata verirse desteklenen üç temel komut deterministik yönlendiriciyle cevaplanmaya devam eder.

## 8. Kontroller

```bash
npm run typecheck
npm test
npm run build
```

Testler şunları kapsar:

- Telefon normalizasyonu ve HMAC hashing
- Log redaction
- Meta webhook imzası
- WhatsApp payload ayrıştırma
- Whitelist dışı numaraya cevap verilmemesi
- Permission reddi
- Üç rapor komutunun yönlendirilmesi
- PostgreSQL migration'larının gerçek PostgreSQL uyumlu motor üzerinde çalışması
- Reporting view'larının müşteri seviyesindeki satış bilgisini dışarı çıkarmaması
- Gerçek in-memory MCP protokolü üzerinden tool listeleme ve çağırma
- MCP seviyesinde permission reddi ve input validation
- İki turlu Responses function-calling akışı
- Model hatasında MCP oturumunun güvenli şekilde kapanması

## Veri güvenliği notları

- `.env` hiçbir zaman Git'e eklenmez.
- Telefon numarası yalnızca whitelist tablosunda tutulur; mesajlarda HMAC-SHA256 hash bulunur.
- Uygulama logları mesaj gövdesi, telefon, e-posta, token, parola veya DB bağlantısı içermez.
- Mesaj içeriği konuşma geçmişi için veritabanında saklanır. Üretim öncesinde şirketin ihtiyacına göre otomatik silme/retention süresi belirlenmelidir.
- LLM etkinleştirildiğinde model sağlayıcısında API verisinin model eğitimi için kullanılmadığı kurumsal ayar doğrulanmalıdır.
- Model hiçbir zaman actor ID veya telefon numarasını tool argümanı olarak belirlemez; kimlik yalnızca backend oturum bağlamındadır.
