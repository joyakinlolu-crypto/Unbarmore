-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/010_cash_counts_test.sql   (scratch database with 001–010 applied)
BEGIN;
INSERT INTO businesses (id, name, owner_phone) VALUES ('dddddddd-0000-0000-0000-000000000001', 'Count Test', '2349300000001');
DO $$
BEGIN
  INSERT INTO cash_counts (business_id, counted_ngn, expected_ngn, variance_ngn) VALUES ('dddddddd-0000-0000-0000-000000000001', 1000, NULL, NULL);
  ASSERT (SELECT count(*) FROM cash_counts WHERE business_id = 'dddddddd-0000-0000-0000-000000000001') = 1, 'first count (no expected) is stored';
  BEGIN INSERT INTO cash_counts (business_id, counted_ngn) VALUES ('dddddddd-0000-0000-0000-000000000001', -1); ASSERT FALSE, 'a negative count must be refused'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE businesses SET setaside_split = 'abc' WHERE id = 'dddddddd-0000-0000-0000-000000000001'; ASSERT FALSE, 'a malformed split must be refused'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE businesses SET setaside_split = '40/20/40' WHERE id = 'dddddddd-0000-0000-0000-000000000001';
  ASSERT (SELECT setaside_split FROM businesses WHERE id = 'dddddddd-0000-0000-0000-000000000001') = '40/20/40', 'a good split is stored';
  ASSERT NOT has_table_privilege('anon', 'cash_counts', 'SELECT') AND NOT has_table_privilege('authenticated', 'cash_counts', 'SELECT'), 'the public API roles cannot read cash counts';
  -- deleting a business removes its counts (DELETE MY DATA must leave nothing behind)
  DELETE FROM businesses WHERE id = 'dddddddd-0000-0000-0000-000000000001';
  ASSERT (SELECT count(*) FROM cash_counts WHERE business_id = 'dddddddd-0000-0000-0000-000000000001') = 0, 'counts are deleted with the business';
END $$;
ROLLBACK;
\echo 010 cash counts test: PASSED
