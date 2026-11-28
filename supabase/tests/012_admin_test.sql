-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/012_admin_test.sql   (scratch database with 001–012 applied)
BEGIN;
DO $$
BEGIN
  ASSERT issue_admin_token('aaaa') = TRUE, 'issue works';
  ASSERT consume_admin_token('aaaa') = TRUE, 'first redemption succeeds';
  ASSERT consume_admin_token('aaaa') = FALSE, 'second redemption (replay) is refused';
  ASSERT consume_admin_token('never-issued') = FALSE, 'unknown token is refused';
  INSERT INTO admin_tokens (token_hash, expires_at) VALUES ('old', NOW() - INTERVAL '1 minute');
  ASSERT consume_admin_token('old') = FALSE, 'an expired token is refused';
  -- throttle: 5 per 10 minutes (1 already issued above, plus the expired one inserted directly = created_at now)
  ASSERT issue_admin_token('b1') AND issue_admin_token('b2') AND issue_admin_token('b3'), 'three more fit';
  ASSERT issue_admin_token('b4') = FALSE, 'the sixth within 10 minutes is refused';
  ASSERT NOT has_table_privilege('anon', 'admin_tokens', 'SELECT') AND NOT has_table_privilege('authenticated', 'admin_audit', 'SELECT'), 'public roles cannot read admin tables';
  ASSERT NOT has_function_privilege('anon', 'consume_admin_token(text)', 'EXECUTE'), 'public roles cannot redeem';
  INSERT INTO admin_audit (action, business_name, detail) VALUES ('view_as', 'Gone Shop', '{"x":1}');
  ASSERT (SELECT count(*) FROM admin_audit WHERE business_name = 'Gone Shop') = 1, 'audit rows are written';
END $$;
ROLLBACK;
\echo 012 admin test: PASSED
