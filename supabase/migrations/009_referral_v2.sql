-- ============================================================================
-- 009 — Referral v2
--   • Only the REFERRER is paid. The new shop gets its free trial (paying both sides doubled the cost and invited fake accounts).
--   • The reward scales with the plan the referred shop buys: Starter ₦1,000 · Growth ₦3,000 (keep in sync with REFERRAL in src/config/plans.ts).
--   • Cash payout unlocks at ₦1,000 (one Starter referral), down from ₦5,000.
--   • Wallet money only discounts the owner's own renewal if the owner chooses it (businesses.referral_apply_to_renewal).
-- Run AFTER 001–008. Safe to run twice.
-- ============================================================================

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_apply_to_renewal BOOLEAN NOT NULL DEFAULT FALSE;

-- payout_requests carried its OWN hidden ₦5,000 floor (from 001): without this, every ₦1,000 payout would be refused by the table itself.
ALTER TABLE payout_requests DROP CONSTRAINT IF EXISTS payout_requests_amount_ngn_check;
ALTER TABLE payout_requests ADD CONSTRAINT payout_requests_amount_ngn_check CHECK (amount_ngn >= 1000);

-- The return shape gains reward_ngn, so the old function must be dropped first.
DROP FUNCTION IF EXISTS apply_subscription_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC);
CREATE FUNCTION apply_subscription_payment(
  p_billing_event_id UUID, p_business_id UUID, p_tier TEXT, p_cycle TEXT,
  p_amount_ngn NUMERIC, p_wallet_applied NUMERIC DEFAULT 0)
RETURNS TABLE (processed BOOLEAN, referrer_id UUID, referral_credited BOOLEAN, reward_ngn NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE
  b businesses%ROWTYPE;
  credited BOOLEAN := FALSE;
  reward NUMERIC := 0;
BEGIN
  UPDATE billing_events SET processed_at = NOW() WHERE id = p_billing_event_id AND processed_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, FALSE, 0::NUMERIC; RETURN;
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

  -- First paid conversion ≥ ₦5,000 list price (a wallet discount still qualifies). Only the REFERRER is rewarded.
  IF b.referred_by_business_id IS NOT NULL AND NOT b.referral_reward_paid AND (p_amount_ngn + p_wallet_applied) >= 5000 THEN
    reward := CASE p_tier WHEN 'growth_15k' THEN 3000 WHEN 'starter_5k' THEN 1000 ELSE 0 END;
    IF reward > 0 THEN
      UPDATE businesses SET referral_wallet_ngn = referral_wallet_ngn + reward, updated_at = NOW() WHERE id = b.referred_by_business_id;
      UPDATE businesses SET referral_reward_paid = TRUE WHERE id = p_business_id;
      INSERT INTO referral_ledger (business_id, related_business_id, entry_type, amount_ngn, notes)
        VALUES (b.referred_by_business_id, p_business_id, 'referrer_bonus', reward, 'billing_event ' || p_billing_event_id);
      credited := TRUE;
    END IF;
  END IF;

  RETURN QUERY SELECT TRUE, b.referred_by_business_id, credited, reward;
END $$;

-- Cash payout minimum: ₦1,000 (was ₦5,000). Same body as 003 otherwise.
CREATE OR REPLACE FUNCTION request_payout(p_business_id UUID, p_bank_name TEXT, p_account_number TEXT)
RETURNS TABLE (ok BOOLEAN, reason TEXT, ref TEXT, amount_ngn NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE
  min_payout CONSTANT NUMERIC := 1000;   -- keep in sync with WITHDRAW_MIN_NGN in src/config/plans.ts (a test checks this)
  bal NUMERIC; l_id UUID; v_ref TEXT; v_bank TEXT := trim(coalesce(p_bank_name, ''));
BEGIN
  IF p_account_number IS NULL OR p_account_number !~ '^[0-9]{10}$' THEN RETURN QUERY SELECT FALSE, 'bad_account', NULL::TEXT, 0::NUMERIC; RETURN; END IF;
  IF length(v_bank) < 2 OR length(v_bank) > 40 THEN RETURN QUERY SELECT FALSE, 'bad_bank', NULL::TEXT, 0::NUMERIC; RETURN; END IF;

  SELECT referral_wallet_ngn INTO bal FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF bal IS NULL THEN RETURN QUERY SELECT FALSE, 'no_business', NULL::TEXT, 0::NUMERIC; RETURN; END IF;

  IF EXISTS (SELECT 1 FROM referral_ledger WHERE business_id = p_business_id AND entry_type = 'cash_payout' AND status = 'pending') THEN
    RETURN QUERY SELECT FALSE, 'already_pending', NULL::TEXT, bal; RETURN;
  END IF;
  IF bal < min_payout THEN RETURN QUERY SELECT FALSE, 'below_minimum', NULL::TEXT, bal; RETURN; END IF;

  v_ref := 'WD-' || upper(substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 6));
  UPDATE businesses SET referral_wallet_ngn = 0, updated_at = NOW() WHERE id = p_business_id;
  INSERT INTO referral_ledger (business_id, entry_type, amount_ngn, notes, status)
    VALUES (p_business_id, 'cash_payout', -bal, v_ref, 'pending') RETURNING id INTO l_id;
  INSERT INTO payout_requests (business_id, amount_ngn, bank_details, bank_name, account_number, ref, ledger_id)
    VALUES (p_business_id, bal, v_bank || ' · ' || p_account_number, v_bank, p_account_number, v_ref, l_id);
  RETURN QUERY SELECT TRUE, 'ok', v_ref, bal;
END $$;

REVOKE EXECUTE ON FUNCTION apply_subscription_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC), request_payout(UUID, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
