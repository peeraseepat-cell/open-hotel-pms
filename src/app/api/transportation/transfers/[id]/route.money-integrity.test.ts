import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

// Exercise the real handlers with only their database boundary substituted.
// Transaction arithmetic and rollback are covered separately against PostgreSQL.
const require = createRequire(import.meta.url);
const loader = Module as any;
const originalResolve = loader._resolveFilename;
const originalLoad = loader._load;
let db: Database;
loader._resolveFilename = function(request: string, ...rest: unknown[]) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, ...rest);
};
loader._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/supabase/server") return { createServerSupabaseClient: () => db };
  return originalLoad.call(this, request, parent, isMain);
};
const { PATCH } = require("./route.ts");
const { POST } = require("../route.ts");
loader._load = originalLoad;

const transferId = "67b8dd11-e506-41c9-8af2-283e1309d118";
const reservationId = "d9a4189b-a52d-4770-b075-abba659fe9a2";
type Result = { data: any; error: { message: string; code?: string } | null };

class Query {
  fields = "";
  payload: any;
  operation = "select";
  constructor(readonly database: Database, readonly table: string) {}
  select(fields = "") { this.fields = fields; return this; }
  update(payload: any) { this.operation = "update"; this.payload = payload; return this; }
  insert(payload: any) { this.operation = "insert"; this.payload = payload; return this; }
  eq() { return this; } neq() { return this; } gte() { return this; }
  lte() { return this; } lt() { return this; } in() { return this; }
  is() { return this; } not() { return this; } order() { return this; }
  limit() { return this; } ilike() { return this; }
  maybeSingle() { return Promise.resolve(this.resolve()); }
  single() { return Promise.resolve(this.resolve()); }
  then(resolve: (result: Result) => unknown, reject: (error: unknown) => unknown) {
    return Promise.resolve(this.resolve()).then(resolve, reject);
  }
  resolve(): Result {
    if (this.operation !== "select") {
      this.database.writes.push({ table: this.table, operation: this.operation, payload: this.payload });
      if (this.table === "transfers") {
        this.database.transfer = { ...this.database.transfer, ...this.payload };
        return { data: this.fields === "id" ? { id: transferId } : this.database.transfer, error: null };
      }
      return { data: null, error: null };
    }
    const rows: Record<string, any> = {
      transfers: this.fields === "*" ? this.database.transfer : [],
      reservations: { id: reservationId, status: "active", guest_name: "Example Guest", phone: null, guest_profile_id: null },
      daily_snapshots: null,
      transfer_transactions: [],
      commission_ledger: [],
      transfer_vouchers: { voucher_number: "TRANSFER-EXAMPLE" },
      reservation_alerts: null,
      reservation_nights: [],
      reservation_traces: null,
    };
    assert.ok(this.table in rows, `unexpected test query: ${this.table}`);
    return { data: rows[this.table], error: null };
  }
}
class Database {
  transfer: Record<string, any> = {
    id: transferId, reservation_id: reservationId, guest_name: "Example Guest",
    transfer_type: "airport_pickup", pickup_datetime: "2099-01-01T10:00:00.000Z",
    status: "confirmed", selling_price: 500, cost_price: 300, driver_fee: 20,
    driver_commission: 40, net_commission: 220, payment_status: "unpaid", payment_method: null,
    driver_id: null, vehicle_id: null, staff_note: null, guest_note: null,
  };
  writes: Array<{ table: string; operation: string; payload: any }> = [];
  calls: Array<{ name: string; args: any }> = [];
  invalid = false;
  fail = false;
  from(table: string) { return new Query(this, table); }
  async rpc(name: string, args: any): Promise<Result> {
    this.calls.push({ name, args });
    if (name === "transfer_create_booking") return { data: null, error: { code: "42883", message: "fallback fixture" } };
    if (name === "generate_transfer_voucher_number") return { data: "TRANSFER-EXAMPLE", error: null };
    if (name === "transfer_write_atomic") {
      if (this.fail) return { data: null, error: { message: "transaction rejected" } };
      if (this.invalid) return { data: { found: true, invalid: "payment_method_required" }, error: null };
      return { data: { found: true, transfer: { ...this.transfer, ...args.p_patch } }, error: null };
    }
    throw new Error(`unexpected test RPC: ${name}`);
  }
}
function setup() { db = new Database(); }
function patch(body: Record<string, unknown>) {
  return PATCH({ json: async () => body }, { params: { id: transferId } });
}
function create() {
  return POST({ json: async () => ({
    reservation_id: reservationId, transfer_type: "airport_pickup", service_mode: "hotel_arrange",
    pickup_datetime: "2099-01-01T10:00:00.000Z", pickup_location: "Airport", dropoff_location: "Hotel",
    selling_price: 500, cost_price: 300, driver_fee: 20, driver_commission: 40,
  }) });
}
test("fallback creation excludes driver commission from the recorded pool", async () => {
  setup();
  assert.equal((await create()).status, 201);
  assert.equal(db.writes.find(row => row.table === "transfers")?.payload.net_commission, 180);
});
test("fallback creation records the pool in the commission ledger", async () => {
  setup();
  assert.equal((await create()).status, 201);
  const ledger = db.writes.find(row => row.table === "commission_ledger")?.payload;
  assert.equal(ledger.commission_amount, 180);
  assert.equal(ledger.rule_value, 36);
});
for (const [key, value] of Object.entries({ selling_price: 600, cost_price: 320, driver_fee: 10,
  driver_commission: 45, payment_status: "paid_to_driver", payment_method: "cash" })) {
  test(`${key} alone reaches the locked transaction with the original patch`, async () => {
    setup();
    assert.equal((await patch({ [key]: value })).status, 200);
    const call = db.calls.find(row => row.name === "transfer_write_atomic");
    assert.ok(call, `${key} must not be updated outside the transaction`);
    assert.equal(call.args.p_patch[key], value);
    assert.equal(call.args.p_patch.net_commission, undefined);
    assert.equal(db.writes.filter(row => row.table === "transfers").length, 0);
  });
}
test("locked payment-method rejection reaches the caller as a validation error", async () => {
  setup(); db.invalid = true;
  const response = await patch({ payment_method: null });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "payment_method is required when payment_status is paid_to_hotel.");
});
test("transaction failure leaves no separate transfer write", async () => {
  setup(); db.fail = true;
  const response = await patch({ selling_price: 600 });
  assert.equal(response.status, 500);
  assert.equal(db.writes.filter(row => row.table === "transfers").length, 0);
});
test("nonfinancial note edits retain the existing simple update path", async () => {
  setup();
  assert.equal((await patch({ guest_note: "Revised arrival details" })).status, 200);
  assert.equal(db.calls.length, 0);
  assert.equal(db.writes.find(row => row.table === "transfers")?.payload.guest_note, "Revised arrival details");
});
