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
};

type RecordedWrite = {
  table: string;
  payload: any;
  operations: Operation[];
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
  ["@/lib/night-audit", { getNightAuditSettings: async () => ({ businessDate: "2026-06-05" }) }],
  ["@/lib/alerts/lifecycle", { clearAlertsForInactiveReservations: async () => ({ cleared: 0 }) }],
  ["@/lib/booking-group-status", { syncBookingGroupStatusById: async () => null }],
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
  POST: (_request: unknown, context: { params: { id: string } }) => Promise<Response>;
};

class QueryBuilder {
  private operations: Operation[] = [];
  private updatePayload: any = null;
  private insertPayload: any = null;

  constructor(private readonly db: SupabaseStub, private readonly table: string) {}

  select(_fields: string) {
    return this;
  }

  eq(column: string, value: unknown) {
    this.operations.push({ type: "eq", column, value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.operations.push({ type: "in", column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.operations.push({ type: "is", column, value });
    return this;
  }

  update(payload: any) {
    this.updatePayload = payload;
    return this;
  }

  insert(payload: any) {
    this.insertPayload = payload;
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

  private resolve(): QueryResult {
    if (this.updatePayload) {
      this.db.updates.push({ table: this.table, payload: this.updatePayload, operations: this.operations });
      return { data: null, error: null };
    }
    if (this.insertPayload) {
      this.db.inserts.push({ table: this.table, payload: this.insertPayload, operations: this.operations });
      return { data: null, error: null };
    }
    if (this.table === "reservations") {
      return { data: this.db.reservation, error: null };
    }
    if (this.table === "hotel_settings") {
      return { data: { business_date: "2026-06-05", hotel_timezone: "Asia/Bangkok", sellable_rooms: 10 }, error: null };
    }
    if (this.table === "alert_daily_state" || this.table === "booking_alarms") {
      return { data: [], error: null };
    }
    throw new Error(`Unhandled table ${this.table}`);
  }
}

class SupabaseStub {
  readonly updates: RecordedWrite[] = [];
  readonly inserts: RecordedWrite[] = [];
  readonly reservation: Record<string, unknown>;

  constructor(params: { checkedInAt?: string | null }) {
    this.reservation = {
      id: "res-1",
      booking_group_id: null,
      status: "active",
      guest_name: "No Show Guest",
      checkin_date: "2026-06-05",
      checked_in_at: params.checkedInAt ?? null,
    };
  }

  from(table: string) {
    return new QueryBuilder(this, table);
  }

  resetForReservation(checkedInAt: string | null) {
    this.updates.length = 0;
    this.inserts.length = 0;
    this.reservation.checked_in_at = checkedInAt;
  }
}

async function postNoShow(db: SupabaseStub) {
  currentDb = db;
  return POST({} as never, { params: { id: "res-1" } });
}

async function main() {
  const originalWarn = console.warn;
  console.warn = () => undefined;

  const db = new SupabaseStub({ checkedInAt: "2026-06-05T10:00:00.000Z" });
  const checkedInResponse = await postNoShow(db);
  assert.equal(checkedInResponse.status, 409);
  assert.equal(db.updates.length, 0);

  db.resetForReservation(null);
  const activeResponse = await postNoShow(db);
  assert.equal(activeResponse.status, 200);

  const nightCancellation = db.updates.find((write: RecordedWrite) => write.table === "reservation_nights");
  assert.ok(nightCancellation, "reservation_nights should be cancelled when marking no-show");
  assert.equal(typeof nightCancellation.payload.cancelled_at, "string");
  assert.ok(nightCancellation.operations.some((op: Operation) => op.type === "eq" && op.column === "reservation_id" && op.value === "res-1"));
  assert.ok(nightCancellation.operations.some((op: Operation) => op.type === "is" && op.column === "cancelled_at" && op.value === null));

  const auditInsert = db.inserts.find((write) => write.table === "audit_logs");
  assert.equal(auditInsert?.payload.business_date, "2026-06-05");

  console.warn = originalWarn;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
