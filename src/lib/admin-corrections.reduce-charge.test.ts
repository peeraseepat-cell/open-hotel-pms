import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const { AdminCorrectionError, postAdjustment } = require("./admin-corrections") as typeof import("./admin-corrections");

type QueryResult = { data: any; error: { message: string } | null };

class QueryBuilder {
  private filters = new Map<string, unknown>();
  private insertPayload: any = null;
  private selectFields = "";

  constructor(private readonly db: SupabaseStub, private readonly table: string) {}

  select(fields: string) {
    this.selectFields = fields;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.set(column, value);
    return this;
  }

  insert(payload: any) {
    this.insertPayload = payload;
    return this;
  }

  single(): QueryResult {
    return this.resolve();
  }

  maybeSingle(): QueryResult {
    return this.resolve();
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private resolve(): QueryResult {
    if (this.table === "reservations") {
      return { data: this.db.reservation, error: null };
    }
    if (this.table === "hotel_settings") {
      return { data: { business_date: "2026-06-06" }, error: null };
    }
    if (this.table === "folio_payments") {
      if (this.insertPayload) {
        this.db.insertedPayments.push(this.insertPayload);
        return { data: { id: "adjustment-row" }, error: null };
      }
      const paymentId = String(this.filters.get("id") ?? "");
      return { data: this.db.originalPayments[paymentId] ?? null, error: null };
    }
    if (this.table === "admin_corrections") {
      this.db.insertedCorrections.push(this.insertPayload);
      return { data: { id: "correction-row" }, error: null };
    }
    if (this.table === "audit_logs") {
      this.db.insertedAuditLogs.push(this.insertPayload);
      return { data: null, error: null };
    }
    throw new Error(`Unhandled table ${this.table} for select ${this.selectFields}`);
  }
}

class SupabaseStub {
  readonly insertedPayments: any[] = [];
  readonly insertedCorrections: any[] = [];
  readonly insertedAuditLogs: any[] = [];
  readonly reservation = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "active",
    folio_reopened: false,
  };
  readonly originalPayments: Record<string, any>;

  constructor(originalPayment: any) {
    this.originalPayments = originalPayment ? { [originalPayment.id]: originalPayment } : {};
  }

  from(table: string) {
    return new QueryBuilder(this, table);
  }
}

const reservationId = "11111111-1111-4111-8111-111111111111";
const originalPaymentId = "22222222-2222-4222-8222-222222222222";

function originalCharge(isRecordOnly: boolean) {
  return {
    id: originalPaymentId,
    reservation_id: reservationId,
    tx_type: "payment",
    method: "cash",
    amount: 500,
    revenue_category: "extra_charge",
    note: null,
    paid_date: "2026-06-06",
    paid_at: "2026-06-06T00:00:00.000Z",
    recorded_by: "cashier",
    is_record_only: isRecordOnly,
    is_void_reversal: false,
    void_of: null,
    is_correction: false,
    correction_ref: null,
    correction_reason: null,
  };
}

async function postReduceCharge(db: SupabaseStub) {
  return postAdjustment(db as any, "admin-user", {
    reservationId,
    direction: "reduce_charge",
    amount: 500,
    method: "cash",
    originalPaymentId,
    reason: "test reduce charge",
  });
}

async function main() {
  const paidChargeDb = new SupabaseStub(originalCharge(false));
  await postReduceCharge(paidChargeDb);
  assert.equal(paidChargeDb.insertedPayments[0]?.is_record_only, false);

  const onAccountChargeDb = new SupabaseStub(originalCharge(true));
  await postReduceCharge(onAccountChargeDb);
  assert.equal(onAccountChargeDb.insertedPayments[0]?.is_record_only, true);

  await assert.rejects(
    postAdjustment(new SupabaseStub(originalCharge(false)) as any, "admin-user", {
      reservationId,
      direction: "reduce_charge",
      amount: 500,
      method: "cash",
      originalPaymentId: null,
      reason: "test reduce charge",
    }),
    (error) => error instanceof AdminCorrectionError && /requires selecting the charge being reduced/.test(error.message)
  );

  await assert.rejects(
    postReduceCharge(new SupabaseStub({
      ...originalCharge(false),
      tx_type: "refund",
      revenue_category: "room_revenue",
    })),
    (error) => error instanceof AdminCorrectionError && /requires selecting an extra charge row/.test(error.message)
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
