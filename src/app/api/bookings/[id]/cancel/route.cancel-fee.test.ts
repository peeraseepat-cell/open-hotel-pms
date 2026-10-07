import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

type QueryResult = {
  data?: any;
  error: { message: string } | null;
  count?: number | null;
};

type Operation = {
  type: string;
  column?: string;
  value?: unknown;
  values?: unknown[];
};

let currentDb: SupabaseStub;

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const originalLoad = (Module as any)._load;
const stubs = new Map<string, unknown>([
  ["@supabase/supabase-js", { createClient: () => currentDb }],
  ["@/lib/supabase/server", { createServerSupabaseClient: () => currentDb }],
  ["@/lib/bookings", { mapBookingErrorToStatus: () => 400 }],
  [
    "@/lib/booking-group-status",
    {
      refreshBookingGroupTotalRooms: async () => null,
      syncBookingGroupStatusById: async () => null,
    },
  ],
  [
    "@/lib/folio-fees",
    {
      assertBusinessDayOpen: async () => undefined,
      normalizeOperatorPaymentMethod: (method: string) => method,
      resolveBusinessDate: async () => "2026-06-05",
      toLocalDate: () => "2026-06-05",
    },
  ],
  [
    "@/lib/google-sheet-sync",
    {
      loadReservationSheetSyncGroups: async () => [],
      pushToGoogleSheet: async () => undefined,
    },
  ],
  [
    "@/lib/settlement-preview",
    {
      computePrepaidNetAmount: () => 1000,
      suggestRefundMethod: () => "cash",
    },
  ],
  ["@/lib/hk-dirty", { markRoomDirtyTask: async () => undefined }],
  ["@/lib/alerts/lifecycle", { clearAlertsForInactiveReservations: async () => ({ cleared: 0 }) }],
]);

type ParentModule = { filename?: string } | null | undefined;

function getStub(request: string, parent?: ParentModule): unknown | null {
  if (stubs.has(request)) return stubs.get(request);
  let resolvedRequest = request;
  if (!path.isAbsolute(resolvedRequest) && parent?.filename) {
    try {
      resolvedRequest = originalResolveFilename.call(module, request, parent);
    } catch {
      resolvedRequest = request;
    }
  }
  const withoutExtension = resolvedRequest.replace(/\.(ts|tsx|js)$/, "");
  const srcRoot = path.join(process.cwd(), "src");
  if (!withoutExtension.startsWith(srcRoot)) return null;
  const aliasRequest = `@/${path.relative(srcRoot, withoutExtension)}`;
  return stubs.has(aliasRequest) ? stubs.get(aliasRequest) : null;
}

(Module as any)._load = function loadWithStubs(this: unknown, request: string, parent?: ParentModule, isMain?: boolean) {
  const stub = getStub(request, parent);
  if (stub !== null) return stub;
  return originalLoad.call(this, request, parent, isMain);
};

const { POST } = require("./route") as {
  POST: (request: { json: () => Promise<Record<string, unknown>> }, context: { params: { id: string } }) => Promise<Response>;
};

class QueryBuilder {
  private operations: Operation[] = [];
  private selectFields = "";
  private insertPayload: any = null;
  private updatePayload: any = null;

  constructor(private readonly db: SupabaseStub, private readonly table: string) {}

  select(fields: string) {
    this.selectFields = fields;
    return this;
  }

  eq(column: string, value: unknown) {
    this.operations.push({ type: "eq", column, value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.operations.push({ type: "gte", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.operations.push({ type: "in", column, values });
    return this;
  }

  not(column: string, value: string, operand: unknown) {
    this.operations.push({ type: "not", column, value, values: [operand] });
    return this;
  }

  limit(_count: number) {
    return this;
  }

  order(_column: string, _options?: Record<string, unknown>) {
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

  maybeSingle(): QueryResult {
    return this.resolve();
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private hasEq(column: string, value: unknown): boolean {
    return this.operations.some((op) => op.type === "eq" && op.column === column && op.value === value);
  }

  private resolve(): QueryResult {
    if (this.insertPayload) {
      this.db.inserts.push({ table: this.table, payload: this.insertPayload });
      return { data: null, error: null };
    }
    if (this.updatePayload) {
      return { data: null, error: null };
    }
    if (this.table === "reservations" && this.selectFields.includes("checked_in_at")) {
      return {
        data: {
          id: "res-1",
          booking_code: "B001",
          booking_group_id: null,
          parent_reservation_id: null,
          checked_in_at: null,
        },
        error: null,
      };
    }
    if (this.table === "reservations") return { data: [], error: null };
    if (this.table === "folio_payments" && this.hasEq("fee_template_code", "CANCEL_FEE")) {
      return { data: [{ id: "existing-cancel-fee" }], error: null };
    }
    if (this.table === "folio_payments") {
      return {
        data: [{ amount: 1000, tx_type: "payment", revenue_category: "room_revenue", method: "cash", is_record_only: false }],
        error: null,
      };
    }
    if (this.table === "audit_logs") return { data: null, error: null };
    if (this.table === "reservation_room_plans") return { data: [], error: null };
    if (this.table === "hotel_settings") return { data: { business_date: "2026-06-05" }, error: null };
    if (this.table === "daily_snapshots") return { data: null, error: null };
    if (this.table === "alert_daily_state" || this.table === "booking_alarms") return { data: [], error: null };
    throw new Error(`Unhandled table ${this.table}`);
  }
}

class SupabaseStub {
  readonly inserts: Array<{ table: string; payload: any }> = [];

  from(table: string) {
    return new QueryBuilder(this, table);
  }

  async rpc(_name: string, _payload: Record<string, unknown>): Promise<QueryResult> {
    return { data: { id: "res-1" }, error: null };
  }
}

async function main() {
  const originalWarn = console.warn;
  console.warn = () => undefined;

  currentDb = new SupabaseStub();
  const response = await POST(
    {
      json: async () => ({
        fee_amount: 300,
        refund_method: "cash",
        cascade_linked: false,
      }),
    },
    { params: { id: "res-1" } }
  );
  if (response.status !== 200) {
    console.error(await response.clone().json().catch(() => ({ status: response.status })));
  }
  assert.equal(response.status, 200);

  const settlementRows = currentDb.inserts
    .filter((insert) => insert.table === "folio_payments")
    .flatMap((insert) => (Array.isArray(insert.payload) ? insert.payload : [insert.payload]));
  assert.equal(
    settlementRows.some((row) => row.fee_template_code === "CANCEL_FEE" && row.is_record_only === true),
    false
  );
  assert.ok(settlementRows.some((row) => row.tx_type === "refund" && row.amount === 700));

  console.warn = originalWarn;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
