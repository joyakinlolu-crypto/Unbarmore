-- ============================================================================
-- 011 — Quotes (branded quotations / invoices) + the owner's pay-to details
--   • quotes: what the owner promised a customer. NOT a sale: nothing hits the books until "Q-014 PAID".
--     valid_until is NULL on plans without a validity window (free), a date on Starter/Growth/trial.
--   • businesses.pay_details: "GTBank 0123456789 Ada Fabrics", printed on every quote so the customer can pay at once.
-- Written only by the bot (service role). Run AFTER 001–010. Safe to run twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  quote_no INT NOT NULL CHECK (quote_no > 0),
  customer_name TEXT,
  lines JSONB NOT NULL,                                    -- [{ item, qty, unit }]
  delivery_fee_ngn NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (delivery_fee_ngn >= 0),
  total_ngn NUMERIC(14, 2) NOT NULL CHECK (total_ngn >= 0),
  valid_until DATE,
  note TEXT CHECK (note IS NULL OR length(note) <= 160),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  paid_at TIMESTAMPTZ,
  paid_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, quote_no)
);
CREATE INDEX IF NOT EXISTS idx_quotes_open ON quotes (business_id, status, valid_until);
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;              -- no policies: only the service role (the bot) can touch it
REVOKE ALL ON quotes FROM anon, authenticated, PUBLIC;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pay_details TEXT CHECK (pay_details IS NULL OR length(pay_details) <= 160);
