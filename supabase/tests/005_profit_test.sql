-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/005_profit_test.sql   (scratch database with 001–005 applied)
BEGIN;
INSERT INTO businesses (id, name, owner_phone) VALUES ('aaaaaaaa-0000-0000-0000-000000000005', 'Profit Test', '2349000000555');
INSERT INTO business_users (business_id, phone_number, full_name, role) VALUES ('aaaaaaaa-0000-0000-0000-000000000005', '2349000000555', 'T', 'owner');
INSERT INTO products (id, business_id, sku_code, name, cost_price_ngn, selling_price_ngn, stock_qty)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000005', 'UNB-AAA', 'Lace', 15000, 20000, 20),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000005', 'UNB-BBB', 'Mystery', 0, 5000, 10);

-- 10 lace sold at 20k (cost 15k), 2 mystery sold at 5k (cost unknown), rent 10k, and 150k of NEW stock bought
INSERT INTO transactions (business_id, batch_id, tx_type, description, quantity, unit_price_ngn, total_amount_ngn, amount_paid_ngn, product_id, status)
VALUES
 ('aaaaaaaa-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000001', 'sale', '10 x Lace', 10, 20000, 200000, 200000, 'bbbbbbbb-0000-0000-0000-000000000001', 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000001', 'sale', '2 x Mystery', 2, 5000, 10000, 10000, 'bbbbbbbb-0000-0000-0000-000000000002', 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000001', 'expense', 'Rent', 1, NULL, 10000, 10000, NULL, 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000001', 'restock', '10 x Lace', 10, 15000, 150000, 150000, 'bbbbbbbb-0000-0000-0000-000000000001', 'pending_confirm');

SELECT confirm_batch('cccccccc-0000-0000-0000-000000000001');

DO $$
DECLARE r RECORD;
BEGIN
  -- the sale remembered what the lace cost at that moment; the unknown-cost item stays NULL
  IF (SELECT unit_cost_ngn FROM transactions WHERE description = '10 x Lace' AND tx_type = 'sale') <> 15000 THEN RAISE EXCEPTION 'cost snapshot missing'; END IF;
  IF (SELECT unit_cost_ngn FROM transactions WHERE description = '2 x Mystery') IS NOT NULL THEN RAISE EXCEPTION 'unknown cost must stay NULL'; END IF;

  SELECT * INTO r FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000005', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  IF r.revenue_ngn <> 210000 THEN RAISE EXCEPTION 'revenue %', r.revenue_ngn; END IF;
  IF r.cogs_ngn <> 150000 THEN RAISE EXCEPTION 'cogs % (10 x 15000)', r.cogs_ngn; END IF;
  IF r.gross_profit_ngn <> 60000 THEN RAISE EXCEPTION 'gross %', r.gross_profit_ngn; END IF;
  IF r.expenses_ngn <> 10000 THEN RAISE EXCEPTION 'expenses %', r.expenses_ngn; END IF;
  IF r.restock_ngn <> 150000 THEN RAISE EXCEPTION 'stock bought %', r.restock_ngn; END IF;
  -- THE FIX: buying 150k of stock is NOT a cost. profit = 210k − 150k − 10k = 50k (it used to say −100k)
  IF r.net_profit_ngn <> 50000 THEN RAISE EXCEPTION 'net profit % (want 50000)', r.net_profit_ngn; END IF;
  IF r.unpriced_revenue_ngn <> 10000 THEN RAISE EXCEPTION 'unpriced %', r.unpriced_revenue_ngn; END IF;
  RAISE NOTICE 'true profit OK: sales 210k − goods 150k − rent 10k = 50k; stock bought 150k kept out; 10k of sales flagged as no cost price';
END $$;

-- selling stock bought in an EARLIER period: no restock in the window, still not 100% profit
INSERT INTO transactions (business_id, batch_id, tx_type, description, quantity, unit_price_ngn, total_amount_ngn, amount_paid_ngn, product_id, status, transaction_date)
VALUES ('aaaaaaaa-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000002', 'sale', '4 x Lace', 4, 20000, 80000, 80000, 'bbbbbbbb-0000-0000-0000-000000000001', 'pending_confirm', NOW() + INTERVAL '3 days');
SELECT confirm_batch('cccccccc-0000-0000-0000-000000000002');
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000005', NOW() + INTERVAL '2 days', NOW() + INTERVAL '4 days');
  IF r.net_profit_ngn <> 20000 THEN RAISE EXCEPTION 'sold 4 lace for 80k (cost 60k) with no restock that period: profit should be 20000, got %', r.net_profit_ngn; END IF;
  RAISE NOTICE 'sale of earlier stock OK: 80k − 60k cost = 20k (it used to say 80k)';
END $$;

-- a later cost-price change never rewrites an old sale
UPDATE products SET cost_price_ngn = 18000 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000005', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  IF r.cogs_ngn <> 150000 THEN RAISE EXCEPTION 'old sale cost changed to %', r.cogs_ngn; END IF;
  RAISE NOTICE 'cost snapshot is frozen at the time of sale';
END $$;

-- undone sales leave no trace
SELECT undo_batch('cccccccc-0000-0000-0000-000000000002');
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000005', NOW() + INTERVAL '2 days', NOW() + INTERVAL '4 days');
  IF r.revenue_ngn <> 0 OR r.net_profit_ngn <> 0 THEN RAISE EXCEPTION 'undone sale still counted'; END IF;
  RAISE NOTICE 'undo OK';
END $$;

-- not callable by the public API roles
DO $$ BEGIN
  IF has_function_privilege('anon', 'ledger_summary(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN RAISE EXCEPTION 'anon can execute ledger_summary'; END IF;
END $$;
ROLLBACK;
