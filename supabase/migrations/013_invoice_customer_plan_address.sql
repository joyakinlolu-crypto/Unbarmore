-- ============================================================================
-- 013 — Invoice customer phone + payment plan; the business's address
--   • quotes (the invoices table): customer_phone, payment_plan (the instalments printed on the invoice)
--   • businesses.address: printed under the business name on receipts and invoices ("MY ADDRESS 12 Bode St, Ibadan")
-- Run AFTER 001–012. Safe to run twice.
-- ============================================================================
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_phone TEXT CHECK (customer_phone IS NULL OR customer_phone ~ '^[0-9]{10,15}$');
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS payment_plan JSONB;           -- [{ "no": 1, "amount": 53500, "due": "2026-11-28", "label": "Deposit" }, ...]
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT CHECK (address IS NULL OR length(address) <= 120);
