-- 006: (1) the WhatsApp number a shop wants customers to message (shown on its videos);
--      (2) allow a Yoruba voice on videos.
-- NULL sales_phone = use the owner's own number (owner_phone). Safe to run more than once.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_phone TEXT;

ALTER TABLE video_jobs DROP CONSTRAINT IF EXISTS video_jobs_voice_language_check;
ALTER TABLE video_jobs ADD CONSTRAINT video_jobs_voice_language_check CHECK (voice_language IN ('en-NG', 'pidgin', 'yoruba'));
