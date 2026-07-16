# Company WhatsApp Assistant

Yetkili çalışanlara WhatsApp üzerinden toplu satış, aktif proje ve geciken görev bilgisi veren
TypeScript/PostgreSQL, MCP ve OpenAI backend'i. Uygulama Meta webhook'larını doğrular, kullanıcıyı
telefon whitelist'iyle yetkilendirir, şirket verisini salt-okunur reporting view'larından alır ve kısa
Türkçe cevap gönderir.

## Güvenlik ve güvenilirlik özellikleri

- Meta `X-Hub-Signature-256` HMAC doğrulaması; production'da kapatılamaz
- Sabit-zamanlı webhook verify-token karşılaştırması
- Yetkisiz numaraya cevap göndermeme ve mesaj içeriğini saklamama
- Telefon için HMAC-SHA256 blind index; ham telefon yerine AES-256-GCM şifreli değer
- Mesaj içerikleri için rastgele nonce ve authenticated purpose binding kullanan AES-256-GCM envelope
- Key ID içeren, eski anahtarlarla decrypt edilebilen key-ring rotasyonu
- Varsayılan 30 günlük otomatik mesaj-içeriği temizliği
- DB tabanlı idempotent iş kuyruğu; iki dakikadan uzun takılan işleri ve açık hataları en fazla üç kez kurtarma
- Giden cevap için inbound mesaj başına tekil outbox rezervasyonu
- Ağ/5xx sonucu veya başarı cevabı belirsiz teslimatlarda kopya riskini azaltan retry engeli ve audit kaydı
- Meta `sent`, `delivered`, `read` ve `failed` durum güncellemeleri
- Kullanıcı başına token-bucket rate limit, 256 KiB body limiti, global batch sınırı ve kontrol-karakter temizliği
- DB'de kalıcı kuyrukla birlikte sınırlı worker concurrency ve taşma durumunda güvenli recovery
- Resource permission kontrolü ve çalışanlar için zorunlu departman kapsamı
- Modelin yalnızca kullanıcının izinli MCP araçlarını görmesi
- Şirket DB'si için view-only rol; uygulama DB'si için ayrı minimum-yetkili runtime rolü
- Parametreli SQL, read-only transaction, statement/lock/idle-transaction timeout'ları
- Mesaj, telefon, e-posta, token, key ve DB URL değerlerini loglardan maskeleme
- OpenAI Responses API'de `store=false`, domain-separated hash `safety_identifier` ve sınırlı tool döngüsü
- Pinned GitHub Actions, CodeQL, Dependabot, coverage eşiği, adversarial/stress testleri ve history secret scan

## Mesaj akışı

```text
Meta webhook
  -> raw body üzerinde HMAC doğrulaması
  -> payload ve boyut sınırları
  -> telefon normalizasyonu + blind-index whitelist
  -> şifreli ve idempotent DB kuyruğuna kayıt
  -> Meta'ya hızlı HTTP 200
  -> background worker / stale-job recovery
  -> permission + departman kapsamı
  -> MCP aracı + READ ONLY reporting view
  -> OpenAI cevabı veya deterministik fallback
  -> tekil outbox rezervasyonu
  -> WhatsApp gönderimi + teslimat/audit kaydı
```

## Gereksinimler

- Node.js 24 LTS (`>=24.14.0 <25`)
- PostgreSQL 13+
- Yerel DB için Docker Desktop

## Yerel kurulum

1. Ortam dosyasını oluştur ve dependency'leri kur:

```bash
cp .env.example .env
npm ci --ignore-scripts
```

2. Mac Terminal'de birbirinden farklı güvenli değerler üret:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

`.env` içinde en az şu alanları doldur:

```env
POSTGRES_PASSWORD=<yerel-docker-parolasi>
PHONE_HASH_SECRET=<openssl-rand-hex-32-ciktisi>

DATA_ENCRYPTION_ACTIVE_KEY_ID=2026_07
DATA_ENCRYPTION_KEYS={"2026_07":"<openssl-rand-base64-32-ciktisi>"}
MESSAGE_WORKER_CONCURRENCY=4

APP_RUNTIME_PASSWORD=<ayri-uzun-parola>
COMPANY_READONLY_PASSWORD=<baska-bir-uzun-parola>
```

URL parolalarını aynı değerlerle elle güncelle. `dotenv`, URL içindeki `${VARIABLE}` ifadelerini otomatik
genişletmez.

3. DB'yi ve rolleri hazırla:

```bash
docker compose up -d
npm run db:migrate
npm run db:provision-app-role -- --confirm-dedicated-database
npm run db:provision-readonly -- --confirm-dedicated-database
```

Uygulama migration'ları `DATABASE_ADMIN_URL` ile çalışır. Çalışan backend'in `DATABASE_URL` değeri
`APP_RUNTIME_USER` ve `APP_RUNTIME_PASSWORD` ile oluşturulan URL olmalıdır.

## Database ayrımı ve yetkiler

```env
DATABASE_ADMIN_URL=<app-db-admin-url>
DATABASE_URL=<restricted-app-runtime-url>

COMPANY_DATABASE_ADMIN_URL=<company-db-admin-url>
COMPANY_READONLY_DATABASE_URL=<reporting-view-only-url>
```

Provision komutları `PUBLIC` üzerinden kalıtılan schema `CREATE` ve database `TEMPORARY` haklarını database
genelinde kaldırır. Bu nedenle yalnızca bu asistan için ayrılmış database/raporlama replica'sında ve
`--confirm-dedicated-database` onayıyla çalıştırılmalıdır; paylaşılan database'de önce diğer rollerle koordine et.

App runtime rolü:

- `users`, `permissions`: `SELECT`
- `messages`: `SELECT`, `INSERT`, `UPDATE`
- `audit_events`: `INSERT`
- migration, schema oluşturma, audit değiştirme/silme ve kaynak şirket tabloları: erişim yok

Company reporting rolü:

- `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, bağlantı limiti `5`
- `default_transaction_read_only=on`
- statement `5s`, lock `2s`, idle transaction `10s`
- `TEMPORARY`, `public` ve `company_source` erişimi revoke
- yalnızca `assistant_reporting.sales_daily`, `active_projects`, `overdue_tasks` için `SELECT`

Gerçek şirket şemasına geçerken `migrations/002_company_reporting.sql` içindeki view'ları mevcut tablo ve
kolonlara eşleştir:

```bash
npm run db:migrate:company
npm run db:provision-readonly -- --confirm-dedicated-database
npm run reports:smoke
```

## Whitelist yönetimi

Tüm raporlara erişebilen manager:

```bash
npm run db:add-user -- \
  --phone "+905551234567" \
  --name "Test Kullanıcı" \
  --department "Management" \
  --role "manager" \
  --permissions "company.sales,company.projects,company.tasks"
```

Yalnızca satış raporuna erişebilen çalışan:

```bash
npm run db:add-user -- \
  --phone "+905551234567" \
  --name "Satış Kullanıcısı" \
  --department "Sales" \
  --role "employee" \
  --permissions "company.sales"
```

`--permissions` verilmezse güvenli varsayılan olarak hiçbir rapor izni tanımlanmaz. Komut her çalıştırıldığında
kullanıcının read permission setini verilen listeyle senkronize eder; önceki fazla izinler kaldırılır. Kullanıcıyı
devre dışı bırak:

```bash
npm run db:set-user-active -- --phone "+905551234567" --active false
```

| Resource | Erişim |
|---|---|
| `company.sales` | Tarih aralığında toplu satış/iade özeti |
| `company.projects` | Aktif proje özeti |
| `company.tasks` | Geciken görevler |

`employee` rolünde proje ve görev sorgusu whitelist'teki departmana zorlanır. `manager`, `executive` ve `admin`
rolleri izinleri varsa departmanlar arası sorgu yapabilir.

## Demo veri

```bash
npm run db:seed-demo
npm run reports:smoke
```

Smoke test yalnızca `COMPANY_READONLY_DATABASE_URL` kullanır.

## WhatsApp ve OpenAI

```env
WHATSAPP_ENABLED=true
WHATSAPP_VERIFY_TOKEN=<en-az-16-karakter-rastgele-token>
WHATSAPP_ACCESS_TOKEN=<Meta-System-User-token>
WHATSAPP_PHONE_NUMBER_ID=<yalnizca-rakam>
WHATSAPP_GRAPH_API_VERSION=v25.0
META_APP_SECRET=<Meta-App-Secret>
REQUIRE_WHATSAPP_SIGNATURE=true

LLM_ENABLED=true
OPENAI_API_KEY=<project-api-key>
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=low
LLM_MAX_TOOL_CALLS=4
LLM_MAX_OUTPUT_TOKENS=700
LLM_TIMEOUT_MS=25000
```

Webhook:

```text
GET  https://<domain>/webhooks/whatsapp
POST https://<domain>/webhooks/whatsapp
```

Health endpoint'leri:

```text
GET /health       # iki DB bağlantısını kontrol eder
GET /health/live  # process liveness
```

Desteklenen deterministik komutlar: `satış özeti`, `aktif projeler`, `geciken görevler`. LLM etkinse daha doğal
sorular MCP function-calling döngüsüne gider; model hatasında deterministik yönlendirici devreye girer.

## Encryption migration ve key rotasyonu

`003_app_data_protection.sql` yeni şifreli kolonları, blind indexi, outbox alanlarını ve recovery indexlerini ekler.
Mevcut plaintext satırları şifrelemek için:

```bash
npm run db:migrate:app
npm run db:encrypt-existing
```

Anahtar rotasyonu:

1. Eski key'i JSON object içinde tut.
2. Yeni 32-byte key ekle ve `DATA_ENCRYPTION_ACTIVE_KEY_ID` değerini yeni ID yap.
3. Backend'i iki key ile deploy et.
4. `npm run db:encrypt-existing` çalıştır; eski key ID'li kayıtlar aktif key ile yeniden şifrelenir.
5. DB ve backup'larda eski key'e bağlı veri kalmadığını doğruladıktan sonra eski key'i kaldır.

Key kaybı şifreli veriyi geri döndürülemez yapar. Key'leri GitHub'a, loglara veya image içine koyma; Render secret
environment variable olarak sakla. DB backup'ları eski plaintext veya eski-key ciphertext içerebileceği için backup
retention ve erişim politikası ayrıca uygulanmalıdır.

## Production rollout sırası

Bu değişiklikler mevcut deployment'a uygulanırken:

1. Uygulama DB backup'ı al.
2. `PHONE_HASH_SECRET`, encryption key-ring, retention ve rate-limit env'lerini Render'a ekle.
3. `npm run db:migrate:app` çalıştır.
4. `npm run db:encrypt-existing` ile telefon ve mesaj plaintext'ini temizle.
5. Dedicated DB doğrulamasından sonra `npm run db:provision-app-role -- --confirm-dedicated-database` çalıştır ve
   `DATABASE_URL` değerini restricted role çevir.
6. Yeni kodu deploy et; `/health` ve `/health/live` kontrol et.
7. Meta test numarasıyla authorized, unauthorized, duplicate ve delivery-status senaryolarını doğrula.

Backfill telefon plaintext'ini temizledikten sonra eski uygulama sürümü whitelist lookup yapamaz. Rollback için DB
backup'ını ve encryption destekli bu kod sürümünü birlikte koru.

## Kontroller

```bash
npm run check
npm run test:stress
npm run security:scan
npm audit --omit=dev --audit-level=moderate
```

`npm run check` type-check, coverage eşikli testler ve production build'i çalıştırır. Test paketi encryption tamper ve
rotasyonunu, webhook imzasını, body sınırını, fuzz/batch davranışını, 500 eşzamanlı mesajı, rate limit'i, outbox
belirsiz-teslimat korumasını, permission/departman kapsamını, MCP protokolünü, LLM tool döngüsünü, migration'ları ve
read-only rapor sorgularını kapsar.

CI ayrıca tüm Git geçmişinde bilinen credential formatlarını tarar. CodeQL haftalık ve her PR'da çalışır; Dependabot
npm ve GitHub Actions güncellemeleri açar.

## Veri güvenliği notları

- `.env`, gerçek token/key, gerçek telefon, mesaj gövdesi ve şirket verisi Git'e eklenmez.
- Yetkili mesaj içeriği yalnızca ciphertext olarak tutulur ve retention süresi dolunca temizlenir.
- Yetkisiz mesaj içeriği DB'ye yazılmaz.
- Audit kayıtlarında ham telefon yerine kısa pseudonymous reference bulunur.
- Model tool argümanında kullanıcı ID'si veya telefon bulunmaz; actor backend oturumuna bağlıdır.
- Reporting view'ları müşteri seviyesindeki satış verisini dışarı çıkarmaz.
- LLM sağlayıcısında API verisinin model eğitimi için kullanılmadığı kurumsal ayar ayrıca doğrulanmalıdır.
- Gerçek secret yanlışlıkla paylaşılırsa history scan sonucuna güvenmeden secret derhal revoke/rotate edilmelidir.

Güvenlik açığı raporlama kuralları için [SECURITY.md](SECURITY.md) dosyasına bak.
