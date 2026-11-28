-- ============================================================================
-- 015: "Did this video bring you a customer?" Three days after a video is made we ask once; the answer is stored here.
-- result: 'yes' (a customer came) | 'no' (posted it, nobody came) | 'unposted' (never posted it). Safe to run twice. Run AFTER 001-014.
-- ============================================================================
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS result TEXT CHECK (result IS NULL OR result IN ('yes', 'no', 'unposted'));
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS result_at TIMESTAMPTZ;
