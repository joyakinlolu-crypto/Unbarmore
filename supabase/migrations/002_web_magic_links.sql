-- ============================================================================
-- 002 — Web companion (app.unbarmore.com): magic-link auth + advisor chat history
-- Spec tables from WEB_PWA_SPEC.md §3, plus atomic helpers (tagged PATCH).
-- ============================================================================

-- 1. SINGLE-USE WHATSAPP MAGIC LOGIN TOKENS
CREATE TABLE web_magic_tokens (
    token_hash TEXT PRIMARY KEY, -- SHA-256 hash of the random 32-byte URL token (raw token never stored)
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES business_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_magic_user_recent ON web_magic_tokens(user_id, created_at DESC); -- PATCH: throttle lookups

-- 2. WEB AI BUSINESS ADVISOR CHAT HISTORY
CREATE TABLE web_chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES business_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_web_chat_business ON web_chat_messages(business_id, created_at DESC);

-- PATCH: issue a token, but refuse if this user already requested 3 in the last 10 minutes
-- (stops anyone spamming a stranger's WhatsApp with login links through /login).
CREATE OR REPLACE FUNCTION issue_magic_token(p_token_hash TEXT, p_business_id UUID, p_user_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM web_magic_tokens WHERE user_id = p_user_id AND created_at > NOW() - INTERVAL '10 minutes') >= 3 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO web_magic_tokens (token_hash, business_id, user_id) VALUES (p_token_hash, p_business_id, p_user_id);
  RETURN TRUE;
END $$;

-- PATCH: atomic single-use redemption. Two concurrent taps → exactly one row returned.
-- Also re-checks the user is still active and still the owner.
CREATE OR REPLACE FUNCTION consume_magic_token(p_token_hash TEXT)
RETURNS TABLE (user_id UUID, business_id UUID, role TEXT) LANGUAGE sql AS $$
  WITH t AS (
    UPDATE web_magic_tokens SET used_at = NOW()
     WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > NOW()
    RETURNING web_magic_tokens.user_id AS uid, web_magic_tokens.business_id AS bid
  )
  SELECT u.id, u.business_id, u.role FROM t JOIN business_users u ON u.id = t.uid
   WHERE u.is_active AND u.role = 'owner';
$$;

-- PATCH: monthly advisor usage for free-tier gating (calendar month, Lagos time).
CREATE OR REPLACE FUNCTION advisor_messages_this_month(p_business_id UUID)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INT FROM web_chat_messages
   WHERE business_id = p_business_id AND role = 'user'
     AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos';
$$;

-- PATCH: compact chart series (Lagos-time buckets) → ~30 rows to the phone instead of every transaction.
CREATE OR REPLACE FUNCTION ledger_series(p_business_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_bucket TEXT DEFAULT 'day')
RETURNS TABLE (bucket DATE, revenue_ngn NUMERIC, spend_ngn NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT date_trunc(CASE WHEN p_bucket = 'week' THEN 'week' ELSE 'day' END, transaction_date AT TIME ZONE 'Africa/Lagos')::date,
         COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'sale'), 0),
         COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type IN ('expense','restock')), 0)
    FROM transactions
   WHERE business_id = p_business_id AND status = 'confirmed' AND transaction_date >= p_from AND transaction_date < p_to
   GROUP BY 1 ORDER BY 1;
$$;

-- PATCH: housekeeping for the hourly cron.
CREATE OR REPLACE FUNCTION purge_old_magic_tokens() RETURNS INT LANGUAGE sql AS $$
  WITH d AS (DELETE FROM web_magic_tokens WHERE created_at < NOW() - INTERVAL '2 days' RETURNING 1) SELECT COUNT(*)::INT FROM d;
$$;

ALTER TABLE web_magic_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE EXECUTE ON FUNCTION issue_magic_token, consume_magic_token, advisor_messages_this_month, ledger_series, purge_old_magic_tokens FROM anon, authenticated, PUBLIC;
