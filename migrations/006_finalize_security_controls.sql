DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM users
        WHERE phone_e164 IS NOT NULL
           OR full_name IS NOT NULL
           OR department IS NOT NULL
           OR phone_ciphertext IS NULL
           OR phone_ciphertext !~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
           OR split_part(phone_ciphertext, '.', 2) <> phone_key_id
           OR full_name_ciphertext IS NULL
           OR full_name_ciphertext !~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
           OR split_part(full_name_ciphertext, '.', 2) <> full_name_key_id
           OR (department_ciphertext IS NOT NULL AND (
               department_ciphertext !~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
               OR split_part(department_ciphertext, '.', 2) <> department_key_id
           ))
           OR phone_lookup_hash IS NULL
           OR phone_lookup_key_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Security backfill is incomplete; run npm run db:backfill-security before finalization';
    END IF;

    IF EXISTS (
        SELECT 1 FROM messages
        WHERE content IS NOT NULL
           OR external_message_id IS NOT NULL
           OR (content_ciphertext IS NOT NULL AND (
               content_ciphertext !~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
               OR split_part(content_ciphertext, '.', 2) <> content_key_id
           ))
           OR (external_message_id_hash IS NOT NULL AND external_message_id_key_id IS NULL)
           OR (sender_phone_hash IS NOT NULL AND sender_phone_key_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'Message security backfill is incomplete; run npm run db:backfill-security before finalization';
    END IF;

    IF EXISTS (
        SELECT 1 FROM audit_events
        WHERE event_hash IS NULL OR anchor_hash IS NULL OR integrity_key_id IS NULL
           OR (user_id IS NOT NULL AND user_reference IS NULL)
           OR (message_id IS NOT NULL AND message_reference IS NULL)
    ) THEN
        RAISE EXCEPTION 'Audit integrity backfill is incomplete; run npm run db:backfill-security before finalization';
    END IF;
END $$;

DROP INDEX messages_content_retention_idx;

ALTER TABLE users VALIDATE CONSTRAINT users_phone_lookup_key_pair;
ALTER TABLE messages VALIDATE CONSTRAINT messages_external_identifier_key_pair;
ALTER TABLE messages VALIDATE CONSTRAINT messages_sender_identifier_key_pair;

ALTER TABLE users
    DROP CONSTRAINT users_single_full_name_representation,
    DROP CONSTRAINT users_full_name_available,
    DROP CONSTRAINT users_single_department_representation,
    DROP CONSTRAINT users_encrypted_phone_pair,
    DROP CONSTRAINT users_encrypted_full_name_pair,
    DROP CONSTRAINT users_encrypted_department_pair,
    DROP COLUMN phone_e164,
    DROP COLUMN full_name,
    DROP COLUMN department,
    ALTER COLUMN phone_lookup_hash SET NOT NULL,
    ALTER COLUMN phone_lookup_key_id SET NOT NULL,
    ALTER COLUMN phone_ciphertext SET NOT NULL,
    ALTER COLUMN phone_key_id SET NOT NULL,
    ALTER COLUMN full_name_ciphertext SET NOT NULL,
    ALTER COLUMN full_name_key_id SET NOT NULL,
    ADD CONSTRAINT users_role_allowed CHECK (role IN ('employee', 'manager', 'executive', 'admin')),
    ADD CONSTRAINT users_v2_encryption_binding CHECK (
        phone_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
        AND full_name_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
        AND octet_length(phone_ciphertext) <= 1000000
        AND octet_length(full_name_ciphertext) <= 1000000
        AND phone_ciphertext ~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
        AND full_name_ciphertext ~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
        AND split_part(phone_ciphertext, '.', 1) = 'v2'
        AND split_part(phone_ciphertext, '.', 2) = phone_key_id
        AND split_part(full_name_ciphertext, '.', 1) = 'v2'
        AND split_part(full_name_ciphertext, '.', 2) = full_name_key_id
        AND (department_ciphertext IS NULL OR (
            department_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
            AND octet_length(department_ciphertext) <= 1000000
            AND department_ciphertext ~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
            AND split_part(department_ciphertext, '.', 1) = 'v2'
            AND split_part(department_ciphertext, '.', 2) = department_key_id
        ))
    );

ALTER TABLE messages
    DROP CONSTRAINT messages_single_content_representation,
    DROP COLUMN content,
    DROP COLUMN external_message_id,
    ADD CONSTRAINT messages_v2_encryption_binding CHECK (
        content_ciphertext IS NULL OR (
            content_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
            AND octet_length(content_ciphertext) <= 1000000
            AND content_ciphertext ~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
            AND split_part(content_ciphertext, '.', 1) = 'v2'
            AND split_part(content_ciphertext, '.', 2) = content_key_id
        )
    );

ALTER TABLE audit_events
    ALTER COLUMN event_hash SET NOT NULL,
    ALTER COLUMN anchor_hash SET NOT NULL,
    ALTER COLUMN integrity_key_id SET NOT NULL,
    ADD CONSTRAINT audit_events_live_reference_presence CHECK (
        (user_id IS NULL OR user_reference IS NOT NULL)
        AND (message_id IS NULL OR message_reference IS NOT NULL)
    );

CREATE INDEX messages_content_retention_idx
    ON messages (created_at)
    WHERE content_ciphertext IS NOT NULL;

COMMENT ON COLUMN users.phone_ciphertext IS 'Record-bound AES-256-GCM v2 envelope. Plaintext identity columns have been removed.';
COMMENT ON COLUMN messages.content_ciphertext IS 'Record-bound AES-256-GCM v2 envelope. Plaintext content column has been removed.';
COMMENT ON COLUMN audit_events.event_hash IS 'Keyed, chained integrity digest over the canonical audit event.';
COMMENT ON COLUMN audit_events.user_reference IS 'Stable keyed pseudonymous reference retained when the user FK is erased.';
COMMENT ON COLUMN audit_events.message_reference IS 'Stable keyed pseudonymous reference retained when the message FK is erased.';
