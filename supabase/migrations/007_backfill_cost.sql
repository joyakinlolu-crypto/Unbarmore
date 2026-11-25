-- 007: When a cost price is given AFTER the sales (the usual order for a shop that just started),
-- fill it into that product's earlier sales so profit and the dashboard update at once.
-- Only sales that had NO cost yet are touched. Safe to run more than once.
CREATE OR REPLACE FUNCTION backfill_unit_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cost_price_ngn IS NOT NULL AND NEW.cost_price_ngn > 0 AND NEW.cost_price_ngn IS DISTINCT FROM OLD.cost_price_ngn THEN
    UPDATE transactions SET unit_cost_ngn = NEW.cost_price_ngn
     WHERE product_id = NEW.id AND tx_type = 'sale' AND status = 'confirmed' AND unit_cost_ngn IS NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_backfill_unit_cost ON products;
CREATE TRIGGER trg_backfill_unit_cost AFTER UPDATE OF cost_price_ngn ON products
  FOR EACH ROW EXECUTE FUNCTION backfill_unit_cost();
