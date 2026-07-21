# Company WhatsApp Assistant

Yetkili çalışanlara WhatsApp üzerinden yalnızca izinli ve toplulaştırılmış şirket raporları sunan
TypeScript/PostgreSQL, MCP ve OpenAI backend'i. Meta webhook imzası doğrulanır, kimlik whitelist üzerinden
belirlenir, şirket verisi salt-okunur reporting view'larından alınır ve hassas uygulama verisi yaşam döngüsü
boyunca şifreli tutulur.

## Güvenlik modeli

- Telefon, ad, departman ve mesaj gövdesi kayıt UUID'sine bağlı AES-256-GCM `v2` envelope ile şifrelenir.
  Ciphertext başka bir satıra taşınırsa authentication başarısız olur.
- Telefon ve WhatsApp message ID lookup'ları sürümlü HMAC key-ring kullanır. Dual-read rotasyonu sayesinde eski
  ve yeni key aynı rollout sırasında çalışır.
- Identifier, audit-integrity, data-encryption ve OpenAI safety-identifier anahtarları birbirinden ayrıdır.
- Key-ring JSON'u environment yerine `*_FILE` ile KMS/secret-manager tarafından mount edilen dosyadan okunabilir.
- Plaintext identity, message body ve transport-ID kolonları güvenlik backfill'i sonrasında fiziksel olarak düşer.
- Audit olayları DB zaman damgası, monoton sequence, önceki event hash'i ve ayrı HMAC key-ring ile zincirlenir.
  Retention sırasında silinen prefix için ayrıca HMAC-authenticated anchor korunur.
- Yetkisiz gönderenin mesaj/audit satırı oluşturmasına izin verilmez. Güvenlik audit'i global olarak örneklenir.
- Global, sender ve kullanıcı limitleri PostgreSQL'de atomik tutulur; restart ve çoklu replica limitleri aşamaz.
- Runtime lifecycle job'ı içerik minimizasyonunu, terminal mesaj/audit silmeyi ve rate-limit temizliğini otomatik
  uygular. Security-definer fonksiyon runtime rolüne tablo `DELETE` yetkisi vermeden çalışır.
- Startup; gerekli migration'ı, decommission durumunu, encryption/audit-integrity canary'sini ve reporting view'larını
  doğrulamadan production portunu açmaz.
- Meta `X-Hub-Signature-256` doğrulaması production'da kapatılamaz. Webhook kapatılan bir client DB'si
  `service_state` üzerinden tekrar veri kabul etmez; farklı bir WhatsApp phone-number ID'sine ait imzalı event de
  işlenmez.
- OpenAI çağrıları `store=false`, ayrı safety identifier, izinli MCP tool listesi, bounded tool loop ve deterministik
  fallback kullanır.
- Uygulama ve reporting DB rolleri ayrıdır; reporting transaction'ları zorunlu read-only çalışır.
- CI: pinned Actions, CodeQL, locked dependency audit, Dependabot, history secret scan, npm audit, coverage/stress testleri
  ve Trivy production-image taraması.

## Akış

```text
Meta imzalı webhook
  -> body/payload/global/sender limitleri
  -> normalize telefon + versioned HMAC whitelist
  -> yalnızca authorized mesajı record-bound ciphertext olarak kalıcı kuyruğa al
  -> bounded worker + distributed user limit
  -> permission + department scope
  -> read-only reporting view / izinli MCP tool
  -> OpenAI veya deterministik cevap
  -> idempotent outbox + WhatsApp delivery state
  -> chained audit + otomatik retention
```

## Gereksinimler

- Node.js 24 LTS (`>=24.14.0 <25`)
- PostgreSQL 14+; production için desteklenen güncel minor sürüm
- Yerel geliştirme için Docker

## Yerel kurulum

```bash
cp .env.example .env
npm ci --ignore-scripts
docker compose up -d
```

Her key için farklı değer üret:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Minimum güvenlik konfigürasyonu:

```env
DATA_ENCRYPTION_ACTIVE_KEY_ID=local_2026
DATA_ENCRYPTION_KEYS={"local_2026":"<random-base64-32>"}

IDENTIFIER_HASH_ACTIVE_KEY_ID=local_2026
IDENTIFIER_HASH_KEYS={"local_2026":"<different-random-base64-32>"}

AUDIT_INTEGRITY_ACTIVE_KEY_ID=local_2026
AUDIT_INTEGRITY_KEYS={"local_2026":"<different-random-base64-32>"}

SAFETY_IDENTIFIER_SECRET=<different-random-hex-32>
```

Secret manager dosya mount'u kullanılıyorsa inline JSON yerine yalnızca karşılık gelen dosyayı ayarla:

```env
DATA_ENCRYPTION_KEYS_FILE=/run/secrets/data-encryption-keys.json
IDENTIFIER_HASH_KEYS_FILE=/run/secrets/identifier-hash-keys.json
AUDIT_INTEGRITY_KEYS_FILE=/run/secrets/audit-integrity-keys.json
```

Yeni ve boş DB:

```bash
npm run db:migrate
npm run db:provision-app-role -- --confirm-dedicated-database
npm run db:provision-readonly -- --confirm-dedicated-database
npm run db:seed-demo
npm run reports:smoke
```

`DATABASE_URL` restricted application rolünü, `COMPANY_READONLY_DATABASE_URL` yalnızca reporting view'larını
okuyabilen rolü kullanmalıdır. Production runtime; `DATABASE_ADMIN_URL`, `COMPANY_DATABASE_ADMIN_URL`,
`POSTGRES_PASSWORD`, provisioning role password'leri veya migration secret'ları mevcutsa fail-closed başlatılmaz.
Migration/admin job ve çalışan service için ayrı secret setleri kullan.

## Production TLS

Production config hem uygulama hem şirket DB'si için `verify-full` zorunlu kılar. TLS parametrelerini database URL
içine koyma; tek doğruluk kaynağı aşağıdaki alanlardır:

```env
DATABASE_SSL_MODE=verify-full
DATABASE_CA_CERT_FILE=/run/secrets/app-db-ca.pem
COMPANY_DATABASE_SSL_MODE=verify-full
COMPANY_DATABASE_CA_CERT_FILE=/run/secrets/company-db-ca.pem
```

Public CA kullanılıyorsa CA dosyası boş bırakılabilir. `disable` production'da startup validation'dan geçmez.

## Mevcut deployment'ı güvenlik v2'ye yükseltme

Bu sıra eski veriyi kaybetmeden 004 sürümünden 006'ya taşır:

1. DB backup/snapshot al; yazılı legal-hold ve rollback kararını kaydet.
2. Backend ve bütün worker replica'larını durdur.
3. Yeni encryption, identifier ve audit key-ring'lerini secret manager'a ekle.
4. Eski `PHONE_HASH_SECRET` değerini raw byte olarak base64'e çevir ve geçici `legacy` entry olarak identifier
   ring'e ekle:

   ```bash
   printf %s "$PHONE_HASH_SECRET" | base64
   ```

   ```env
   IDENTIFIER_HASH_ACTIVE_KEY_ID=2026_07
   IDENTIFIER_HASH_KEYS={"2026_07":"<new-key>","legacy":"<old-secret-as-base64>"}
   LEGACY_IDENTIFIER_HASH_KEY_ID=legacy
   ```

5. Prepare migration, backfill ve finalize migration'ı sırayla çalıştır:

   ```bash
   npm run db:migrate:security-prepare
   npm run db:backfill-security
   npm run db:migrate:app
   npm run db:provision-app-role -- --confirm-dedicated-database
   npm run db:verify-audit
   ```

6. Yeni image'ı deploy et ve kontrol et:

   ```bash
   NODE_ENV=production npm run ops:readiness
   npm run reports:smoke
   ```

   Readiness komutunu admin/provisioning değişkenleri bulunmayan production runtime secret setiyle çalıştır.

7. Meta test numarasıyla authorized, unauthorized, duplicate, delivery status ve uncertain-delivery senaryolarını
   doğrula.

Finalize migration; plaintext kolon, `v1` ciphertext, key-id'siz hash veya imzasız audit olayı görürse fail-closed
durur. Eski uygulama sürümü 006 sonrasında çalışmaz. Rollback yalnızca güvenlik-v2 kodu ve uyumlu backup ile
yapılmalıdır.

## Key rotasyonu

1. Yeni random key'i ilgili JSON ring'e ekle; eskisini kaldırma.
2. Active key ID'yi değiştir ve bütün replica'lara aynı ring'i deploy et.
3. `npm run db:backfill-security` ile decrypt edilebilir PII/ciphertext ve telefon lookup'unu aktif key'e taşı.
4. `npm run db:verify-audit` çalıştır.
5. Identifier eski key'ini en uzun message-record retention; audit eski key'ini en uzun audit retention ve backup
   süresi dolmadan kaldırma. Eski WhatsApp message ID'nin raw değeri saklanmadığı için bu süre zorunludur.
6. DB, replica, export ve backup'ta eski key'e bağlı veri kalmadığını doğruladıktan sonra secret-manager revision'ını
   imha et.

## Whitelist ve kullanıcı silme

```bash
npm run db:add-user -- \
  --phone "+905551234567" \
  --name "Satış Kullanıcısı" \
  --department "Sales" \
  --role employee \
  --permissions "company.sales"

npm run db:set-user-active -- --phone "+905551234567" --active false
```

Birden çok kullanıcıyı tek seferde eklemek için JSON dosyasıyla toplu yükleme
(tüm satırlar önce doğrulanır, sonra tek transaction'da uygulanır):

```bash
# users.json: [{ "phone": "+90...", "name": "Ada", "role": "employee",
#               "department": "Sales", "locale": "tr",
#               "permissions": ["company.sales"] }]
npm run db:whitelist-batch -- --file users.json
```

Kullanıcılar WhatsApp üzerinden "erişim istiyorum" yazarak erişim, "verilerimi
sil" yazarak silme talebi oluşturabilir. Bu talepler yalnızca denetim kaydına
yazılır (çalışan servise whitelist yazma yetkisi verilmez); operatör görüntüler:

```bash
npm run db:list-access-requests            # son 14 gün, maskeli telefonlar
npm run db:list-access-requests -- --days 30 --full
```

## Kendi kendine servis komutları ve güvenlik

- **Gizlilik / KVKK**: kullanıcı "gizlilik" yazınca hangi verilerin tutulduğunu
  öğrenir; "verilerimi sil" ile silme talebi denetim kaydına düşer.
- **Kötüye kullanım kilidi**: bir gönderici dakikada
  `ABUSE_LOCKOUT_THRESHOLD_PER_MINUTE` sınırını aşan yetkisiz mesaj gönderirse
  kalan süre boyunca sessizce yok sayılır ve `whatsapp.lockout` olarak
  denetlenir (`/health` üzerinde `lockedOutSenders`).
- **Replay koruması**: `WEBHOOK_MESSAGE_MAX_AGE_SECONDS` > 0 ise Meta zaman
  damgası pencere dışındaki webhook mesajları reddedilir (imza doğrulamasına ek).
- **İmzalı olay bildirimleri**: `INTEGRATION_WEBHOOK_URL` +
  `INTEGRATION_WEBHOOK_SECRET` ayarlıysa kilitlenme ve kalıcı gönderim
  hataları, gövde üzerinden HMAC (`x-assistant-signature`) ile imzalanıp POST
  edilir. Varsayılan olarak kapalıdır ve asıl akışı hiçbir zaman bloke etmez.

## LLM sağlayıcısı

Ücretsiz-katman testleri için Gemini kullanılabilir:

```env
LLM_ENABLED=true
LLM_PROVIDER=gemini
GEMINI_API_KEY=<google-ai-studio-api-key>
GEMINI_MODEL=gemini-3.5-flash
```

Gemini ücretsiz katmanındaki istek ve yanıtlar Google ürünlerini iyileştirmek için kullanılabilir. OpenAI kullanmak
için `LLM_PROVIDER=openai`, `OPENAI_API_KEY` ve `OPENAI_MODEL` ayarlanır.

Kullanıcı bazlı KVKK/GDPR erasure iki aşamalıdır. İlk komut yalnızca dry-run ve confirmation reference üretir:

```bash
npm run db:erase-user-data -- --phone "+905551234567"
npm run db:erase-user-data -- \
  --phone "+905551234567" \
  --confirm-reference <dry-run-reference> \
  --confirm-service-stopped \
  --confirm-erase-user-data
```

Execute öncesinde bütün service/worker replica'larını durdurmak zorunludur; bu, silme sırasında in-flight mesaj
işlenmesini engeller. Kullanıcı, permission, mesaj ve rate-limit verisi silinir. Audit'in mutable FK'leri `NULL` olur;
önceden üretilmiş keyed pseudonymous reference zincirin doğrulanabilirliğini korur. Bu referanslar raw PII değildir
ama anahtarlar tutulduğu sürece pseudonymous personal data kabul edilip onaylı audit retention/legal-basis kapsamında
korunmalıdır.

## Otomatik retention ve health

```env
MESSAGE_RETENTION_DAYS=30
MESSAGE_RECORD_RETENTION_DAYS=90
AUDIT_RETENTION_DAYS=365
DATA_LIFECYCLE_INTERVAL_MINUTES=60
```

Her replica lifecycle fonksiyonunu tetikleyebilir; PostgreSQL advisory lock yalnızca birinin çalışmasını sağlar.
`maintenance_job_state` son başlangıç/başarı, güvenli sonuç sayıları ve failure code tutar. İsteğe bağlı admin tetikleme:

```bash
npm run db:purge-expired
```

Onaylı legal hold, aynı distributed lock altında otomatik deletion'ı ve user/client erasure'ı durdurur. Önce dry-run,
sonra exact DB confirmation kullan:

```bash
npm run db:set-legal-hold -- --active true --reference LEGAL-2026-001
npm run db:set-legal-hold -- --active true --reference LEGAL-2026-001 \
  --confirm-database <exact-app-database-name> --confirm-legal-hold-change

npm run db:set-legal-hold -- --active false --reference RELEASE-2026-001 \
  --confirm-database <exact-app-database-name> --confirm-legal-hold-change --confirm-retention-resumes
```

Reference alanına PII değil approval/release ticket ID yaz.

```text
GET /health       schema, decommission, lifecycle heartbeat, reporting view ve queue backlog readiness
GET /health/live  yalnızca process liveness
```

## Client kapanışı

Asistan DB dry-run:

```bash
npm run db:erase-client-data
```

Meta webhook kapatılıp bütün servisler durdurulduktan sonra:

```bash
npm run db:erase-client-data -- \
  --confirm-database <exact-app-database-name> \
  --confirm-service-stopped \
  --confirm-provider-webhook-disabled \
  --confirm-erase-client-data
```

Komut persistent decommission switch'i açar ve users, permissions, messages, audit chain, rate-limit ve canary
verisini doğrulayarak siler. Servis aynı DB ile yeniden başlatılamaz.

Client-owned reporting source ancak ayrı yazılı yetkiyle silinir:

```bash
npm run db:erase-company-source
npm run db:erase-company-source -- \
  --confirm-database <exact-company-database-name> \
  --confirm-client-authorization \
  --confirm-erase-company-source-data
```

SQL silme; provider backup, WAL/PITR, replica, log, export, Meta/OpenAI kayıtları veya secret-manager revision'larını
fiziksel olarak silmez. Tam checklist [docs/DATA_LIFECYCLE.md](docs/DATA_LIFECYCLE.md) içindedir.

## Docker

```bash
docker build -t company-whatsapp-assistant:local .
docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file .env -p 3000:3000 company-whatsapp-assistant:local
```

Image non-root `node` kullanıcısıyla çalışır ve `/health/live` healthcheck'i içerir. Production migration komutu:

```bash
npm run db:migrate:prod
npm run ops:readiness:prod
```

## Kontroller

```bash
npm run check
npm run test:stress
npm run security:scan
npm audit --omit=dev --audit-level=moderate
```

## Sorun giderme ve operasyon

Teslimat hataları (131030, süresi dolmuş token vb.), Render deployment
checklist'i ve Meta konsol adımları için [docs/RUNBOOK.md](docs/RUNBOOK.md)
dosyasına bakın. Hızlı araçlar:

```bash
npm run setup:env                                  # güçlü rastgele secret'larla .env üret
npm run setup:env -- --render                      # Render panosuna yapıştırılacak env bloğu
npm run whatsapp:diagnose                          # token + phone number ID + izin kontrolü
npm run whatsapp:diagnose -- --send --to +90...    # canlı test mesajı, tam Meta hatasıyla
npm run db:list-users                              # whitelist'teki kullanıcıları göster
npm run ops:status                                 # tek komutla operasyonel durum özeti
npm run db:export-audit                            # denetim kaydını JSON/CSV olarak dışa aktar
npm run e2e:local                                  # kimlik bilgisi gerektirmeyen uçtan uca test
npm run mock:meta                                  # sahte Graph API'yi tek başına çalıştır
```

Render'a tek tıkla kurulum için repo kökündeki `render.yaml` Blueprint'i
kullanılabilir; servis açılışta token'ın süresini de kontrol eder ve süresi
yaklaşan/geçmiş token'ları loglarda uyarır.

Repository public kalacaksa GitHub Settings altında ayrıca branch ruleset, required CI/CodeQL/supply-chain checks,
en az bir review, conversation resolution, signed commits, secret scanning, push protection ve private vulnerability
reporting etkinleştirilmelidir. Bunlar repository dosyasıyla güvenilir biçimde zorlanamaz.
