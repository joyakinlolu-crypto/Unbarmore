-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/007_backfill_test.sql   (scratch database with 001–007 applied)
BEGIN;
INSERT INTO businesses (id, name, owner_phone) VALUES ('aaaaaaaa-0000-0000-0000-000000000007', 'Backfill Test', '2349000000777');
INSERT INTO business_users (business_id, phone_number, full_name, role) VALUES ('aaaaaaaa-0000-0000-0000-000000000007', '2349000000777', 'T', 'owner');
-- A shop that started selling BEFORE it knew its costs: cost price 0 / unknown.
INSERT INTO products (id, business_id, sku_code, name, cost_price_ngn, selling_price_ngn, stock_qty)
VALUES ('bbbbbbbb-0000-0000-0000-000000000071', 'aaaaaaaa-0000-0000-0000-000000000007', 'UNB-LLL', 'Lace', 0, 4000, 0),
       ('bbbbbbbb-0000-0000-0000-000000000072', 'aaaaaaaa-0000-0000-0000-000000000007', 'UNB-MMM', 'Gele', 0, 3000, 0);
INSERT INTO transactions (business_id, batch_id, tx_type, description, quantity, unit_price_ngn, total_amount_ngn, amount_paid_ngn, product_id, status)
VALUES
 ('aaaaaaaa-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000007', 'sale', '5 x Lace', 5, 4000, 20000, 20000, 'bbbbbbbb-0000-0000-0000-000000000071', 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000007', 'sale', '3 x Lace', 3, 4000, 12000, 12000, 'bbbbbbbb-0000-0000-0000-000000000071', 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000007', 'sale', '2 x Gele', 2, 3000, 6000, 6000, 'bbbbbbbb-0000-0000-0000-000000000072', 'pending_confirm'),
 ('aaaaaaaa-0000-0000-0000-000000000007', 'cccccccc-0000-0000-0000-000000000007', 'expense', 'Transport', 1, NULL, 800, 800, NULL, 'pending_confirm');
SELECT confirm_batch('cccccccc-0000-0000-0000-000000000007');

DO $$
DECLARE s RECORD; r RECORD;
BEGIN
  SELECT * INTO s FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000007', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  ASSERT s.revenue_ngn = 38000 AND s.cogs_ngn = 0 AND s.unpriced_revenue_ngn = 38000, 'before: all sales unpriced, cost of goods 0 → ' || row_to_json(s);

  -- The owner now says "lace costs me 3,110": the 8 lace already sold must be costed.
  UPDATE products SET cost_price_ngn = 3110 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000071';
  SELECT * INTO s FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000007', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  ASSERT s.cogs_ngn = 8 * 3110, 'lace cost back-filled: 8 x 3110 = 24,880, got ' || s.cogs_ngn;
  ASSERT s.unpriced_revenue_ngn = 6000, 'only the gele (no cost yet) is still unpriced, got ' || s.unpriced_revenue_ngn;
  ASSERT s.net_profit_ngn = 38000 - 24880 - 800, 'profit = 38,000 − 24,880 − 800 = 12,320, got ' || s.net_profit_ngn;

  -- A later cost change must NOT rewrite sales that already have a cost (history stays as it was).
  UPDATE products SET cost_price_ngn = 3500 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000071';
  SELECT * INTO s FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000007', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  ASSERT s.cogs_ngn = 24880, 'old costed sales keep their old cost, got ' || s.cogs_ngn;

  -- Setting a zero cost (unknown) never wipes or invents anything.
  UPDATE products SET cost_price_ngn = 0 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000072';
  SELECT * INTO s FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000007', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  ASSERT s.unpriced_revenue_ngn = 6000, 'zero cost does not price anything, got ' || s.unpriced_revenue_ngn;

  -- Gele cost arrives later: priced too.
  UPDATE products SET cost_price_ngn = 2000 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000072';
  SELECT * INTO s FROM ledger_summary('aaaaaaaa-0000-0000-0000-000000000007', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day');
  ASSERT s.unpriced_revenue_ngn = 0 AND s.cogs_ngn = 24880 + 4000, 'gele priced: cogs 28,880, got ' || s.cogs_ngn;

  -- Undone sales are never touched.
  UPDATE transactions SET status = 'undone', unit_cost_ngn = NULL WHERE product_id = 'bbbbbbbb-0000-0000-0000-000000000072';
  UPDATE products SET cost_price_ngn = 2500 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000072';
  SELECT count(*) INTO s FROM transactions WHERE product_id = 'bbbbbbbb-0000-0000-0000-000000000072' AND unit_cost_ngn IS NOT NULL;
  ASSERT s.count = 0, 'undone rows must not be back-filled';
END $$;
ROLLBACK;
\echo 007 back-fill test: PASSED
