-- ============================================================================
-- 003 — Referral cash payouts
--   • Wallet ≥ ₦1,000 can discount the owner's own renewal (app logic, unchanged here).
--   • CASH payout unlocks at ₦5,000 (= 5 paid referrals at ₦1,000 each).
--   • A payout is PENDING in referral_ledger until the admin marks it paid, or rejected (wallet refunded).
--   • Double withdrawal is blocked in the DATABASE, three ways:
--       1. the wallet row is locked (FOR UPDATE) and zeroed in the same transaction as the request,
--       2. a UNIQUE partial index allows at most ONE pending cash payout per business,
--       3. a CHECK constraint refuses anything but a 10-digit NUBAN account number.
-- Run AFTER 001 and 002. Safe to run once.
-- ============================================================================

-- 1. Lifecycle status on the wallet ledger. Existing rows are history → 'completed'.
ALTER TABLE referral_ledger
  ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'rejected'));

-- Payouts requested through the OLD function (notes = 'requested') are still awaiting the admin → keep them pending.
UPDATE referral_ledger l SET status = 'pending'
  FROM payout_requests p
 WHERE l.entry_type = 'cash_payout' AND l.notes = 'requested' AND p.business_id = l.business_id AND p.status = 'requested';

-- 2. At most ONE pending cash payout per business, enforced by the database itself.
CREATE UNIQUE INDEX uniq_pending_cash_payout ON referral_ledger (business_id)
  WHERE entry_type = 'cash_payout' AND status = 'pending';

-- 3. Structured bank details + a human reference the admin quotes (WD-XXXXXX).
ALTER TABLE payout_requests
  ADD COLUMN ref TEXT UNIQUE,
  ADD COLUMN bank_name TEXT,
  ADD COLUMN account_number TEXT CHECK (account_number IS NULL OR account_number ~ '^[0-9]{10}$'), -- NUBAN
  ADD COLUMN ledger_id UUID REFERENCES referral_ledger(id) ON DELETE SET NULL,
  ADD COLUMN decided_at TIMESTAMPTZ;

-- Deleting a business must not be blocked by (or orphan) its payout history.
ALTER TABLE payout_requests DROP CONSTRAINT payout_requests_business_id_fkey,
  ADD CONSTRAINT payout_requests_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;

-- 4. Request a payout of the WHOLE wallet. One atomic step; every refusal says why.
DROP FUNCTION IF EXISTS request_payout(UUID, TEXT);
CREATE OR REPLACE FUNCTION request_payout(p_business_id UUID, p_bank_name TEXT, p_account_number TEXT)
RETURNS TABLE (ok BOOLEAN, reason TEXT, ref TEXT, amount_ngn NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE
  min_payout CONSTANT NUMERIC := 5000;   -- keep in sync with WITHDRAW_MIN_NGN in src/config/plans.ts (a test checks this)
  bal NUMERIC; l_id UUID; v_ref TEXT; v_bank TEXT := trim(coalesce(p_bank_name, ''));
BEGIN
  IF p_account_number IS NULL OR p_account_number !~ '^[0-9]{10}$' THEN RETURN QUERY SELECT FALSE, 'bad_account', NULL::TEXT, 0::NUMERIC; RETURN; END IF;
  IF length(v_bank) < 2 OR length(v_bank) > 40 THEN RETURN QUERY SELECT FALSE, 'bad_bank', NULL::TEXT, 0::NUMERIC; RETURN; END IF;

  -- Lock the wallet row: two simultaneous requests are processed one after the other, never together.
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

-- 5. Admin decision: 'paid' (money was sent) or 'rejected' (wallet is refunded). Idempotent: a second decision is refused.
CREATE OR REPLACE FUNCTION decide_payout(p_ref TEXT, p_decision TEXT)
RETURNS TABLE (ok BOOLEAN, reason TEXT, business_id UUID, amount_ngn NUMERIC, bank_name TEXT, account_number TEXT)
LANGUAGE plpgsql AS $$
DECLARE pr payout_requests%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('paid', 'rejected') THEN RETURN QUERY SELECT FALSE, 'bad_decision', NULL::UUID, 0::NUMERIC, NULL::TEXT, NULL::TEXT; RETURN; END IF;
  SELECT * INTO pr FROM payout_requests WHERE payout_requests.ref = upper(trim(p_ref)) FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE, 'not_found', NULL::UUID, 0::NUMERIC, NULL::TEXT, NULL::TEXT; RETURN; END IF;
  IF pr.status <> 'requested' THEN RETURN QUERY SELECT FALSE, 'already_decided', pr.business_id, pr.amount_ngn, pr.bank_name, pr.account_number; RETURN; END IF;

  UPDATE payout_requests SET status = p_decision, decided_at = NOW() WHERE id = pr.id;
  IF p_decision = 'paid' THEN
    UPDATE referral_ledger SET status = 'completed' WHERE id = pr.ledger_id;
  ELSE
    -- Rejected: the debit row is voided (status 'rejected' is excluded from the wallet total) and the money returns to the wallet.
    UPDATE referral_ledger SET status = 'rejected' WHERE id = pr.ledger_id;
    UPDATE businesses SET referral_wallet_ngn = referral_wallet_ngn + pr.amount_ngn, updated_at = NOW() WHERE id = pr.business_id;
  END IF;
  RETURN QUERY SELECT TRUE, 'ok', pr.business_id, pr.amount_ngn, pr.bank_name, pr.account_number;
END $$;

REVOKE EXECUTE ON FUNCTION request_payout(UUID, TEXT, TEXT), decide_payout(TEXT, TEXT) FROM anon, authenticated, PUBLIC;
