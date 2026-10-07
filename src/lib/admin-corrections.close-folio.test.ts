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

const { closeFolio } = require("./admin-corrections") as typeof import("./admin-corrections");

type QueryResult = { data: any; error: { message: string } | null };

class QueryBuilder {
  private filters = new Map<string, unknown>();
  private insertPayload: any = null;
  private updatePayload: any = null;

  constructor(private readonly db: SupabaseStub, private readonly table: string) {}

  select(_fields: string) {
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

  update(payload: any) {
    this.updatePayload = payload;
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
      if (this.updatePayload) {
        this.db.reservationUpdates.push(this.updatePayload);
        return { data: null, error: null };
      }
      return { data: this.db.reservation, error: null };
    }
    if (this.table === "folio_payments") {
      return { data: this.db.payments, error: null };
    }
    if (this.table === "hotel_settings") {
      return { data: { business_date: "2026-06-06" }, error: null };
    }
    if (this.table === "admin_corrections") {
      this.db.insertedCorrections.push(this.insertPayload);
      return { data: { id: "correction-row" }, error: null };
    }
    if (this.table === "audit_logs") {
      this.db.insertedAuditLogs.push(this.insertPayload);
      return { data: null, error: null };
    }
    throw new Error(`Unhandled table ${this.table}`);
  }
}

class SupabaseStub {
  readonly reservationUpdates: any[] = [];
  readonly insertedCorrections: any[] = [];
  readonly insertedAuditLogs: any[] = [];
  readonly reservation: any;
  readonly payments: any[];

  constructor(params: {
    discountType?: string | null;
    discountValue?: number | null;
    paidAmount: number;
    totalPrice?: number;
  }) {
    this.reservation = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "checked_out",
      folio_reopened: true,
      guest_name: "Regression Guest",
      total_price: params.totalPrice ?? 5000,
      discount_type: params.discountType ?? null,
      discount_value: params.discountValue ?? null,
      discount_percent: null,
      checkin_date: "2026-06-01",
      checkout_date: "2026-06-03",
    };
    this.payments = [
      {
        tx_type: "payment",
        amount: params.paidAmount,
        revenue_category: "room_revenue",
        note: null,
        is_record_only: false,
      },
    ];
  }

  from(table: string) {
    return new QueryBuilder(this, table);
  }
}

async function closeWith(db: SupabaseStub) {
  return closeFolio(db as any, "admin-user", db.reservation.id, "test close folio");
}

async function main() {
  const discountedPaidTotal = new SupabaseStub({
    discountType: "percent",
    discountValue: 10,
    paidAmount: 4500,
  });
  await closeWith(discountedPaidTotal);
  assert.deepEqual(discountedPaidTotal.reservationUpdates, [{ folio_reopened: false }]);

  const undiscountedPaidTotal = new SupabaseStub({ paidAmount: 5000 });
  await closeWith(undiscountedPaidTotal);
  assert.deepEqual(undiscountedPaidTotal.reservationUpdates, [{ folio_reopened: false }]);

  await assert.rejects(
    closeWith(new SupabaseStub({ paidAmount: 4500 })),
    /outstanding balance is 500\.00/
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
