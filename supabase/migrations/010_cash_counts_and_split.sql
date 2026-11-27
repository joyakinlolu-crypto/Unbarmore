-- ============================================================================
-- 010 — Cash count + profit split
--   • cash_counts: what the owner actually counted in the drawer each evening ("COUNT 85000"), the cash we expected, and the gap.
--     This is how a cash leak shows up. Written only by the bot (service role); no API role can read or write it.
--   • businesses.setaside_split: the owner's evening profit split as "restock/reserve/pay" (e.g. 50/20/30). NULL = the default.
-- Run AFTER 001–009. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cash_counts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  counted_ngn NUMERIC(14, 2) NOT NULL CHECK (counted_ngn >= 0),
  expected_ngn NUMERIC(14, 2),            -- NULL on the very first count (nothing to compare with yet)
  variance_ngn NUMERIC(14, 2)             -- counted − expected: negative = money missing
);
CREATE INDEX IF NOT EXISTS idx_cash_counts_business_time ON cash_counts (business_id, counted_at DESC);
ALTER TABLE cash_counts ENABLE ROW LEVEL SECURITY;   -- no policies: only the service role (the bot) can touch it
REVOKE ALL ON cash_counts FROM anon, authenticated, PUBLIC;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS setaside_split TEXT CHECK (setaside_split IS NULL OR setaside_split ~ '^[0-9]{1,3}/[0-9]{1,3}/[0-9]{1,3}$');
