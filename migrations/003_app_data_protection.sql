ALTER TABLE users
    ALTER COLUMN phone_e164 DROP NOT NULL,
    ADD COLUMN phone_lookup_hash CHAR(64),
    ADD COLUMN phone_ciphertext TEXT,
    ADD COLUMN phone_key_id TEXT;

ALTER TABLE users
    ADD CONSTRAINT users_phone_lookup_hash_format CHECK (
        phone_lookup_hash IS NULL OR phone_lookup_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT users_encrypted_phone_pair CHECK (
        (phone_ciphertext IS NULL AND phone_key_id IS NULL)
        OR (phone_ciphertext IS NOT NULL AND phone_key_id IS NOT NULL)
    );

CREATE UNIQUE INDEX users_phone_lookup_hash_unique
    ON users (phone_lookup_hash)
    WHERE phone_lookup_hash IS NOT NULL;

ALTER TABLE messages
    ADD COLUMN content_ciphertext TEXT,
    ADD COLUMN content_key_id TEXT,
    ADD COLUMN reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    ADD COLUMN delivery_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 10);

ALTER TABLE messages
    DROP CONSTRAINT messages_status_check,
    ADD CONSTRAINT messages_status_check CHECK (
        status IN (
            'received', 'processing', 'processed', 'ignored', 'failed',
            'sending', 'sent', 'delivery_unknown', 'delivered', 'read'
        )
    );

ALTER TABLE messages
    ADD CONSTRAINT messages_encrypted_content_pair CHECK (
        (content_ciphertext IS NULL AND content_key_id IS NULL)
        OR (content_ciphertext IS NOT NULL AND content_key_id IS NOT NULL)
    ),
    ADD CONSTRAINT messages_single_content_representation CHECK (
        NOT (content IS NOT NULL AND content_ciphertext IS NOT NULL)
    );

CREATE INDEX messages_content_retention_idx
    ON messages (created_at)
    WHERE content IS NOT NULL OR content_ciphertext IS NOT NULL;

CREATE UNIQUE INDEX messages_reply_to_unique
    ON messages (reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX messages_processing_recovery_idx
    ON messages (updated_at)
    WHERE direction = 'inbound' AND status = 'processing';

COMMENT ON COLUMN users.phone_lookup_hash IS 'Keyed HMAC blind index used for whitelist lookup.';
COMMENT ON COLUMN users.phone_ciphertext IS 'Versioned AES-256-GCM envelope; plaintext phone is cleared after backfill.';
COMMENT ON COLUMN messages.content_ciphertext IS 'Versioned AES-256-GCM envelope containing message content.';
