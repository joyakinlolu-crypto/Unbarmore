-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/009_referral_v2_test.sql   (scratch database with 001–009 applied)
\set QUIET on
BEGIN;
CREATE TEMP TABLE results (name TEXT, pass BOOLEAN, detail TEXT);
CREATE OR REPLACE FUNCTION pg_temp.check(n TEXT, c BOOLEAN, d TEXT DEFAULT '') RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN INSERT INTO results VALUES (n, COALESCE(c, FALSE), d); END $$;

INSERT INTO businesses (id, name, owner_phone) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Joy Fabrics', '2349200000001');
INSERT INTO businesses (id, name, owner_phone, referred_by_business_id) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002', 'New Starter Shop', '2349200000002', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'New Growth Shop',  '2349200000003', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'Unreferred Shop',  '2349200000004', NULL);
INSERT INTO billing_events (id, paystack_reference, business_id, event_type, amount_ngn, status, raw_payload) VALUES
  ('cccccccc-0000-0000-0000-000000000002', 'r2', 'bbbbbbbb-0000-0000-0000-000000000002', 'charge.success', 5000, 'success', '{}'),
  ('cccccccc-0000-0000-0000-000000000003', 'r3', 'bbbbbbbb-0000-0000-0000-000000000003', 'charge.success', 15000, 'success', '{}'),
  ('cccccccc-0000-0000-0000-000000000004', 'r4', 'bbbbbbbb-0000-0000-0000-000000000004', 'charge.success', 5000, 'success', '{}'),
  ('cccccccc-0000-0000-0000-000000000005', 'r5', 'bbbbbbbb-0000-0000-0000-000000000002', 'charge.success', 5000, 'success', '{}');

CREATE TEMP TABLE s AS SELECT * FROM apply_subscription_payment('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'starter_5k', 'monthly', 5000, 0);
SELECT pg_temp.check('Starter referral → referrer credited ₦1,000, reward reported', (SELECT referral_credited AND reward_ngn = 1000 AND referrer_id = 'bbbbbbbb-0000-0000-0000-000000000001' FROM s));
SELECT pg_temp.check('referrer wallet = ₦1,000', (SELECT referral_wallet_ngn FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') = 1000);
SELECT pg_temp.check('the NEW shop gets NO wallet credit', (SELECT referral_wallet_ngn FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0);
SELECT pg_temp.check('new shop is marked rewarded, upgraded to starter', (SELECT referral_reward_paid AND subscription_tier = 'starter_5k' FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002'));
SELECT pg_temp.check('ledger: one referrer_bonus, NO signup_bonus', (SELECT count(*) FROM referral_ledger WHERE entry_type = 'referrer_bonus' AND related_business_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 1
  AND (SELECT count(*) FROM referral_ledger WHERE entry_type = 'signup_bonus' AND business_id IN ('bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001')) = 0);

CREATE TEMP TABLE g AS SELECT * FROM apply_subscription_payment('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000003', 'growth_15k', 'monthly', 15000, 0);
SELECT pg_temp.check('Growth referral → referrer credited ₦3,000', (SELECT referral_credited AND reward_ngn = 3000 FROM g));
SELECT pg_temp.check('referrer wallet = ₦4,000 after both', (SELECT referral_wallet_ngn FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') = 4000);

CREATE TEMP TABLE u AS SELECT * FROM apply_subscription_payment('cccccccc-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000004', 'starter_5k', 'monthly', 5000, 0);
SELECT pg_temp.check('a shop nobody referred pays nothing to anyone', (SELECT NOT referral_credited AND reward_ngn = 0 FROM u));

CREATE TEMP TABLE again AS SELECT * FROM apply_subscription_payment('cccccccc-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000002', 'starter_5k', 'monthly', 5000, 0);
SELECT pg_temp.check('a second payment from the same shop never pays the reward again', (SELECT NOT referral_credited FROM again)
  AND (SELECT referral_wallet_ngn FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') = 4000);
SELECT pg_temp.check('replaying the SAME payment event does nothing', (SELECT NOT processed FROM apply_subscription_payment('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'starter_5k', 'monthly', 5000, 0)));

-- cash-out: ₦1,000 is enough now
UPDATE businesses SET referral_wallet_ngn = 900 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT pg_temp.check('₦900 is refused', (SELECT reason FROM request_payout('bbbbbbbb-0000-0000-0000-000000000001', 'GTBank', '0123456789')) = 'below_minimum');
UPDATE businesses SET referral_wallet_ngn = 1000 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
CREATE TEMP TABLE p AS SELECT * FROM request_payout('bbbbbbbb-0000-0000-0000-000000000001', 'GTBank', '0123456789');
SELECT pg_temp.check('exactly ₦1,000 is paid out, wallet zeroed', (SELECT ok AND amount_ngn = 1000 FROM p) AND (SELECT referral_wallet_ngn FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0);

-- choice of cash or renewal credit defaults to cash
SELECT pg_temp.check('wallet defaults to cash (not applied to renewal)', (SELECT referral_apply_to_renewal FROM businesses WHERE id = 'bbbbbbbb-0000-0000-0000-000000000004') = FALSE);

-- never callable by the public API roles
SELECT pg_temp.check('anon/authenticated cannot call the money functions', NOT has_function_privilege('anon', 'request_payout(uuid,text,text)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'apply_subscription_payment(uuid,uuid,text,text,numeric,numeric)', 'EXECUTE'));

SELECT CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, detail FROM results ORDER BY pass, name;
SELECT format('%s/%s passed', count(*) FILTER (WHERE pass), count(*)) AS summary FROM results;
ROLLBACK;
