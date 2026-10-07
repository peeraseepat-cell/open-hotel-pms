BEGIN;
DO $$
DECLARE
  reservation_id uuid;
  fixture_transfer_id uuid;
  result jsonb;
  pool numeric;
  commission numeric;
BEGIN
  INSERT INTO public.reservations(booking_code, guest_name, checkin_date, checkout_date)
    VALUES ('TEST-POOL-' || gen_random_uuid()::text, 'Example Guest', '2099-01-01', '2099-01-02') RETURNING id INTO reservation_id;
  result := public.transfer_create_booking(
    p_reservation_id => reservation_id,
    p_transfer_type => 'airport_pickup',
    p_service_mode => 'hotel_arrange',
    p_pickup_datetime => '2099-01-01T10:00:00Z',
    p_pickup_location => 'Airport',
    p_dropoff_location => 'Hotel',
    p_selling_price => 500,
    p_cost_price => 300,
    p_driver_fee => 20,
    p_driver_commission => 40
  );
  fixture_transfer_id := (result->>'transfer_id')::uuid;
  SELECT net_commission INTO pool FROM public.transfers WHERE id = fixture_transfer_id;
  SELECT commission_amount INTO commission FROM public.commission_ledger ledger WHERE ledger.transfer_id = fixture_transfer_id;
  ASSERT pool = 180, 'Booking RPC must exclude driver_commission from the pool';
  ASSERT commission = 180, 'Booking RPC must store the same pool in commission_ledger';
  RAISE NOTICE 'PASS booking RPC pool and commission ledger agree';
END;
$$;
ROLLBACK;
