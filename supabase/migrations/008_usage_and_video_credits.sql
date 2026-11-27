-- 008: (1) per-shop AI usage log so you can see what each shop REALLY costs; (2) pay-as-you-go video credits.
-- Safe to run more than once. The bot keeps working if this has not been run yet (it just skips these features).

-- 1. AI usage: one row per shop, per day, per kind of AI work. Costs are ESTIMATES in naira (check against Google AI Studio).
CREATE TABLE IF NOT EXISTS ai_usage (
    business_id   UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    day           DATE    NOT NULL,
    kind          TEXT    NOT NULL,            -- message | voice | screenshot | script | voiceover | photo_cleanup
    calls         INT     NOT NULL DEFAULT 0,
    input_tokens  BIGINT  NOT NULL DEFAULT 0,
    output_tokens BIGINT  NOT NULL DEFAULT 0,
    images        INT     NOT NULL DEFAULT 0,  -- photos cleaned
    est_cost_ngn  NUMERIC(12, 4) NOT NULL DEFAULT 0,
    PRIMARY KEY (business_id, day, kind)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage(day);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION log_ai_usage(p_business_id UUID, p_day DATE, p_kind TEXT, p_calls INT, p_in BIGINT, p_out BIGINT, p_images INT, p_cost NUMERIC)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO ai_usage AS u (business_id, day, kind, calls, input_tokens, output_tokens, images, est_cost_ngn)
  VALUES (p_business_id, p_day, p_kind, p_calls, p_in, p_out, p_images, p_cost)
  ON CONFLICT (business_id, day, kind) DO UPDATE SET
    calls = u.calls + EXCLUDED.calls,
    input_tokens = u.input_tokens + EXCLUDED.input_tokens,
    output_tokens = u.output_tokens + EXCLUDED.output_tokens,
    images = u.images + EXCLUDED.images,
    est_cost_ngn = u.est_cost_ngn + EXCLUDED.est_cost_ngn;
$$;

-- 2. Video credits (pay-as-you-go extra videos) and which videos were paid for with one.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS video_credits INT NOT NULL DEFAULT 0 CHECK (video_credits >= 0);
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS credit_funded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION consume_video_credit(p_business_id UUID) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE ok BOOLEAN;
BEGIN
  UPDATE businesses SET video_credits = video_credits - 1 WHERE id = p_business_id AND video_credits > 0 RETURNING TRUE INTO ok;
  RETURN COALESCE(ok, FALSE);
END $$;

CREATE OR REPLACE FUNCTION add_video_credits(p_business_id UUID, p_qty INT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE bal INT;
BEGIN
  IF p_qty IS NULL OR p_qty < 1 OR p_qty > 100 THEN RAISE EXCEPTION 'credits must be between 1 and 100'; END IF;
  UPDATE businesses SET video_credits = video_credits + p_qty WHERE id = p_business_id RETURNING video_credits INTO bal;
  RETURN bal;
END $$;

CREATE OR REPLACE FUNCTION refund_video_credit(p_business_id UUID) RETURNS VOID LANGUAGE sql AS $$
  UPDATE businesses SET video_credits = video_credits + 1 WHERE id = p_business_id;
$$;

REVOKE EXECUTE ON FUNCTION log_ai_usage(UUID, DATE, TEXT, INT, BIGINT, BIGINT, INT, NUMERIC) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION consume_video_credit(UUID) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION add_video_credits(UUID, INT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION refund_video_credit(UUID) FROM anon, authenticated, PUBLIC;
