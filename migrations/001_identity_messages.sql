CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 TEXT NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
    department TEXT,
    role TEXT NOT NULL DEFAULT 'employee',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_.-]{2,99}$'),
    action TEXT NOT NULL DEFAULT 'read' CHECK (action IN ('read', 'write', 'approve')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, resource, action)
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_message_id TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    sender_phone_hash CHAR(64),
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processing', 'processed', 'ignored', 'failed', 'sent', 'delivered', 'read')
    ),
    processing_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (processing_attempts BETWEEN 0 AND 10),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX messages_external_message_id_unique
    ON messages (external_message_id)
    WHERE external_message_id IS NOT NULL;

CREATE INDEX users_active_phone_idx ON users (phone_e164) WHERE is_active = TRUE;
CREATE INDEX permissions_user_resource_idx ON permissions (user_id, resource, action);
CREATE INDEX messages_user_created_idx ON messages (user_id, created_at DESC);
CREATE INDEX messages_status_idx ON messages (status, created_at) WHERE status IN ('received', 'failed');

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    resource TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'success', 'failure', 'ignored')),
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_user_created_idx ON audit_events (user_id, created_at DESC);
CREATE INDEX audit_events_type_created_idx ON audit_events (event_type, created_at DESC);

COMMENT ON COLUMN users.phone_e164 IS 'Whitelist identity. Treat as personal data and never emit to application logs.';
COMMENT ON COLUMN messages.sender_phone_hash IS 'HMAC-SHA256 lookup/audit identifier; raw phone is deliberately omitted.';
COMMENT ON COLUMN messages.content IS 'Conversation history. Never include this field in logs; apply a retention policy in production.';
