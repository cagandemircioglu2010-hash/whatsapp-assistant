-- Per-user notice language. NULL falls back to the service-wide
-- ASSISTANT_LOCALE. Only affects system notices the bot sends on its own;
-- report content language is unchanged.
ALTER TABLE users
    ADD COLUMN locale TEXT CHECK (locale IN ('tr', 'en'));

COMMENT ON COLUMN users.locale IS 'Preferred notice language; NULL uses the service default.';
