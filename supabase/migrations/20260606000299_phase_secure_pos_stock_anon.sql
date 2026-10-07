-- Remove anonymous POS/stock table and RPC access.
-- Part B/C comes first so table policy/grant tightening commits even if a
-- later RPC signature drift blocks the execute-grant transaction.

BEGIN;

DROP POLICY IF EXISTS products_allow_all ON public.products;
CREATE POLICY products_allow_all
  ON public.products
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS main_stock_allow_all ON public.main_stock;
CREATE POLICY main_stock_allow_all
  ON public.main_stock
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS floor_stock_allow_all ON public.floor_stock;
CREATE POLICY floor_stock_allow_all
  ON public.floor_stock
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS stock_transactions_v2_allow_all ON public.stock_transactions_v2;
CREATE POLICY stock_transactions_v2_allow_all
  ON public.stock_transactions_v2
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS pos_orders_allow_all ON public.pos_orders;
CREATE POLICY pos_orders_allow_all
  ON public.pos_orders
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS pos_order_items_allow_all ON public.pos_order_items;
CREATE POLICY pos_order_items_allow_all
  ON public.pos_order_items
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.fo_prepare_batches, public.fo_prepare_batch_items FROM anon;
REVOKE ALL ON TABLE
  public.stock_daily_snapshots,
  public.fo_amenity_audit_sessions,
  public.fo_amenity_audit_items
FROM anon;

COMMIT;

BEGIN;

REVOKE EXECUTE ON FUNCTION public.pos_create_order(text, jsonb, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_create_order(text, jsonb, text, uuid, text, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.pos_void_order(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_void_order(uuid, text, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.hk_deduct_floor_stock(uuid, text, int, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hk_deduct_floor_stock(uuid, text, int, text, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.generate_pos_order_number()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_pos_order_number()
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.hk_return_floor_stock(uuid, uuid, uuid, text, int, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hk_return_floor_stock(uuid, uuid, uuid, text, int, text, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.compute_stock_snapshot(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_stock_snapshot(date)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.acknowledge_stock_reconcile_section(date, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_stock_reconcile_section(date, text, jsonb)
  TO service_role;

COMMIT;
