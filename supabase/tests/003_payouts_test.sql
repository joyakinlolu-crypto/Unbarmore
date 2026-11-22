-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/003_payouts_test.sql   (against a scratch database that has 001+002+003 applied)
\set QUIET on
CREATE TEMP TABLE results (name TEXT, pass BOOLEAN, detail TEXT);
CREATE OR REPLACE FUNCTION pg_temp.check(n TEXT, c BOOLEAN, d TEXT DEFAULT '') RETURNS VOID LANGUAGE plpgsql AS $$ BEGIN INSERT INTO results VALUES (n, COALESCE(c, FALSE), d); END $$;

INSERT INTO businesses (name, owner_phone, referral_wallet_ngn) VALUES ('Payout Test', '2349100000001', 4000);
CREATE TEMP TABLE biz AS SELECT id FROM businesses WHERE owner_phone = '2349100000001';

-- refusals
SELECT pg_temp.check('below ₦5,000 is refused (and nothing moves)', (SELECT reason FROM request_payout((SELECT id FROM biz), 'GTBank', '0123456789')) = 'below_minimum'
  AND (SELECT referral_wallet_ngn FROM businesses WHERE id = (SELECT id FROM biz)) = 4000);
UPDATE businesses SET referral_wallet_ngn = 5000 WHERE id = (SELECT id FROM biz);
SELECT pg_temp.check('9-digit account refused',  (SELECT reason FROM request_payout((SELECT id FROM biz), 'GTBank', '123456789')) = 'bad_account');
SELECT pg_temp.check('11-digit account refused', (SELECT reason FROM request_payout((SELECT id FROM biz), 'GTBank', '01234567890')) = 'bad_account');
SELECT pg_temp.check('letters in account refused', (SELECT reason FROM request_payout((SELECT id FROM biz), 'GTBank', '01234abc89')) = 'bad_account');
SELECT pg_temp.check('blank / 1-char bank refused', (SELECT reason FROM request_payout((SELECT id FROM biz), ' ', '0123456789')) = 'bad_bank' AND (SELECT reason FROM request_payout((SELECT id FROM biz), 'X', '0123456789')) = 'bad_bank');
SELECT pg_temp.check('refusals did not touch the wallet', (SELECT referral_wallet_ngn FROM businesses WHERE id = (SELECT id FROM biz)) = 5000);

-- happy path
CREATE TEMP TABLE r1 AS SELECT * FROM request_payout((SELECT id FROM biz), '  Access Bank ', '0123456789');
SELECT pg_temp.check('exactly ₦5,000 → ok, WD-XXXXXX reference', (SELECT ok AND ref ~ '^WD-[0-9A-F]{6}$' AND amount_ngn = 5000 FROM r1), (SELECT ref FROM r1));
SELECT pg_temp.check('wallet is zeroed in the same step', (SELECT referral_wallet_ngn FROM businesses WHERE id = (SELECT id FROM biz)) = 0);
SELECT pg_temp.check('referral_ledger row is PENDING and negative', (SELECT count(*) FROM referral_ledger WHERE business_id = (SELECT id FROM biz) AND entry_type = 'cash_payout' AND status = 'pending' AND amount_ngn = -5000) = 1);
SELECT pg_temp.check('payout_requests row holds trimmed bank + NUBAN + link to the ledger row', (SELECT count(*) FROM payout_requests p JOIN referral_ledger l ON l.id = p.ledger_id WHERE p.business_id = (SELECT id FROM biz) AND p.bank_name = 'Access Bank' AND p.account_number = '0123456789' AND p.status = 'requested') = 1);

-- double withdrawal
UPDATE businesses SET referral_wallet_ngn = 9000 WHERE id = (SELECT id FROM biz);   -- even if the wallet refills while one is pending…
SELECT pg_temp.check('2nd request while one is pending → already_pending', (SELECT reason FROM request_payout((SELECT id FROM biz), 'GTBank', '0123456789')) = 'already_pending');
SELECT pg_temp.check('…and the wallet is untouched', (SELECT referral_wallet_ngn FROM businesses WHERE id = (SELECT id FROM biz)) = 9000);
DO $$ BEGIN
  BEGIN INSERT INTO referral_ledger (business_id, entry_type, amount_ngn, status) VALUES ((SELECT id FROM biz), 'cash_payout', -1, 'pending');
        PERFORM pg_temp.check('DB index blocks a 2nd pending payout even if the function were bypassed', FALSE);
  EXCEPTION WHEN unique_violation THEN PERFORM pg_temp.check('DB index blocks a 2nd pending payout even if the function were bypassed', TRUE); END;
  BEGIN INSERT INTO payout_requests (business_id, amount_ngn, bank_details, account_number) VALUES ((SELECT id FROM biz), 5000, 'x', '123');
        PERFORM pg_temp.check('DB CHECK refuses a non-10-digit account even on direct insert', FALSE);
  EXCEPTION WHEN check_violation THEN PERFORM pg_temp.check('DB CHECK refuses a non-10-digit account even on direct insert', TRUE); END;
END $$;

-- admin: paid
CREATE TEMP TABLE d1 AS SELECT * FROM decide_payout((SELECT ref FROM r1), 'paid');
SELECT pg_temp.check('admin marks PAID (case-insensitive ref)', (SELECT ok FROM d1) AND (SELECT status FROM payout_requests WHERE ref = (SELECT ref FROM r1)) = 'paid');
SELECT pg_temp.check('ledger row becomes completed', (SELECT status FROM referral_ledger WHERE notes = (SELECT ref FROM r1)) = 'completed');
SELECT pg_temp.check('a second decision is refused', (SELECT reason FROM decide_payout(lower((SELECT ref FROM r1)), 'rejected')) = 'already_decided');
SELECT pg_temp.check('unknown ref / bad decision refused', (SELECT reason FROM decide_payout('WD-NOPE00', 'paid')) = 'not_found' AND (SELECT reason FROM decide_payout((SELECT ref FROM r1), 'maybe')) = 'bad_decision');
SELECT pg_temp.check('after PAID a NEW payout is allowed again (wallet 9,000)', (SELECT ok FROM request_payout((SELECT id FROM biz), 'Opay', '8101234567')));

-- admin: rejected refunds the wallet
CREATE TEMP TABLE d2 AS SELECT * FROM decide_payout((SELECT ref FROM payout_requests WHERE bank_name = 'Opay'), 'rejected');
SELECT pg_temp.check('REJECT refunds the full ₦9,000 to the wallet', (SELECT referral_wallet_ngn FROM businesses WHERE id = (SELECT id FROM biz)) = 9000);
SELECT pg_temp.check('rejected ledger row is voided and frees the pending slot', (SELECT count(*) FROM referral_ledger WHERE business_id = (SELECT id FROM biz) AND status = 'pending') = 0);
SELECT pg_temp.check('wallet reconciles with the ledger: wallet = 5,000 paid out already deducted … (9,000 now, paid payout −5,000 recorded)',
  (SELECT sum(amount_ngn) FROM referral_ledger WHERE business_id = (SELECT id FROM biz) AND status IN ('completed','pending')) = -5000);

\set QUIET off
SELECT CASE WHEN pass THEN '✅' ELSE '❌' END || ' ' || name || CASE WHEN detail <> '' THEN ' — ' || detail ELSE '' END AS result FROM results;
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' AS summary FROM results;
DELETE FROM businesses WHERE owner_phone = '2349100000001';  -- cascades payout_requests + referral_ledger (proves the FK fix)
