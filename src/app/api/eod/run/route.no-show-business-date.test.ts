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
  [
    "@/lib/night-audit",
    {
      getNightAuditSpilloverScope: async () => ({ includeOpenBusinessSpillover: false, calendarDate: "2026-06-07" }),
      listPendingNoShows: async () => [],
      normalizePendingGroupCheckinWizardDrafts: async () => ({ pendingCount: 0, healedCount: 0 }),
    },
  ],
  [
    "@/app/api/reports/payment-daily/route",
    {
      createNightAuditPaymentDailyRequest: (businessDate: string) => ({ businessDate }),
      GET: async () => ({
        status: 200,
        json: async () => ({
          success: true,
          grand_total: {
            cash: { payment: 0, deposit: 0 },
            transfer: { payment: 0, deposit: 0 },
            credit_card: { payment: 0, deposit: 0 },
            other: { payment: 0, deposit: 0 },
          },
          deposit_refunds: [],
          pos: {
            cash: { payment: 0, refund: 0 },
            transfer: { payment: 0, refund: 0 },
            credit_card: { payment: 0, refund: 0 },
            other: { payment: 0, refund: 0 },
          },
        }),
      }),
    },
  ],
  ["@/lib/stock-snapshot", { computeStockSnapshot: async () => null }],
  ["@/lib/linen/daily-snapshot", { computeLinenDailySnapshot: async () => null }],
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
  POST: (request: { json: () => Promise<Record<string, unknown>> }) => Promise<Response>;
};

class QueryBuilder {
  private operations: Operation[] = [];
  private mutation: "upsert" | "update" | null = null;

  constructor(private readonly db: SupabaseStub, private readonly table: string) {}

  select(_fields: string, _options?: Record<string, unknown>) {
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

  single(): QueryResult {
    return this.resolve();
  }

  upsert(_payload: any, _options?: Record<string, unknown>) {
    this.mutation = "upsert";
    return this;
  }

  update(_payload: any) {
    this.mutation = "update";
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private resolve(): QueryResult {
    this.db.queries.push({ table: this.table, operations: this.operations });
    if (this.mutation) return { data: null, error: null };
    if (this.table === "hotel_settings") {
      return {
        data: { business_date: "2026-06-05", hotel_timezone: "Asia/Bangkok", sellable_rooms: 10 },
        error: null,
      };
    }
    if (this.table === "rooms") return { data: [], error: null, count: 0 };
    if (this.table === "reservations") return { data: [], error: null, count: 0 };
    if (this.table === "reservation_nights") return { data: [], error: null };
    if (this.table === "transfer_transactions") return { data: [], error: null };
    if (this.table === "tip_ledger") return { data: [], error: null };
    if (this.table === "commission_ledger") return { data: [], error: null };
    if (this.table === "audit_logs") return { data: [], error: null };
    if (this.table === "folio_payments") return { data: [], error: null };
    if (this.table === "pos_orders") return { data: [], error: null };
    if (this.table === "daily_snapshots") return { data: null, error: null };
    if (this.table === "group_checkin_wizard_drafts") return { data: [], error: null };
    return { data: [], error: null, count: 0 };
  }
}

class SupabaseStub {
  readonly queries: Array<{ table: string; operations: Operation[] }> = [];

  from(table: string) {
    return new QueryBuilder(this, table);
  }

  async rpc(_name: string, _payload: Record<string, unknown>): Promise<QueryResult> {
    return { data: null, error: null };
  }
}

async function main() {
  const originalError = console.error;
  console.error = () => undefined;

  currentDb = new SupabaseStub();
  const response = await POST({ json: async () => ({ force: true }) });
  if (response.status !== 200) {
    console.error(await response.clone().json().catch(() => ({ status: response.status })));
  }
  assert.equal(response.status, 200);

  const noShowAuditQuery = currentDb.queries.find(
    (query) =>
      query.table === "audit_logs" &&
      query.operations.some((op) => op.type === "eq" && op.column === "action" && op.value === "no_show")
  );
  assert.ok(noShowAuditQuery, "EOD should query no-show audit logs");
  assert.ok(
    noShowAuditQuery.operations.some(
      (op) => op.type === "eq" && op.column === "business_date" && op.value === "2026-06-05"
    ),
    "no-show audit lookup should use audit_logs.business_date"
  );
  assert.equal(noShowAuditQuery.operations.some((op) => op.column === "created_at"), false);

  console.error = originalError;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
