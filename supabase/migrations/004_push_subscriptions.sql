-- 004: Web-push subscriptions (the app's free, unlimited way to reach an owner, even outside WhatsApp's 24h window).
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,                 -- one row per browser/phone; re-subscribing updates it
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sent_at TIMESTAMPTZ,
    fail_count INT NOT NULL DEFAULT 0              -- bumped on transient failures; row is deleted when the browser says it's gone
);

CREATE INDEX IF NOT EXISTS idx_push_subs_business ON push_subscriptions(business_id);

-- Same lock-down as every other table: only the server (service role) can read or write.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_subscriptions FROM anon, authenticated;
