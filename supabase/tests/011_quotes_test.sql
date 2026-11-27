-- Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/011_quotes_test.sql   (scratch database with 001–011 applied)
BEGIN;
INSERT INTO businesses (id, name, owner_phone) VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'Quote Test', '2349400000001'), ('eeeeeeee-0000-0000-0000-000000000002', 'Other Shop', '2349400000002');
DO $$
BEGIN
  INSERT INTO quotes (business_id, quote_no, customer_name, lines, total_ngn, valid_until) VALUES ('eeeeeeee-0000-0000-0000-000000000001', 1, 'Mama Tunde', '[{"item":"Lace","qty":2,"unit":50000}]', 100000, CURRENT_DATE + 3);
  ASSERT (SELECT status FROM quotes WHERE business_id = 'eeeeeeee-0000-0000-0000-000000000001') = 'open', 'new quotes are open';
  BEGIN INSERT INTO quotes (business_id, quote_no, lines, total_ngn) VALUES ('eeeeeeee-0000-0000-0000-000000000001', 1, '[]', 5); ASSERT FALSE, 'duplicate number must be refused'; EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO quotes (business_id, quote_no, lines, total_ngn) VALUES ('eeeeeeee-0000-0000-0000-000000000002', 1, '[]', 5);   -- same number, different shop: fine
  BEGIN INSERT INTO quotes (business_id, quote_no, lines, total_ngn) VALUES ('eeeeeeee-0000-0000-0000-000000000001', 2, '[]', -1); ASSERT FALSE, 'negative total must be refused'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE quotes SET status = 'shipped' WHERE quote_no = 1 AND business_id = 'eeeeeeee-0000-0000-0000-000000000001'; ASSERT FALSE, 'bad status must be refused'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE businesses SET pay_details = repeat('x', 161) WHERE id = 'eeeeeeee-0000-0000-0000-000000000001'; ASSERT FALSE, 'a 161-character pay-to must be refused'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE businesses SET pay_details = 'GTBank 0123456789 Ada Fabrics' WHERE id = 'eeeeeeee-0000-0000-0000-000000000001';
  ASSERT NOT has_table_privilege('anon', 'quotes', 'SELECT') AND NOT has_table_privilege('authenticated', 'quotes', 'SELECT'), 'public API roles cannot read quotes';
  DELETE FROM businesses WHERE id = 'eeeeeeee-0000-0000-0000-000000000001';
  ASSERT (SELECT count(*) FROM quotes WHERE business_id = 'eeeeeeee-0000-0000-0000-000000000001') = 0, 'quotes are deleted with the business';
END $$;
ROLLBACK;
\echo 011 quotes test: PASSED
