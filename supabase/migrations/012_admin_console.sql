-- ============================================================================
-- 012 — Admin console
--   • admin_tokens: single-use, 10-minute login links for the platform owner, issued by the bot when ADMIN_PHONE sends "ADMIN LINK".
--     Only a SHA-256 hash is stored. Redeemed atomically (two taps = one login).
--   • admin_audit: every admin action and every "view as shop" is recorded (who looked at whose books, who changed what).
-- Written/read only by the server (service role). Run AFTER 001–011. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE admin_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_tokens FROM anon, authenticated, PUBLIC;

-- Issue a token, but never more than 5 in 10 minutes (a stuck loop must not spam the admin's WhatsApp or the table).
CREATE OR REPLACE FUNCTION issue_admin_token(p_token_hash TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM admin_tokens WHERE created_at > NOW() - INTERVAL '10 minutes') >= 5 THEN RETURN FALSE; END IF;
  INSERT INTO admin_tokens (token_hash) VALUES (p_token_hash);
  RETURN TRUE;
END $$;

-- Atomic single-use redemption: returns TRUE exactly once, only before expiry.
CREATE OR REPLACE FUNCTION consume_admin_token(p_token_hash TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  UPDATE admin_tokens SET used_at = NOW() WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > NOW();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE TABLE IF NOT EXISTS admin_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,                                  -- 'login' | 'view_as' | 'grant_videos' | 'extend_trial' | 'comp_plan' ...
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  business_name TEXT,                                    -- kept even if the shop is later deleted
  detail JSONB NOT NULL DEFAULT '{}'::JSONB
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);
ALTER TABLE admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_audit FROM anon, authenticated, PUBLIC;

REVOKE EXECUTE ON FUNCTION issue_admin_token(TEXT), consume_admin_token(TEXT) FROM anon, authenticated, PUBLIC;
