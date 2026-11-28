-- ============================================================================
-- 014: Founding-shop price. A shop the admin marks as "founding" pays a locked monthly price for Growth until founding_until.
-- Admin sets it from WhatsApp: FOUNDING 08012345678. Safe to run twice. Run AFTER 001-013.
-- ============================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS founding_price_ngn INTEGER CHECK (founding_price_ngn IS NULL OR founding_price_ngn >= 1000);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS founding_until TIMESTAMPTZ;
