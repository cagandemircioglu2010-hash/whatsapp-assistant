ALTER TABLE users
    ALTER COLUMN full_name DROP NOT NULL,
    ADD COLUMN full_name_ciphertext TEXT,
    ADD COLUMN full_name_key_id TEXT,
    ADD COLUMN department_ciphertext TEXT,
    ADD COLUMN department_key_id TEXT;

ALTER TABLE users
    ADD CONSTRAINT users_encrypted_full_name_pair CHECK (
        (full_name_ciphertext IS NULL AND full_name_key_id IS NULL)
        OR (full_name_ciphertext IS NOT NULL AND full_name_key_id IS NOT NULL)
    ),
    ADD CONSTRAINT users_single_full_name_representation CHECK (
        NOT (full_name IS NOT NULL AND full_name_ciphertext IS NOT NULL)
    ),
    ADD CONSTRAINT users_full_name_available CHECK (
        full_name IS NOT NULL OR full_name_ciphertext IS NOT NULL
    ),
    ADD CONSTRAINT users_encrypted_department_pair CHECK (
        (department_ciphertext IS NULL AND department_key_id IS NULL)
        OR (department_ciphertext IS NOT NULL AND department_key_id IS NOT NULL)
    ),
    ADD CONSTRAINT users_single_department_representation CHECK (
        NOT (department IS NOT NULL AND department_ciphertext IS NOT NULL)
    );

ALTER TABLE users DROP CONSTRAINT users_phone_e164_key;
DROP INDEX users_active_phone_idx;

ALTER TABLE messages
    ADD COLUMN external_message_id_hash CHAR(64);

ALTER TABLE messages
    ADD CONSTRAINT messages_external_message_id_hash_format CHECK (
        external_message_id_hash IS NULL OR external_message_id_hash ~ '^[a-f0-9]{64}$'
    );

DROP INDEX messages_external_message_id_unique;

CREATE UNIQUE INDEX messages_external_message_id_hash_unique
    ON messages (external_message_id_hash)
    WHERE external_message_id_hash IS NOT NULL;

CREATE INDEX messages_record_retention_idx
    ON messages (created_at)
    WHERE status IN ('processed', 'ignored', 'failed', 'sent', 'delivery_unknown', 'delivered', 'read');

CREATE INDEX audit_events_retention_idx ON audit_events (created_at);

COMMENT ON COLUMN users.full_name_ciphertext IS 'Versioned AES-256-GCM envelope; plaintext name is cleared after backfill.';
COMMENT ON COLUMN users.department_ciphertext IS 'Versioned AES-256-GCM envelope; plaintext department is cleared after backfill.';
COMMENT ON COLUMN messages.external_message_id_hash IS 'Domain-separated HMAC blind index used for webhook idempotency and delivery status matching.';
COMMENT ON COLUMN messages.external_message_id IS 'Legacy plaintext transport identifier; cleared after lifecycle backfill.';
