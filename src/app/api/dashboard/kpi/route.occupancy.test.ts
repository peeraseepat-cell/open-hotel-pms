import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

type QueryResult = {
  data?: any;
  error: { message: string; code?: string } | null;
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
  [
    "@/lib/night-audit",
    {
      getNightAuditSettings: async () => ({
        businessDate: "2026-06-05",
        hotelTimezone: "Asia/Bangkok",
        sellableRooms: 10,
      }),
    },
  ],
  ["@/lib/server-auth", { requireStaffAuth: async () => ({ user: { id: "user-1" }, role: "admin", error: null }) }],
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

const { GET } = require("./route") as {
  GET: (request: unknown) => Promise<Response>;
};

class QueryBuilder {
  private operations: Operation[] = [];
  private selectFields = "";

  constructor(private readonly table: string) {}

  select(fields: string, _options?: Record<string, unknown>) {
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

  lte(column: string, value: unknown) {
    this.operations.push({ type: "lte", column, value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.operations.push({ type: "lt", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.operations.push({ type: "neq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.operations.push({ type: "in", column, values });
    return this;
  }

  is(column: string, value: unknown) {
    this.operations.push({ type: "is", column, value });
    return this;
  }

  order(_column: string, _options?: Record<string, unknown>) {
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

  private has(type: string, column: string, value?: unknown): boolean {
    return this.operations.some(
      (op) => op.type === type && op.column === column && (arguments.length < 3 || op.value === value)
    );
  }

  private resolve(): QueryResult {
    if (this.table === "hotel_settings") {
      return {
        data: { business_date: "2026-06-05", hotel_timezone: "Asia/Bangkok", sellable_rooms: 10 },
        error: null,
      };
    }
    if (this.table === "profiles") return { data: { role: "admin" }, error: null };
    if (this.table === "reservation_nights" && this.selectFields.includes("nightly_price")) {
      return {
        data: Array.from({ length: 6 }, () => ({
          nightly_price: 1000,
          reservations: { source: "walkin", status: "active", is_dayuse: false },
        })),
        error: null,
      };
    }
    if (this.table === "reservations" && this.has("lte", "checkin_date") && this.has("gte", "checkout_date")) {
      return { data: [], error: null, count: 2 };
    }
    if (this.table === "rooms") return { data: [], error: null, count: 0 };
    if (this.table === "reservations") return { data: [], error: null, count: 0 };
    if (this.table === "reservation_nights") return { data: [], error: null };
    if (this.table === "housekeeping_tasks") return { data: [], error: null, count: 0 };
    if (this.table === "folio_payments") return { data: [], error: null };
    if (this.table === "transfer_transactions") return { data: [], error: null };
    if (this.table === "tip_ledger") return { data: [], error: null };
    if (this.table === "pos_orders") return { data: [], error: null };
    if (this.table === "daily_snapshots") return { data: [], error: null };
    throw new Error(`Unhandled table ${this.table}`);
  }
}

class SupabaseStub {
  readonly auth = {
    getUser: async () => ({ data: { user: { id: "user-1", email: "admin@example.com" } }, error: null }),
  };

  from(table: string) {
    return new QueryBuilder(table);
  }
}

async function main() {
  currentDb = new SupabaseStub();
  const response = await GET({ headers: new Headers(), cookies: { getAll: () => [] } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.live.in_house, 2);
  assert.equal(payload.data.revenue.occupied_nights, 6);
  assert.equal(payload.data.live.occupancy_pct, 60);
  assert.equal(payload.data.trend[payload.data.trend.length - 1].occupancy_pct, 60);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
