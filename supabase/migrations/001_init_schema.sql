-- ============================================================================
-- UNBARMORE (unbarmore.com) — COMPLETE POSTGRESQL / SUPABASE SCHEMA (v1.1)
-- WhatsApp AI Sales, Video & Profit Co-Pilot for Nigerian SMEs
--
-- v1.1 = founder schema v1.0 + production patches. Every deviation is tagged
-- "-- PATCH:" with the reason, so the diff from v1.0 is auditable.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. BUSINESSES (Tenants)
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    owner_phone TEXT UNIQUE NOT NULL, -- E.164 format e.g. 2348012345678
    business_category TEXT DEFAULT 'General Retail',
    rc_number TEXT,
    logo_url TEXT,
    studio_theme TEXT NOT NULL DEFAULT 'clean_minimalist' CHECK (studio_theme IN ('clean_minimalist', 'luxury_boutique', 'outdoor_lifestyle')),
    subscription_tier TEXT NOT NULL DEFAULT 'trial' CHECK (subscription_tier IN ('trial', 'free_limited', 'starter_5k', 'growth_15k')),
    billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
    paystack_customer_code TEXT,
    paystack_subscription_code TEXT,
    trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    subscription_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

    -- Monthly Usage Counters (Reset on the 1st of every month via cron)
    videos_used_this_month INT NOT NULL DEFAULT 0,
    ocr_scans_used_this_month INT NOT NULL DEFAULT 0,
    tx_logged_this_month INT NOT NULL DEFAULT 0,
    pdf_receipts_used_this_month INT NOT NULL DEFAULT 0,
    ceo_reports_used_this_month INT NOT NULL DEFAULT 0,          -- PATCH: trial cap = 1 report
    usage_period_start DATE NOT NULL DEFAULT CURRENT_DATE,       -- PATCH: makes the monthly reset idempotent

    -- ₦1,000 Give-to-Get Viral Referral Engine
    referral_code TEXT UNIQUE NOT NULL,                           -- default generator attached below
    referred_by_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
    referral_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
    referral_wallet_ngn NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (referral_wallet_ngn >= 0), -- PATCH: never negative

    -- Cumulative Value Counter (Retention Anchor on Sunday CEO Report)
    total_value_recovered_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0.00,

    -- Google Sheets Live Sync (Growth Tier / Export)
    google_sheet_id TEXT,
    google_refresh_token TEXT, -- unused by v1 code: sync uses a service account the owner shares the sheet with
                               -- (no Google OAuth app verification needed). Kept for a future OAuth flow.

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_businesses_tier_expiry ON businesses(subscription_tier, trial_ends_at, subscription_expires_at); -- PATCH: hourly cron

-- PATCH: referral_code had NOT NULL but no generator. UNBAR-XXXX, no 0/O/1/I ambiguity.
CREATE OR REPLACE FUNCTION gen_referral_code() RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code TEXT;
BEGIN
  LOOP
    code := 'UNBAR-';
    FOR i IN 1..4 LOOP
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM businesses WHERE referral_code = code);
  END LOOP;
  RETURN code;
END $$;
ALTER TABLE businesses ALTER COLUMN referral_code SET DEFAULT gen_referral_code();

-- 2. STAFF & AUTHORIZED WHATSAPP NUMBERS (Supports Growth ₦15k Multi-Staff Tier)
CREATE TABLE business_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    phone_number TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_business_users_business ON business_users(business_id);

-- 3. PRODUCT CATALOG & INFLATION SHIELD TRACKER (Auto-populated lazily on first sale/video)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    sku_code TEXT NOT NULL, -- e.g. UNB-104 for Smart Order Links
    name TEXT NOT NULL,
    name_key TEXT GENERATED ALWAYS AS (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) STORED, -- PATCH: "lace" == "Lace "
    cost_price_ngn NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    previous_cost_price_ngn NUMERIC(12, 2),
    selling_price_ngn NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    stock_qty NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- PATCH: INT → NUMERIC (2.5 yards of lace)
    last_sold_at TIMESTAMPTZ DEFAULT NOW(),       -- doubles as "created" for never-sold dead-stock detection
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, sku_code),
    UNIQUE (business_id, name_key)                -- PATCH: lazy auto-create must not duplicate products
);

-- 4. CUSTOMERS & DEBTORS LEDGER
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT GENERATED ALWAYS AS (lower(regexp_replace(trim(name), '\s+', ' ', 'g'))) STORED, -- PATCH
    phone_number TEXT,
    total_spent_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    outstanding_debt_ngn NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    debt_since TIMESTAMPTZ,                        -- PATCH: "owing for 23 days" needs a start date
    debt_due_date DATE,
    last_reminder_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, name_key)                 -- PATCH
);

-- 5. FINANCIAL TRANSACTIONS (Sales, Expenses, Restocks, Debt Repayments)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL DEFAULT uuid_generate_v4(), -- PATCH: one voice note = N lines confirmed/undone together
    logged_by_user_id UUID REFERENCES business_users(id),
    customer_id UUID REFERENCES customers(id),
    product_id UUID REFERENCES products(id),
    tx_type TEXT NOT NULL CHECK (tx_type IN ('sale', 'expense', 'restock', 'debt_repayment')),
    category TEXT NOT NULL DEFAULT 'General', -- 'Sales', 'Fuel/Diesel', 'Logistics/Dispatch', 'Inventory Restock', 'Rent/Utilities'
    description TEXT NOT NULL,
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 1,       -- PATCH: INT → NUMERIC
    unit_price_ngn NUMERIC(14, 2),                    -- PATCH: needed for Inflation Shield cost comparison
    total_amount_ngn NUMERIC(14, 2) NOT NULL CHECK (total_amount_ngn >= 0),
    amount_paid_ngn NUMERIC(14, 2) NOT NULL CHECK (amount_paid_ngn >= 0),
    balance_due_ngn NUMERIC(14, 2) GENERATED ALWAYS AS (total_amount_ngn - amount_paid_ngn) STORED,
    payment_method TEXT DEFAULT 'transfer' CHECK (payment_method IN ('transfer', 'cash', 'pos', 'credit')),
    status TEXT NOT NULL DEFAULT 'pending_confirm' CHECK (status IN ('pending_confirm', 'confirmed', 'undone')), -- PATCH: default was 'confirmed' (violates §4.3)
    confirmed_at TIMESTAMPTZ,                         -- PATCH: UNDO window is 5 min from confirmation

    -- Bank Alert & OCR Audit Metadata
    bank_session_id TEXT,
    sender_bank_name TEXT,
    ocr_fraud_flag BOOLEAN NOT NULL DEFAULT FALSE,
    ocr_fraud_reason TEXT,
    receipt_pdf_url TEXT,
    source_channel TEXT NOT NULL DEFAULT 'whatsapp_text' CHECK (source_channel IN ('whatsapp_text', 'whatsapp_voice', 'whatsapp_image', 'sms_forward')),
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. AI VIDEO GENERATION JOBS ("Snap-to-Sell" FFmpeg Pipeline)
CREATE TABLE video_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    raw_image_urls TEXT[] NOT NULL,     -- storage paths in bucket raw-images
    cleaned_image_urls TEXT[],          -- storage paths in bucket cleaned-images
    promo_hook TEXT,
    voice_language TEXT NOT NULL DEFAULT 'en-NG' CHECK (voice_language IN ('en-NG', 'pidgin')),
    include_watermark BOOLEAN NOT NULL DEFAULT TRUE, -- True for trial/free_limited/starter_5k; False for growth_15k
    is_clearance BOOLEAN NOT NULL DEFAULT FALSE,     -- PATCH: BTN_DEADSTOCK_PROMO 48-hour flash sale
    delivery_info TEXT,                               -- PATCH: captured in the photo-batch follow-up
    generated_script TEXT,
    audio_url TEXT,
    final_video_url TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. WHATSAPP CONVERSATION STATE & 24-HOUR WINDOW TRACKER
CREATE TABLE whatsapp_sessions (
    phone_number TEXT PRIMARY KEY,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    current_state TEXT NOT NULL DEFAULT 'IDLE', -- IDLE | ONBOARDING_NAME | ONBOARDING_REFERRAL | AWAITING_VIDEO_DETAILS | AWAITING_TX_CONFIRM | AWAITING_TX_EDIT | AWAITING_PAYOUT_DETAILS | AWAITING_SHEET_LINK
    pending_payload JSONB DEFAULT '{}'::JSONB,
    last_inbound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- Tracks Meta's 24-hour free service window
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. REFERRAL WALLET LEDGER (Audit Trail for ₦1,000 Credits & Payouts)
CREATE TABLE referral_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    related_business_id UUID REFERENCES businesses(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('signup_bonus', 'referrer_bonus', 'subscription_discount', 'cash_payout')),
    amount_ngn NUMERIC(12, 2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. PAYSTACK BILLING & WEBHOOK EVENTS (Idempotency)
CREATE TABLE billing_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paystack_reference TEXT NOT NULL,
    business_id UUID REFERENCES businesses(id),
    event_type TEXT NOT NULL,
    amount_ngn NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    raw_payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ,                        -- PATCH: apply-once guard inside the payment RPC
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_type, paystack_reference)          -- PATCH: was UNIQUE(reference) — events can share one
);

-- ─────────────── PATCH: tables v1.0 was missing ───────────────

-- Meta retries webhooks; without this a single "sold 2 laces" is logged twice.
CREATE TABLE processed_messages (
    wa_message_id TEXT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scheduled-send dedupe: a crashed/retried cron must never send a paid template twice.
CREATE TABLE outbound_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,          -- daily_checkin | ceo_report | eod_audit
    period_key TEXT NOT NULL,    -- 2026-11-19 | 2026-W47
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (business_id, kind, period_key)
);

CREATE TABLE payout_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID NOT NULL REFERENCES businesses(id),
    amount_ngn NUMERIC(12, 2) NOT NULL CHECK (amount_ngn >= 5000),
    bank_details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'paid', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PERFORMANCE INDEXES
CREATE INDEX idx_tx_business_date ON transactions(business_id, transaction_date DESC) WHERE status = 'confirmed';
CREATE INDEX idx_tx_batch ON transactions(batch_id);                                                -- PATCH
CREATE INDEX idx_tx_bank_session ON transactions(bank_session_id) WHERE bank_session_id IS NOT NULL; -- PATCH: recycled-screenshot check
CREATE INDEX idx_customers_debt ON customers(business_id) WHERE outstanding_debt_ngn > 0;
CREATE INDEX idx_products_deadstock ON products(business_id, last_sold_at);
CREATE INDEX idx_wa_24hr_window ON whatsapp_sessions(last_inbound_at);

-- ═════════════════════════ RPC FUNCTIONS (atomic, called by backend) ═════════════════════════

-- Quota: increments only if under cap. p_cap = -1 → unlimited.
CREATE OR REPLACE FUNCTION consume_quota(p_business_id UUID, p_metric TEXT, p_cap INT, p_amount INT DEFAULT 1)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE ok BOOLEAN;
BEGIN
  IF p_metric NOT IN ('videos_used_this_month','ocr_scans_used_this_month','tx_logged_this_month',
                      'pdf_receipts_used_this_month','ceo_reports_used_this_month') THEN
    RAISE EXCEPTION 'unknown metric %', p_metric;
  END IF;
  IF p_cap < 0 THEN
    EXECUTE format('UPDATE businesses SET %I = %I + $1 WHERE id = $2', p_metric, p_metric) USING p_amount, p_business_id;
    RETURN TRUE;
  END IF;
  EXECUTE format('UPDATE businesses SET %I = %I + $1 WHERE id = $2 AND %I + $1 <= $3 RETURNING TRUE',
                 p_metric, p_metric, p_metric)
    INTO ok USING p_amount, p_business_id, p_cap;
  RETURN COALESCE(ok, FALSE);
END $$;

CREATE OR REPLACE FUNCTION refund_quota(p_business_id UUID, p_metric TEXT, p_amount INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_metric NOT IN ('videos_used_this_month','ocr_scans_used_this_month','tx_logged_this_month',
                      'pdf_receipts_used_this_month','ceo_reports_used_this_month') THEN
    RAISE EXCEPTION 'unknown metric %', p_metric;
  END IF;
  EXECUTE format('UPDATE businesses SET %I = GREATEST(0, %I - $1) WHERE id = $2', p_metric, p_metric)
    USING p_amount, p_business_id;
END $$;

-- Confirm a batch and apply side effects (stock, debts, spend, price memory) in one transaction.
CREATE OR REPLACE FUNCTION confirm_batch(p_batch_id UUID)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE t RECORD; n INT := 0;
BEGIN
  FOR t IN SELECT * FROM transactions WHERE batch_id = p_batch_id AND status = 'pending_confirm' FOR UPDATE LOOP
    UPDATE transactions SET status = 'confirmed', confirmed_at = NOW() WHERE id = t.id;
    n := n + 1;

    IF t.product_id IS NOT NULL THEN
      IF t.tx_type = 'sale' THEN
        UPDATE products SET stock_qty = stock_qty - t.quantity, last_sold_at = t.transaction_date,
               selling_price_ngn = COALESCE(t.unit_price_ngn, selling_price_ngn), updated_at = NOW()
         WHERE id = t.product_id;
      ELSIF t.tx_type = 'restock' THEN
        UPDATE products SET stock_qty = stock_qty + t.quantity,
               previous_cost_price_ngn = CASE WHEN t.unit_price_ngn IS NOT NULL THEN cost_price_ngn ELSE previous_cost_price_ngn END,
               cost_price_ngn = COALESCE(t.unit_price_ngn, cost_price_ngn), updated_at = NOW()
         WHERE id = t.product_id;
      END IF;
    END IF;

    IF t.customer_id IS NOT NULL THEN
      IF t.tx_type = 'sale' THEN
        UPDATE customers SET total_spent_ngn = total_spent_ngn + t.total_amount_ngn,
               outstanding_debt_ngn = outstanding_debt_ngn + GREATEST(0, t.balance_due_ngn),
               debt_since = CASE WHEN t.balance_due_ngn > 0 THEN COALESCE(debt_since, t.transaction_date) ELSE debt_since END
         WHERE id = t.customer_id;
      ELSIF t.tx_type = 'debt_repayment' THEN
        UPDATE customers SET outstanding_debt_ngn = GREATEST(0, outstanding_debt_ngn - t.amount_paid_ngn),
               debt_since = CASE WHEN outstanding_debt_ngn - t.amount_paid_ngn <= 0 THEN NULL ELSE debt_since END
         WHERE id = t.customer_id;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Undo: pending batches any time; confirmed batches within 5 minutes. Reverses side effects.
CREATE OR REPLACE FUNCTION undo_batch(p_batch_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE t RECORD; touched INT := 0;
BEGIN
  FOR t IN SELECT * FROM transactions WHERE batch_id = p_batch_id
            AND (status = 'pending_confirm' OR (status = 'confirmed' AND confirmed_at > NOW() - INTERVAL '5 minutes'))
           FOR UPDATE LOOP
    touched := touched + 1;
    IF t.status = 'confirmed' THEN
      IF t.product_id IS NOT NULL THEN
        IF t.tx_type = 'sale' THEN
          UPDATE products SET stock_qty = stock_qty + t.quantity WHERE id = t.product_id;
        ELSIF t.tx_type = 'restock' THEN
          UPDATE products SET stock_qty = stock_qty - t.quantity,
                 cost_price_ngn = COALESCE(previous_cost_price_ngn, cost_price_ngn) WHERE id = t.product_id;
        END IF;
      END IF;
      IF t.customer_id IS NOT NULL THEN
        IF t.tx_type = 'sale' THEN
          UPDATE customers SET total_spent_ngn = GREATEST(0, total_spent_ngn - t.total_amount_ngn),
                 outstanding_debt_ngn = GREATEST(0, outstanding_debt_ngn - GREATEST(0, t.balance_due_ngn))
           WHERE id = t.customer_id;
        ELSIF t.tx_type = 'debt_repayment' THEN
          UPDATE customers SET outstanding_debt_ngn = outstanding_debt_ngn + t.amount_paid_ngn,
                 debt_since = COALESCE(debt_since, NOW()) WHERE id = t.customer_id;
        END IF;
      END IF;
    END IF;
    UPDATE transactions SET status = 'undone' WHERE id = t.id;
  END LOOP;
  RETURN touched > 0;
END $$;

-- Ledger totals for a window. Profit = sales − (expenses + restock).
CREATE OR REPLACE FUNCTION ledger_summary(p_business_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (revenue_ngn NUMERIC, cash_in_ngn NUMERIC, expenses_ngn NUMERIC, restock_ngn NUMERIC,
               debt_collected_ngn NUMERIC, net_profit_ngn NUMERIC, tx_count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'sale'), 0),
    COALESCE(SUM(amount_paid_ngn)  FILTER (WHERE tx_type IN ('sale','debt_repayment')), 0),
    COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'expense'), 0),
    COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'restock'), 0),
    COALESCE(SUM(amount_paid_ngn)  FILTER (WHERE tx_type = 'debt_repayment'), 0),
    COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'sale'), 0)
      - COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type IN ('expense','restock')), 0),
    COUNT(*)
  FROM transactions
  WHERE business_id = p_business_id AND status = 'confirmed'
    AND transaction_date >= p_from AND transaction_date < p_to;
$$;

CREATE OR REPLACE FUNCTION expenses_by_category(p_business_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (category TEXT, amount_ngn NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT t.category, SUM(t.total_amount_ngn) FROM transactions t
   WHERE t.business_id = p_business_id AND t.status = 'confirmed' AND t.tx_type = 'expense'
     AND t.transaction_date >= p_from AND t.transaction_date < p_to
   GROUP BY t.category ORDER BY 2 DESC;
$$;

CREATE OR REPLACE FUNCTION top_products(p_business_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_limit INT DEFAULT 5)
RETURNS TABLE (name TEXT, qty NUMERIC, revenue_ngn NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p.name, t.description), SUM(t.quantity), SUM(t.total_amount_ngn)
    FROM transactions t LEFT JOIN products p ON p.id = t.product_id
   WHERE t.business_id = p_business_id AND t.status = 'confirmed' AND t.tx_type = 'sale'
     AND t.transaction_date >= p_from AND t.transaction_date < p_to
   GROUP BY 1 ORDER BY 3 DESC LIMIT p_limit;
$$;

-- Apply a successful subscription charge exactly once (+ wallet discount + ₦1,000 give-to-get).
CREATE OR REPLACE FUNCTION apply_subscription_payment(
  p_billing_event_id UUID, p_business_id UUID, p_tier TEXT, p_cycle TEXT,
  p_amount_ngn NUMERIC, p_wallet_applied NUMERIC DEFAULT 0)
RETURNS TABLE (processed BOOLEAN, referrer_id UUID, referral_credited BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  b businesses%ROWTYPE;
  credited BOOLEAN := FALSE;
BEGIN
  UPDATE billing_events SET processed_at = NOW() WHERE id = p_billing_event_id AND processed_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, FALSE; RETURN;
  END IF;

  SELECT * INTO b FROM businesses WHERE id = p_business_id FOR UPDATE;

  UPDATE businesses SET
    subscription_tier = p_tier,
    billing_cycle = p_cycle,
    subscription_expires_at = GREATEST(subscription_expires_at, NOW())
                              + CASE WHEN p_cycle = 'annual' THEN INTERVAL '365 days' ELSE INTERVAL '30 days' END,
    videos_used_this_month = 0, ocr_scans_used_this_month = 0, tx_logged_this_month = 0,
    pdf_receipts_used_this_month = 0, ceo_reports_used_this_month = 0, usage_period_start = CURRENT_DATE,
    updated_at = NOW()
  WHERE id = p_business_id;

  IF p_wallet_applied > 0 THEN
    UPDATE businesses SET referral_wallet_ngn = GREATEST(0, referral_wallet_ngn - p_wallet_applied) WHERE id = p_business_id;
    INSERT INTO referral_ledger (business_id, entry_type, amount_ngn, notes)
      VALUES (p_business_id, 'subscription_discount', -p_wallet_applied, 'billing_event ' || p_billing_event_id);
  END IF;

  -- First paid conversion ≥ ₦5,000 list price (wallet discount still qualifies)
  IF b.referred_by_business_id IS NOT NULL AND NOT b.referral_reward_paid AND (p_amount_ngn + p_wallet_applied) >= 5000 THEN
    UPDATE businesses SET referral_wallet_ngn = referral_wallet_ngn + 1000, updated_at = NOW() WHERE id = b.referred_by_business_id;
    UPDATE businesses SET referral_wallet_ngn = referral_wallet_ngn + 1000, referral_reward_paid = TRUE WHERE id = p_business_id;
    INSERT INTO referral_ledger (business_id, related_business_id, entry_type, amount_ngn, notes) VALUES
      (b.referred_by_business_id, p_business_id, 'referrer_bonus', 1000, 'billing_event ' || p_billing_event_id),
      (p_business_id, b.referred_by_business_id, 'signup_bonus', 1000, 'billing_event ' || p_billing_event_id);
    credited := TRUE;
  END IF;

  RETURN QUERY SELECT TRUE, b.referred_by_business_id, credited;
END $$;

CREATE OR REPLACE FUNCTION request_payout(p_business_id UUID, p_bank_details TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE amt NUMERIC;
BEGIN
  SELECT referral_wallet_ngn INTO amt FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF amt IS NULL OR amt < 5000 THEN RETURN 0; END IF;
  UPDATE businesses SET referral_wallet_ngn = 0, updated_at = NOW() WHERE id = p_business_id;
  INSERT INTO payout_requests (business_id, amount_ngn, bank_details) VALUES (p_business_id, amt, p_bank_details);
  INSERT INTO referral_ledger (business_id, entry_type, amount_ngn, notes) VALUES (p_business_id, 'cash_payout', -amt, 'requested');
  RETURN amt;
END $$;

-- Hourly: trial → free_limited; lapsed paid (3-day grace for card retries) → free_limited. Never hard-lock.
CREATE OR REPLACE FUNCTION downgrade_expired()
RETURNS SETOF UUID LANGUAGE sql AS $$
  UPDATE businesses SET subscription_tier = 'free_limited',
         videos_used_this_month = 0, ocr_scans_used_this_month = 0, tx_logged_this_month = 0,
         pdf_receipts_used_this_month = 0, ceo_reports_used_this_month = 0,
         usage_period_start = CURRENT_DATE, updated_at = NOW()
   WHERE (subscription_tier = 'trial' AND trial_ends_at < NOW())
      OR (subscription_tier IN ('starter_5k','growth_15k') AND subscription_expires_at < NOW() - INTERVAL '3 days')
  RETURNING id;
$$;

-- Monthly reset on the 1st (idempotent via usage_period_start). Trial counters are lifetime-of-trial.
CREATE OR REPLACE FUNCTION reset_monthly_usage()
RETURNS INT LANGUAGE sql AS $$
  WITH u AS (
    UPDATE businesses SET videos_used_this_month = 0, ocr_scans_used_this_month = 0, tx_logged_this_month = 0,
           pdf_receipts_used_this_month = 0, ceo_reports_used_this_month = 0,
           usage_period_start = date_trunc('month', NOW() AT TIME ZONE 'Africa/Lagos')::date
     WHERE subscription_tier <> 'trial'
       AND usage_period_start < date_trunc('month', NOW() AT TIME ZONE 'Africa/Lagos')::date
    RETURNING 1)
  SELECT COUNT(*)::INT FROM u;
$$;

-- PATCH (security): v1.0 left RLS off → every table readable via PostgREST with the public anon key.
-- With RLS on and no policies, only the service-role backend can read/write.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Storage buckets (private; delivered to WhatsApp via short-lived signed URLs)
INSERT INTO storage.buckets (id, name, public) VALUES
  ('raw-images', 'raw-images', FALSE),
  ('cleaned-images', 'cleaned-images', FALSE),
  ('videos', 'videos', FALSE),
  ('pdf-receipts', 'pdf-receipts', FALSE)
ON CONFLICT (id) DO NOTHING;
