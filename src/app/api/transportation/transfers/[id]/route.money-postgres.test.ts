import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the existing handler against an explicitly supplied disposable local database.
// No service keys or external database endpoints are needed by these fixtures.
const container = process.env.TRANSFER_TEST_DB_CONTAINER;
if (!container) throw new Error("TRANSFER_TEST_DB_CONTAINER must name the disposable local test database");
function sql(statement: string): any[] {
  const result = spawnSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-q"],
    { input: statement, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "SQL failed");
  const output = result.stdout.trim();
  return output ? JSON.parse(output) : [];
}
function literal(value: any): string {
  if (value == null) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "'" + String(typeof value === "object" ? JSON.stringify(value) : value).replaceAll("'", "''") + "'";
}
function identifier(value: string) { return '"' + value.replaceAll('"', '""') + '"'; }
function rows(statement: string) { return sql(`SELECT coalesce(json_agg(result), '[]'::json) FROM (${statement}) result;`); }
type Result = { data: any; error: { message: string } | null };
let db: Database;
class Query {
  filters: string[] = [];
  fields = "*";
  sort = "";
  cap = "";
  operation = "select";
  payload: any;
  constructor(readonly database: Database, readonly table: string) {}
  select(fields = "*") { this.fields = fields; return this; }
  update(payload: any) { this.operation = "update"; this.payload = payload; return this; }
  insert(payload: any) { this.operation = "insert"; this.payload = payload; return this; }
  delete() { this.operation = "delete"; return this; }
  in(key: string, values: any[]) { this.filters.push(`${identifier(key)} IN (${values.map(literal).join(", ")})`); return this; }
  not(key: string, operator: string, values: string) {
    assert.equal(operator, "in");
    this.filters.push(`${identifier(key)} NOT IN (${values.slice(1, -1).split(",").map(literal).join(", ")})`);
    return this;
  }
  eq(key: string, value: any) { this.filters.push(`${identifier(key)} = ${literal(value)}`); return this; }
  neq(key: string, value: any) { this.filters.push(`${identifier(key)} <> ${literal(value)}`); return this; }
  gte(key: string, value: any) { this.filters.push(`${identifier(key)} >= ${literal(value)}`); return this; }
  ilike(key: string, value: any) { this.filters.push(`${identifier(key)} ILIKE ${literal(value)}`); return this; }
  order(key: string, opts: any = {}) { this.sort = ` ORDER BY ${identifier(key)} ${opts.ascending === false ? "DESC" : "ASC"}`; return this; }
  limit(count: number) { this.cap = ` LIMIT ${count}`; return this; }
  maybeSingle() { return Promise.resolve(this.resolve(true)); }
  then(resolve: (result: Result) => unknown, reject: (error: unknown) => unknown) {
    return Promise.resolve(this.resolve(false)).then(resolve, reject);
  }
  resolve(single: boolean): Result {
    try {
      let result: any[];
      const table = `public.${identifier(this.table)}`;
      const where = this.filters.length ? ` WHERE ${this.filters.join(" AND ")}` : "";
      if (this.operation === "update") {
        const values = Object.entries(this.payload).map(([key, value]) => `${identifier(key)} = ${literal(value)}`).join(", ");
        result = sql(`WITH changed AS (UPDATE ${table} SET ${values}${where} RETURNING *) SELECT coalesce(json_agg(changed), '[]'::json) FROM changed;`);
      } else if (this.operation === "insert") {
        const keys = Object.keys(this.payload);
        result = sql(`WITH changed AS (INSERT INTO ${table} (${keys.map(identifier).join(", ")}) VALUES (${keys.map(key => literal(this.payload[key])).join(", ")}) RETURNING *) SELECT coalesce(json_agg(changed), '[]'::json) FROM changed;`);
      } else if (this.operation === "delete") {
        result = sql(`WITH changed AS (DELETE FROM ${table}${where} RETURNING *) SELECT coalesce(json_agg(changed), '[]'::json) FROM changed;`);
      } else {
        result = rows(`SELECT ${this.fields} FROM ${table}${where}${this.sort}${this.cap}`);
        if (this.table === "transfers" && this.database.afterRead) {
          const inject = this.database.afterRead;
          this.database.afterRead = null;
          inject();
        }
      }
      return { data: single ? result[0] ?? null : result, error: null };
    } catch (error) {
      return { data: null, error: { message: String(error instanceof Error ? error.message : error) } };
    }
  }
}
class Database {
  afterRead: (() => void) | null = null;
  from(table: string) { return new Query(this, table); }
  async rpc(name: string, args: any): Promise<Result> {
    try {
      assert.equal(name, "transfer_write_atomic");
      const result = rows(`SELECT public.transfer_write_atomic(${literal(args.p_transfer_id)}::uuid, ${literal(args.p_patch)}::jsonb, ${literal(args.p_cancel_reason)}, ${literal(args.p_cancel_voucher_number)}) AS payload`);
      return { data: result[0].payload, error: null };
    } catch (error) {
      return { data: null, error: { message: String(error instanceof Error ? error.message : error) } };
    }
  }
}
const require = createRequire(import.meta.url);
const loader = Module as any;
const originalResolve = loader._resolveFilename;
const originalLoad = loader._load;
loader._resolveFilename = function(request: string, ...rest: unknown[]) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, ...rest);
};
loader._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/supabase/server") return { createServerSupabaseClient: () => db };
  return originalLoad.call(this, request, parent, isMain);
};
const { PATCH } = require("./route.ts");
loader._load = originalLoad;

function fixture(options: { price?: number | null; paid?: boolean; ledger?: boolean } = {}) {
  db = new Database();
  const transferId = randomUUID(), reservationId = randomUUID();
  const price = options.price === undefined ? 500 : options.price;
  sql(`INSERT INTO public.reservations(id, booking_code, guest_name, checkin_date, checkout_date)
    VALUES (${literal(reservationId)}, ${literal("TEST-" + reservationId)}, 'Example Guest', '2099-01-01', '2099-01-02');
    INSERT INTO public.transfers(id, reservation_id, guest_name, transfer_type, service_mode, pickup_datetime,
      pickup_location, dropoff_location, selling_price, cost_price, driver_fee, driver_commission, net_commission, payment_status, payment_method, status)
    VALUES (${literal(transferId)}, ${literal(reservationId)}, 'Example Guest', 'airport_pickup', 'hotel_arrange', '2099-01-01T10:00:00Z',
      'Airport', 'Hotel', ${literal(price)}, 300, 20, 40, 180, ${literal(options.paid ? "paid_to_hotel" : "unpaid")}, ${literal(options.paid ? "cash" : null)}, 'confirmed');`);
  if (options.ledger !== false) sql(`INSERT INTO public.commission_ledger(transfer_id, reservation_id, staff_name, commission_amount)
    VALUES (${literal(transferId)}, ${literal(reservationId)}, 'Example Staff', 180);`);
  if (options.paid) sql(`INSERT INTO public.transfer_transactions(transfer_id, reservation_id, tx_type, amount, selling_price, cost_price, margin, payment_method)
    VALUES (${literal(transferId)}, ${literal(reservationId)}, 'charge', 500, 500, 300, 200, 'cash');`);
  return {
    transferId,
    patch: (body: any) => PATCH({ json: async () => body }, { params: { id: transferId } }),
    transfer: () => rows(`SELECT * FROM public.transfers WHERE id = ${literal(transferId)}`)[0],
    ledger: () => rows(`SELECT * FROM public.commission_ledger WHERE transfer_id = ${literal(transferId)}`),
    totals: () => rows(`SELECT coalesce(sum((CASE WHEN tx_type = 'refund' THEN -1 ELSE 1 END) * coalesce(selling_price, amount)), 0) AS selling,
      coalesce(sum((CASE WHEN tx_type = 'refund' THEN -1 ELSE 1 END) * coalesce(cost_price, 0)), 0) AS cost FROM public.transfer_transactions WHERE transfer_id = ${literal(transferId)}`)[0],
    cleanup: () => sql(`DELETE FROM public.audit_logs WHERE entity_id = ${literal(transferId)};
      DELETE FROM public.transfers WHERE id = ${literal(transferId)};
      DELETE FROM public.reservations WHERE id = ${literal(reservationId)};`),
  };
}
test("price edits persist the new commission amount without losing its status", async () => {
  const f = fixture();
  try {
    assert.equal((await f.patch({ selling_price: 600 })).status, 200);
    assert.equal(Number(f.ledger()[0].commission_amount), 280);
    assert.equal(f.ledger()[0].status, "pending");
  } finally { f.cleanup(); }
});
test("pricing a previously unpriced transfer creates the missing commission record", async () => {
  const f = fixture({ price: null, ledger: false });
  try {
    assert.equal((await f.patch({ selling_price: 500 })).status, 200);
    assert.equal(f.ledger().length, 1);
    assert.equal(Number(f.ledger()[0].commission_amount), 180);
  } finally { f.cleanup(); }
});
test("selling-only edits derive the pool from the latest committed cost", async () => {
  const f = fixture();
  try {
    db.afterRead = () => sql(`UPDATE public.transfers SET cost_price = 400 WHERE id = ${literal(f.transferId)};`);
    assert.equal((await f.patch({ selling_price: 600 })).status, 200);
    assert.equal(Number(f.transfer().net_commission), 180);
    assert.equal(Number(f.ledger()[0].commission_amount), 180);
  } finally { f.cleanup(); }
});
test("a stale null-method patch cannot erase the method of a newly paid transfer", async () => {
  const f = fixture();
  try {
    db.afterRead = () => sql(`UPDATE public.transfers SET payment_status = 'paid_to_hotel', payment_method = 'cash' WHERE id = ${literal(f.transferId)};`);
    assert.equal((await f.patch({ payment_method: null })).status, 400);
    assert.equal(f.transfer().payment_method, "cash");
  } finally { f.cleanup(); }
});
test("cost-only edits append the missing cost delta without changing cash collected", async () => {
  const f = fixture({ paid: true });
  try {
    assert.equal((await f.patch({ cost_price: 320 })).status, 200);
    assert.equal(Number(f.totals().selling), 500);
    assert.equal(Number(f.totals().cost), 320);
    const tx = rows(`SELECT * FROM public.transfer_transactions WHERE transfer_id = ${literal(f.transferId)} AND tx_type = 'adjustment'`);
    assert.equal(tx.length, 1);
    assert.equal(Number(tx[0].amount), 0);
    assert.equal(Number(tx[0].margin), -20);
  } finally { f.cleanup(); }
});
test("failed refund insertion rolls the cancellation back with its financial records", async () => {
  const f = fixture({ paid: true });
  const trigger = "test_transfer_refund_" + f.transferId.replaceAll("-", "");
  try {
    sql(`CREATE FUNCTION public.${identifier(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.transfer_id = '${f.transferId}'::uuid AND NEW.tx_type = 'refund' THEN RAISE EXCEPTION 'synthetic refund failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${identifier(trigger)} BEFORE INSERT ON public.transfer_transactions FOR EACH ROW EXECUTE FUNCTION public.${identifier(trigger)}();`);
    assert.equal((await f.patch({ status: "cancelled", cancel_reason: "Example cancellation" })).status, 500);
    assert.equal(f.transfer().status, "confirmed");
    assert.equal(f.ledger()[0].status, "pending");
    assert.equal(Number(f.totals().selling), 500);
  } finally {
    sql(`DROP TRIGGER IF EXISTS ${identifier(trigger)} ON public.transfer_transactions; DROP FUNCTION IF EXISTS public.${identifier(trigger)}();`);
    f.cleanup();
  }
});

test("cancelling a loss-making transfer reverses its full recorded cost", async () => {
  const f = fixture({paid:true});
  try {
    assert.equal((await f.patch({cost_price:700})).status,200);
    assert.equal(Number(f.totals().cost),700);
    assert.equal((await f.patch({status:"cancelled",cancel_reason:"Example cancellation"})).status,200);
    assert.equal(Number(f.totals().selling),0);
    assert.equal(Number(f.totals().cost),0,"cancellation must reverse cost exceeding collected selling price");
  } finally {f.cleanup();}
});
test("recording a previously unknown cost reconciles the persisted margin",async()=>{
  const f=fixture({paid:true});
  try {
    sql(`UPDATE public.transfers SET cost_price=NULL WHERE id=${literal(f.transferId)};
      UPDATE public.transfer_transactions SET cost_price=NULL,margin=0 WHERE transfer_id=${literal(f.transferId)};`);
    assert.equal((await f.patch({cost_price:300})).status,200);
    assert.equal(Number(f.totals().selling),500);
    assert.equal(Number(f.totals().cost),300);
    const totals=rows(`SELECT sum((CASE WHEN tx_type='refund' THEN -1 ELSE 1 END)*coalesce(margin,0)) AS margin FROM public.transfer_transactions WHERE transfer_id=${literal(f.transferId)}`)[0];
    assert.equal(Number(totals.margin),200,"known cost must replace the break-even unknown-cost margin without rewriting history");
  }finally{f.cleanup();}
});
