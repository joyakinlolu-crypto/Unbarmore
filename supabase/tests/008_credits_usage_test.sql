-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/008_credits_usage_test.sql   (scratch database with 001–008 applied)
BEGIN;
INSERT INTO businesses (id, name, owner_phone) VALUES ('aaaaaaaa-0000-0000-0000-000000000008', 'Credits Test', '2349000000888');
DO $$
DECLARE ok BOOLEAN; bal INT; r RECORD;
BEGIN
  -- no credits → cannot consume
  ASSERT consume_video_credit('aaaaaaaa-0000-0000-0000-000000000008') = FALSE, 'no credits: consume must be refused';
  -- add 3 → balance 3
  ASSERT add_video_credits('aaaaaaaa-0000-0000-0000-000000000008', 3) = 3, 'add 3';
  -- consume 3 times OK, the 4th refused, balance never negative
  ASSERT consume_video_credit('aaaaaaaa-0000-0000-0000-000000000008') AND consume_video_credit('aaaaaaaa-0000-0000-0000-000000000008') AND consume_video_credit('aaaaaaaa-0000-0000-0000-000000000008'), 'three consumes';
  ASSERT consume_video_credit('aaaaaaaa-0000-0000-0000-000000000008') = FALSE, 'fourth consume refused';
  SELECT video_credits INTO bal FROM businesses WHERE id = 'aaaaaaaa-0000-0000-0000-000000000008';
  ASSERT bal = 0, 'balance is 0, got ' || bal;
  -- refund gives one back
  PERFORM refund_video_credit('aaaaaaaa-0000-0000-0000-000000000008');
  SELECT video_credits INTO bal FROM businesses WHERE id = 'aaaaaaaa-0000-0000-0000-000000000008';
  ASSERT bal = 1, 'refund → 1, got ' || bal;
  -- absurd quantities are refused
  BEGIN PERFORM add_video_credits('aaaaaaaa-0000-0000-0000-000000000008', 0); ASSERT FALSE, 'qty 0 must fail'; EXCEPTION WHEN raise_exception THEN NULL; END;
  BEGIN PERFORM add_video_credits('aaaaaaaa-0000-0000-0000-000000000008', 5000); ASSERT FALSE, 'qty 5000 must fail'; EXCEPTION WHEN raise_exception THEN NULL; END;
  -- the table itself can never go negative
  BEGIN UPDATE businesses SET video_credits = -1 WHERE id = 'aaaaaaaa-0000-0000-0000-000000000008'; ASSERT FALSE, 'negative must fail'; EXCEPTION WHEN check_violation THEN NULL; END;

  -- usage log: two photo cleanups and a message add up on the same row, per day and kind
  PERFORM log_ai_usage('aaaaaaaa-0000-0000-0000-000000000008', DATE '2026-11-27', 'photo_cleanup', 1, 268, 1290, 1, 58.1);
  PERFORM log_ai_usage('aaaaaaaa-0000-0000-0000-000000000008', DATE '2026-11-27', 'photo_cleanup', 1, 268, 1290, 1, 58.1);
  PERFORM log_ai_usage('aaaaaaaa-0000-0000-0000-000000000008', DATE '2026-11-27', 'message', 1, 2202, 135, 0, 0.41);
  PERFORM log_ai_usage('aaaaaaaa-0000-0000-0000-000000000008', DATE '2026-11-28', 'message', 1, 2202, 135, 0, 0.41);
  SELECT * INTO r FROM ai_usage WHERE business_id = 'aaaaaaaa-0000-0000-0000-000000000008' AND day = DATE '2026-11-27' AND kind = 'photo_cleanup';
  ASSERT r.calls = 2 AND r.images = 2 AND r.input_tokens = 536 AND r.output_tokens = 2580 AND r.est_cost_ngn = 116.2, 'two photo cleanups accumulate: ' || row_to_json(r);
  ASSERT (SELECT count(*) FROM ai_usage WHERE business_id = 'aaaaaaaa-0000-0000-0000-000000000008') = 3, 'three rows: 2 kinds on day 1, 1 on day 2';
END $$;
ROLLBACK;
\echo 008 credits + usage test: PASSED
