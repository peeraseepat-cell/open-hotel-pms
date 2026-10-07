/**
 * CONSUMPTION SEAM for the room_stay_history cap fix.
 *
 * WHAT THIS PROVES: both routes actually READ room_stay_history through the paged reader —
 * i.e. the query they issue carries `.range()`, a stable `.order("id")` and `count:'exact'`.
 * The helper's own unit test (src/lib/room-stay-nights.test.mts) proves the reader is
 * correct; it stays green even if a route is reverted to a bare `.select("room_id")`. This
 * file is the test that goes red for that. (an earlier change was rejected for exactly this gap: proving a
 * value is derived without proving the control consumes it.)
 *
 * Run: npx tsx src/app/api/setup/rooms/route.stay-history-paging.test.ts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

type Operation = { type: string; column?: string; value?: unknown };

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

/** Ops recorded per table, reset between routes under test. */
let recorded: Map<string, Operation[]>;
let tableData: Record<string, unknown[]>;

function makeBuilder(table: string) {
    const ops: Operation[] = [];
    if (!recorded.has(table)) recorded.set(table, ops);
    let wantCount = false;
    let rangeFrom = 0;
    let rangeTo = Number.MAX_SAFE_INTEGER;

    const settle = () => {
        const all = tableData[table] ?? [];
        const slice = all.slice(rangeFrom, Math.min(rangeTo + 1, rangeFrom + 1000));
        return Promise.resolve({ data: slice, error: null, count: wantCount ? all.length : null });
    };

    const api: any = {
        select(_f?: string, options?: { count?: string }) {
            if (options?.count === "exact") { wantCount = true; ops.push({ type: "count", value: "exact" }); }
            return api;
        },
        order(column: string) { ops.push({ type: "order", column }); return api; },
        range(from: number, to: number) { rangeFrom = from; rangeTo = to; ops.push({ type: "range", value: `${from}-${to}` }); return settle(); },
        eq(column: string, value: unknown) { ops.push({ type: "eq", column, value }); return api; },
        gte(column: string, value: unknown) { ops.push({ type: "gte", column, value }); return api; },
        lte(column: string, value: unknown) { ops.push({ type: "lte", column, value }); return api; },
        lt(column: string, value: unknown) { ops.push({ type: "lt", column, value }); return api; },
        gt(column: string, value: unknown) { ops.push({ type: "gt", column, value }); return api; },
        is(column: string, value: unknown) { ops.push({ type: "is", column, value }); return api; },
        in(column: string, values: unknown[]) { ops.push({ type: "in", column, value: values }); return api; },
        not() { return api; },
        or(filter: string) { ops.push({ type: "or", value: filter }); return api; },
        match() { return api; },
        single() { return Promise.resolve({ data: (tableData[table] ?? [])[0] ?? null, error: null }); },
        maybeSingle() { return Promise.resolve({ data: (tableData[table] ?? [])[0] ?? null, error: null }); },
        upsert() { return Promise.resolve({ data: null, error: null }); },
        update() { return api; },
        insert() { return Promise.resolve({ data: null, error: null }); },
        delete() { return api; },
        then(onf: any, onr: any) { return settle().then(onf, onr); },
    };
    return api;
}

const supabaseStub = { from: (table: string) => makeBuilder(table) };

const stubs = new Map<string, unknown>([
    ["@supabase/supabase-js", { createClient: () => supabaseStub }],
    ["@/lib/supabase/server", { createServerSupabaseClient: () => supabaseStub }],
    ["@/lib/server-auth", { requireStaffAuth: async () => ({ error: null, user: { id: "u1" }, profile: { role: "admin" } }) }],
    ["@/lib/planned-room-moves", { listOverlappingPlannedRoomHolds: async () => [], syncReservationNightDependencyMetadata: async () => undefined }],
]);

type ParentModule = { filename?: string } | null | undefined;

function getStub(request: string, parent?: ParentModule): unknown | null {
    if (stubs.has(request)) return stubs.get(request);
    let resolvedRequest = request;
    if (!path.isAbsolute(resolvedRequest) && parent?.filename) {
        try { resolvedRequest = originalResolveFilename.call(module, request, parent); } catch { resolvedRequest = request; }
    }
    const withoutExtension = resolvedRequest.replace(/\.(ts|tsx|js)$/, "");
    const srcRoot = path.join(process.cwd(), "src");
    if (!withoutExtension.startsWith(srcRoot)) return null;
    const aliasRequest = `@/${path.relative(srcRoot, withoutExtension)}`;
    return stubs.has(aliasRequest) ? stubs.get(aliasRequest) : null;
}

const originalLoad = (Module as any)._load;
(Module as any)._load = function loadWithStubs(this: unknown, request: string, parent?: ParentModule, isMain?: boolean) {
    const stub = getStub(request, parent);
    if (stub !== null) return stub;
    return originalLoad.call(this, request, parent, isMain);
};

const setupRooms = require("@/app/api/setup/rooms/route") as { GET: () => Promise<unknown> };
const autoAssign = require("@/app/api/bookings/auto-assign/route") as { POST: (r: unknown) => Promise<unknown> };

/** The three marks that only a paged read leaves behind. */
function assertPagedRead(routeName: string) {
    const ops = recorded.get("room_stay_history");
    assert.ok(ops, `${routeName}: expected a read of room_stay_history — got none`);

    assert.ok(
        ops.some((o) => o.type === "range"),
        `${routeName}: room_stay_history read has no .range() — it is an un-paged read capped at 1000 rows. Ops: ${JSON.stringify(ops)}`
    );
    assert.ok(
        ops.some((o) => o.type === "order" && o.column === "id"),
        `${routeName}: paged read without a stable .order("id") can skip/duplicate rows. Ops: ${JSON.stringify(ops)}`
    );
    assert.ok(
        ops.some((o) => o.type === "count"),
        `${routeName}: no count:'exact' — without it an incomplete read cannot be detected. Ops: ${JSON.stringify(ops)}`
    );
}

async function main() {
    // ── setup/rooms GET ──────────────────────────────────────────────────
    recorded = new Map();
    tableData = {
        rooms: [{ id: "r1", room_number: "101", is_sellable: true, is_dayuse: false, sort_order: 1, room_types: { id: 1, name_en: "Std", code: "STD" } }],
        room_features: [],
        room_stay_history: Array.from({ length: 1200 }, () => ({ room_id: "r1" })),
    };
    await setupRooms.GET();
    assertPagedRead("setup/rooms GET");

    // ── bookings/auto-assign POST ────────────────────────────────────────
    recorded = new Map();
    tableData = {
        scoring_config: [],
        reservations: [{
            id: "res1", guest_name: "G", adults: 1, checkin_date: "2026-08-10", checkout_date: "2026-08-11", checkin_time: null,
            reservation_nights: [{ room_id: null, room_type_id: "rt1", stay_date: "2026-08-10", cancelled_at: null }],
            reservation_preferences: [],
        }],
        rooms: [{ id: "r1", room_number: "101", room_type_id: "rt1", floor_number: 1, sort_order: 1, wing: null, room_types: { max_guests: 2, extra_guest_charge: 0 }, room_feature_mapping: [], room_beds: [], room_detail: { quality_score: 5 } }],
        housekeeping_tasks: [],
        room_stay_history: Array.from({ length: 1200 }, () => ({ room_id: "r1" })),
        room_blocks: [],
        hotel_settings: [{ business_date: "2026-08-10" }],
    };
    // dry_run so the route never attempts a write; a later throw is fine — the read we
    // assert on happens before the assignment loop.
    await autoAssign.POST({ json: async () => ({ date: "2026-08-10", dry_run: true }) }).catch(() => undefined);
    assertPagedRead("bookings/auto-assign POST");

    console.log("PASS route.stay-history-paging: both routes consume the paged reader");
}

main().catch((err) => { console.error(err); process.exit(1); });
