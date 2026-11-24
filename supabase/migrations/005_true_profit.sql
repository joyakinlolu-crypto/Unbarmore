-- 005: TRUE PROFIT.
-- Before: "profit" = sales − (expenses + stock bought). That is cash left, not profit: a sale of stock bought last month looked like
-- 100% profit, and buying stock looked like a loss. Now:
--   profit = sales − cost of the goods sold − running costs
-- Stock bought is an asset (shown separately), not a cost. Each sale remembers what the item cost at that moment.
-- Safe to run more than once.

-- 1. What one unit cost when it was sold (NULL = we did not know the cost price yet).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS unit_cost_ngn NUMERIC(12, 2);

-- 2. confirm_batch: same as before, plus the cost snapshot on every sale line.
CREATE OR REPLACE FUNCTION confirm_batch(p_batch_id UUID)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE t RECORD; n INT := 0;
BEGIN
  FOR t IN SELECT * FROM transactions WHERE batch_id = p_batch_id AND status = 'pending_confirm' FOR UPDATE LOOP
    UPDATE transactions SET status = 'confirmed', confirmed_at = NOW() WHERE id = t.id;
    n := n + 1;

    IF t.product_id IS NOT NULL THEN
      IF t.tx_type = 'sale' THEN
        UPDATE transactions SET unit_cost_ngn = (SELECT NULLIF(cost_price_ngn, 0) FROM products WHERE id = t.product_id)
         WHERE id = t.id AND unit_cost_ngn IS NULL;
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

-- 3. Old sales: use the product's current cost price as the best available estimate.
UPDATE transactions t SET unit_cost_ngn = NULLIF(p.cost_price_ngn, 0)
  FROM products p
 WHERE t.product_id = p.id AND t.tx_type = 'sale' AND t.unit_cost_ngn IS NULL AND p.cost_price_ngn > 0;

-- 4. Totals for a window. New columns are APPENDED so older code keeps working.
--    net_profit_ngn = revenue − cost of goods sold − running costs (stock bought is NOT a cost).
--    unpriced_revenue_ngn = sales whose cost price we don't know: true profit is at most what is shown.
DROP FUNCTION IF EXISTS ledger_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ);
CREATE FUNCTION ledger_summary(p_business_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (revenue_ngn NUMERIC, cash_in_ngn NUMERIC, expenses_ngn NUMERIC, restock_ngn NUMERIC,
               debt_collected_ngn NUMERIC, net_profit_ngn NUMERIC, tx_count BIGINT,
               cogs_ngn NUMERIC, gross_profit_ngn NUMERIC, unpriced_revenue_ngn NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT
      COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'sale'), 0)                                   AS revenue,
      COALESCE(SUM(amount_paid_ngn)  FILTER (WHERE tx_type IN ('sale','debt_repayment')), 0)               AS cash_in,
      COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'expense'), 0)                                AS expenses,
      COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'restock'), 0)                                AS restock,
      COALESCE(SUM(amount_paid_ngn)  FILTER (WHERE tx_type = 'debt_repayment'), 0)                         AS debt_collected,
      COALESCE(SUM(quantity * unit_cost_ngn) FILTER (WHERE tx_type = 'sale' AND unit_cost_ngn IS NOT NULL), 0) AS cogs,
      COALESCE(SUM(total_amount_ngn) FILTER (WHERE tx_type = 'sale' AND unit_cost_ngn IS NULL), 0)         AS unpriced,
      COUNT(*)                                                                                             AS n
    FROM transactions
    WHERE business_id = p_business_id AND status = 'confirmed' AND transaction_date >= p_from AND transaction_date < p_to
  )
  SELECT revenue, cash_in, expenses, restock, debt_collected, revenue - cogs - expenses, n, cogs, revenue - cogs, unpriced FROM s;
$$;
REVOKE EXECUTE ON FUNCTION ledger_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon, authenticated, PUBLIC;
