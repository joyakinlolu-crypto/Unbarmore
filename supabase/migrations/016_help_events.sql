-- ============================================================================
-- 016: what people get stuck on. One row each time someone opens a help topic or asks for a person.
-- Lets the admin see the top problems (SCORECARD) so the product can fix them. Safe to run twice. Run AFTER 001-015.
-- ============================================================================
CREATE TABLE IF NOT EXISTS help_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_help_events_day ON help_events (created_at DESC);
ALTER TABLE help_events ENABLE ROW LEVEL SECURITY;   -- server (service role) only; no public policy
