-- 006: The WhatsApp number a shop wants customers to message (shown on its videos).
-- NULL = use the owner's own number (owner_phone). Safe to run more than once.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_phone TEXT;
