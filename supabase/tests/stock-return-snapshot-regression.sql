BEGIN;
-- Isolate the assertion fixtures; all fixture and active-flag changes roll back.
UPDATE public.products SET is_active = false;
DO $$
DECLARE
  fixture_product_id uuid;
  return_type text;
  snapshot public.stock_daily_snapshots%rowtype;
BEGIN
  FOREACH return_type IN ARRAY ARRAY['fo_return', 'fo_prepare_return'] LOOP
    INSERT INTO public.products(name, category, stock_tracking_mode)
      VALUES ('Snapshot regression ' || return_type, 'amenity', 'amenity_prepare') RETURNING id INTO fixture_product_id;
    INSERT INTO public.main_stock(product_id, quantity) VALUES (fixture_product_id, 13);
    INSERT INTO public.floor_stock(product_id, floor_number, quantity) VALUES (fixture_product_id, 1, 7);
    INSERT INTO public.stock_daily_snapshots(business_date, product_id, product_name, category, tracking_mode,
      expected_closing_main, expected_closing_floor, actual_closing_main, actual_closing_floor, variance_main, variance_floor)
      VALUES ('2098-01-01', fixture_product_id, 'Snapshot fixture', 'amenity', 'amenity_prepare', 10, 10, 10, 10, 0, 0);
    INSERT INTO public.stock_transactions_v2(transaction_date, product_id, action, quantity_change, reference_type, from_location, to_location, floor_number)
      VALUES ('2098-01-02', fixture_product_id, 'return', 3, return_type, 'floor_1', 'main', 1);
    PERFORM public.compute_stock_snapshot('2098-01-02');
    SELECT * INTO snapshot FROM public.stock_daily_snapshots WHERE business_date = '2098-01-02' AND stock_daily_snapshots.product_id = fixture_product_id;
    ASSERT snapshot.variance_main = 0 AND snapshot.variance_floor = 0,
      'FO return must increase main and decrease floor without phantom variance: ' || return_type;
    ASSERT snapshot.transferred_floor_to_main = 3, 'Return display magnitude must remain positive';
    ASSERT (snapshot.floor_breakdown->0->>'opening')::int = 10, 'Floor opening must reverse the return movement';
    DELETE FROM public.stock_daily_snapshots WHERE business_date = '2098-01-01' AND stock_daily_snapshots.product_id = fixture_product_id;
    PERFORM public.compute_stock_snapshot('2098-01-02');
    SELECT * INTO snapshot FROM public.stock_daily_snapshots WHERE business_date = '2098-01-02' AND stock_daily_snapshots.product_id = fixture_product_id;
    ASSERT snapshot.opening_main = 10 AND snapshot.opening_floor = 10, 'First snapshot must infer the correct opening axes';
    RAISE NOTICE 'PASS %: previous-day variance, display, breakdown and first-snapshot opening', return_type;
  END LOOP;
  INSERT INTO public.products(name, category, stock_tracking_mode)
    VALUES ('Snapshot regression housekeeping', 'amenity', 'amenity_prepare') RETURNING id INTO fixture_product_id;
  INSERT INTO public.main_stock(product_id, quantity) VALUES (fixture_product_id, 10);
  INSERT INTO public.floor_stock(product_id, floor_number, quantity) VALUES (fixture_product_id, 1, 12);
  INSERT INTO public.stock_transactions_v2(transaction_date, product_id, action, quantity_change, reference_type, from_location, to_location, floor_number)
    VALUES ('2098-01-02', fixture_product_id, 'return', 2, 'housekeeping_return', 'room', 'floor_1', 1);
  PERFORM public.compute_stock_snapshot('2098-01-02');
  SELECT * INTO snapshot FROM public.stock_daily_snapshots WHERE business_date = '2098-01-02' AND stock_daily_snapshots.product_id = fixture_product_id;
  ASSERT snapshot.opening_main = 10 AND snapshot.opening_floor = 10, 'Housekeeping returns must continue increasing the floor';
  ASSERT snapshot.hk_returned_qty = 2 AND (snapshot.floor_breakdown->0->>'opening')::int = 10, 'Housekeeping magnitude and opening must be preserved';
  RAISE NOTICE 'PASS housekeeping return retains floor-increase behavior';
END;
$$;
ROLLBACK;
