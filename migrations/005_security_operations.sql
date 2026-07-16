ALTER TABLE users
    ADD COLUMN phone_lookup_key_id TEXT;

ALTER TABLE users
    ADD CONSTRAINT users_phone_lookup_key_pair CHECK (
        (phone_lookup_hash IS NULL AND phone_lookup_key_id IS NULL)
        OR (phone_lookup_hash IS NOT NULL AND phone_lookup_key_id IS NOT NULL)
    ) NOT VALID,
    ADD CONSTRAINT users_phone_lookup_key_id_format CHECK (
        phone_lookup_key_id IS NULL OR phone_lookup_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
    );

ALTER TABLE messages
    ADD COLUMN external_message_id_key_id TEXT,
    ADD COLUMN sender_phone_key_id TEXT;

ALTER TABLE messages
    ADD CONSTRAINT messages_external_identifier_key_pair CHECK (
        (external_message_id_hash IS NULL AND external_message_id_key_id IS NULL)
        OR (external_message_id_hash IS NOT NULL AND external_message_id_key_id IS NOT NULL)
    ) NOT VALID,
    ADD CONSTRAINT messages_sender_identifier_key_pair CHECK (
        (sender_phone_hash IS NULL AND sender_phone_key_id IS NULL)
        OR (sender_phone_hash IS NOT NULL AND sender_phone_key_id IS NOT NULL)
    ) NOT VALID,
    ADD CONSTRAINT messages_identifier_key_id_format CHECK (
        (external_message_id_key_id IS NULL OR external_message_id_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$')
        AND (sender_phone_key_id IS NULL OR sender_phone_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$')
    );

CREATE TABLE rate_limit_buckets (
    scope TEXT NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.-]{2,63}$'),
    subject_hash CHAR(64) NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
    window_started_at TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1000000),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scope, subject_hash)
);

CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets (expires_at);

CREATE TABLE maintenance_job_state (
    job_name TEXT PRIMARY KEY CHECK (job_name ~ '^[a-z][a-z0-9_.-]{2,63}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_started_at TIMESTAMPTZ,
    last_succeeded_at TIMESTAMPTZ,
    last_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 1000000),
    last_error_code TEXT
);

INSERT INTO maintenance_job_state (job_name) VALUES ('data-lifecycle')
ON CONFLICT (job_name) DO NOTHING;

CREATE TABLE service_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    decommissioned_at TIMESTAMPTZ,
    decommission_reason TEXT,
    legal_hold_at TIMESTAMPTZ,
    legal_hold_reference TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (legal_hold_at IS NULL AND legal_hold_reference IS NULL)
        OR (legal_hold_at IS NOT NULL AND legal_hold_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$')
    )
);

INSERT INTO service_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE encryption_canaries (
    name TEXT PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_.-]{2,63}$'),
    ciphertext TEXT NOT NULL,
    key_id TEXT NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    integrity_digest CHAR(64) NOT NULL CHECK (integrity_digest ~ '^[a-f0-9]{64}$'),
    integrity_key_id TEXT NOT NULL CHECK (integrity_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    identifier_digest CHAR(64) NOT NULL CHECK (identifier_digest ~ '^[a-f0-9]{64}$'),
    identifier_key_id TEXT NOT NULL CHECK (identifier_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        ciphertext ~ '^v2[.][A-Za-z0-9][A-Za-z0-9_-]{0,31}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$'
        AND split_part(ciphertext, '.', 2) = key_id
        AND octet_length(ciphertext) <= 1000000
    )
);

ALTER TABLE audit_events
    ADD COLUMN sequence BIGSERIAL,
    ADD COLUMN previous_hash CHAR(64),
    ADD COLUMN event_hash CHAR(64),
    ADD COLUMN anchor_hash CHAR(64),
    ADD COLUMN integrity_key_id TEXT,
    ADD COLUMN user_reference CHAR(64),
    ADD COLUMN message_reference CHAR(64);

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_sequence_unique UNIQUE (sequence),
    ADD CONSTRAINT audit_events_hash_format CHECK (
        (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$')
        AND (event_hash IS NULL OR event_hash ~ '^[a-f0-9]{64}$')
        AND (anchor_hash IS NULL OR anchor_hash ~ '^[a-f0-9]{64}$')
    ),
    ADD CONSTRAINT audit_events_integrity_pair CHECK (
        (event_hash IS NULL AND anchor_hash IS NULL AND integrity_key_id IS NULL)
        OR (event_hash IS NOT NULL AND anchor_hash IS NOT NULL AND integrity_key_id IS NOT NULL)
    ),
    ADD CONSTRAINT audit_events_integrity_key_id_format CHECK (
        integrity_key_id IS NULL OR integrity_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'
    ),
    ADD CONSTRAINT audit_events_reference_format CHECK (
        (user_reference IS NULL OR user_reference ~ '^[a-f0-9]{64}$')
        AND (message_reference IS NULL OR message_reference ~ '^[a-f0-9]{64}$')
    );

CREATE TABLE audit_chain_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    last_sequence BIGINT,
    last_hash CHAR(64),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (last_sequence IS NULL AND last_hash IS NULL)
        OR (last_sequence IS NOT NULL AND last_hash ~ '^[a-f0-9]{64}$')
    )
);

INSERT INTO audit_chain_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE audit_chain_anchors (
    through_sequence BIGINT PRIMARY KEY,
    event_hash CHAR(64) NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
    anchor_hash CHAR(64) NOT NULL CHECK (anchor_hash ~ '^[a-f0-9]{64}$'),
    integrity_key_id TEXT NOT NULL CHECK (integrity_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION assistant_run_data_lifecycle(
    content_days INTEGER,
    message_record_days INTEGER,
    audit_days INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    content_count INTEGER := 0;
    message_count INTEGER := 0;
    audit_count INTEGER := 0;
    rate_limit_count INTEGER := 0;
    audit_boundary BIGINT;
    audit_boundary_hash CHAR(64);
    audit_boundary_anchor_hash CHAR(64);
    audit_boundary_key_id TEXT;
    legal_hold BOOLEAN := FALSE;
    result JSONB;
BEGIN
    IF content_days < 1 OR content_days > 365
       OR message_record_days < content_days OR message_record_days > 3650
       OR audit_days < 1 OR audit_days > 3650 THEN
        RAISE EXCEPTION 'Invalid data lifecycle policy' USING ERRCODE = '22023';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('company-whatsapp-assistant'), hashtext('data-lifecycle')) THEN
        RETURN NULL;
    END IF;

    UPDATE maintenance_job_state SET last_started_at = NOW()
    WHERE job_name = 'data-lifecycle';

    SELECT legal_hold_at IS NOT NULL INTO legal_hold
    FROM service_state WHERE singleton = TRUE;
    IF legal_hold THEN
        result := jsonb_build_object(
            'contentMinimized', 0,
            'messagesDeleted', 0,
            'auditEventsDeleted', 0,
            'rateLimitBucketsDeleted', 0,
            'legalHold', TRUE
        );
        UPDATE maintenance_job_state
        SET last_succeeded_at = NOW(), last_result = result,
            consecutive_failures = 0, last_error_code = NULL
        WHERE job_name = 'data-lifecycle';
        RETURN result;
    END IF;

    UPDATE messages
    SET content_ciphertext = NULL, content_key_id = NULL,
        metadata = '{}'::jsonb, updated_at = NOW()
    WHERE created_at < NOW() - (content_days * INTERVAL '1 day')
      AND (content_ciphertext IS NOT NULL OR metadata <> '{}'::jsonb);
    GET DIAGNOSTICS content_count = ROW_COUNT;

    SELECT sequence, event_hash, anchor_hash, integrity_key_id
      INTO audit_boundary, audit_boundary_hash, audit_boundary_anchor_hash, audit_boundary_key_id
    FROM audit_events
    WHERE sequence < COALESCE((
        SELECT MIN(sequence) FROM audit_events
        WHERE created_at >= NOW() - (audit_days * INTERVAL '1 day')
    ), 9223372036854775807)
    ORDER BY sequence DESC LIMIT 1;

    IF audit_boundary IS NOT NULL THEN
        INSERT INTO audit_chain_anchors (
            through_sequence, event_hash, anchor_hash, integrity_key_id
        ) VALUES (
            audit_boundary, audit_boundary_hash, audit_boundary_anchor_hash, audit_boundary_key_id
        )
        ON CONFLICT (through_sequence) DO UPDATE SET
            event_hash = EXCLUDED.event_hash,
            anchor_hash = EXCLUDED.anchor_hash,
            integrity_key_id = EXCLUDED.integrity_key_id;
        DELETE FROM audit_chain_anchors WHERE through_sequence < audit_boundary;
        DELETE FROM audit_events WHERE sequence <= audit_boundary;
        GET DIAGNOSTICS audit_count = ROW_COUNT;
    END IF;

    DELETE FROM messages
    WHERE created_at < NOW() - (message_record_days * INTERVAL '1 day')
      AND ((direction = 'inbound' AND (
              status IN ('processed', 'ignored')
              OR (status = 'failed' AND processing_attempts >= 3)
           ))
        OR (direction = 'outbound' AND (
              status IN ('sent', 'delivery_unknown', 'delivered', 'read')
              OR (status = 'failed' AND delivery_attempts >= 3)
           )));
    GET DIAGNOSTICS message_count = ROW_COUNT;

    DELETE FROM rate_limit_buckets WHERE expires_at < NOW();
    GET DIAGNOSTICS rate_limit_count = ROW_COUNT;

    result := jsonb_build_object(
        'contentMinimized', content_count,
        'messagesDeleted', message_count,
        'auditEventsDeleted', audit_count,
        'rateLimitBucketsDeleted', rate_limit_count
    );
    UPDATE maintenance_job_state
    SET last_succeeded_at = NOW(), last_result = result,
        consecutive_failures = 0, last_error_code = NULL
    WHERE job_name = 'data-lifecycle';
    RETURN result;
EXCEPTION WHEN OTHERS THEN
    UPDATE maintenance_job_state
    SET last_started_at = NOW(),
        consecutive_failures = LEAST(consecutive_failures + 1, 1000000),
        last_error_code = SQLSTATE
    WHERE job_name = 'data-lifecycle';
    RETURN jsonb_build_object('errorCode', SQLSTATE);
END;
$$;

REVOKE ALL ON FUNCTION assistant_run_data_lifecycle(INTEGER, INTEGER, INTEGER) FROM PUBLIC;

COMMENT ON TABLE rate_limit_buckets IS 'Shared fixed-window limits used across all application replicas.';
COMMENT ON TABLE maintenance_job_state IS 'Heartbeat and outcome state for privacy/security maintenance jobs.';
COMMENT ON TABLE service_state IS 'Persistent decommission switch; startup refuses service after client erasure.';
COMMENT ON TABLE audit_chain_anchors IS 'HMAC-authenticated integrity anchors retained when expired audit prefixes are purged.';
