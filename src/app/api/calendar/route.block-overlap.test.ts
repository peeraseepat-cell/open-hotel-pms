/**
 * Calendar room_blocks server-side overlap filter.
 *
 * WHAT THIS PROVES: the query issued against `room_blocks` is a real AND-overlap whose
 * emitted predicate accepts/rejects the right rows at the window boundaries — evaluated as a
 * predicate, not grepped for a token. It rejects at least one row, which is what makes it
 * NOT the tautology it replaced (`.or(start_date.lte.END,end_date.gte.START)` excluded a row
 * only when end_date < start_date, i.e. never — so the server shipped the whole table).
 *
 * WHAT THIS DOES NOT PROVE: that >1000 blocks paginate. It does not add pagination; the
 * correct window filter is what bounds the result set (a 14-day calendar window). If a single
 * window ever holds >1000 blocks the row cap still applies.
 *
 * Boundary semantics are INCLUSIVE on both ends, matching the client predicate that is the
 * source of truth for this surface (src/app/pms/calendar/page.tsx:411 —
 * `!(end_date < startDate || start_date > endDate)`). Do NOT copy the half-open semantics
 * used by reservation_room_plans in this same route (:87-88) — different entity.
 *
 * Run: npx tsx src/app/api/calendar/route.block-overlap.test.ts
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

/** Ops recorded per table for the single GET under test. */
const recorded = new Map<string, Operation[]>();

class QueryBuilder implements PromiseLike<{ data: unknown[]; error: null }> {
    private operations: Operation[] = [];

    constructor(private readonly table: string) {
        recorded.set(table, this.operations);
    }

    private push(type: string, column?: string, value?: unknown) {
        this.operations.push({ type, column, value });
        return this;
    }

    select(_fields?: string, _options?: Record<string, unknown>) { return this; }
    eq(column: string, value: unknown) { return this.push("eq", column, value); }
    gte(column: string, value: unknown) { return this.push("gte", column, value); }
    lte(column: string, value: unknown) { return this.push("lte", column, value); }
    gt(column: string, value: unknown) { return this.push("gt", column, value); }
    lt(column: string, value: unknown) { return this.push("lt", column, value); }
    is(column: string, value: unknown) { return this.push("is", column, value); }
    in(column: string, values: unknown[]) { return this.push("in", column, values); }
    or(filter: string) { return this.push("or", undefined, filter); }
    order(_column: string, _opts?: Record<string, unknown>) { return this; }
    range(from: number, to: number) { return this.push("range", undefined, `${from}-${to}`); }

    then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: [] as unknown[], error: null }).then(onfulfilled, onrejected);
    }
}

const supabaseStub = { from: (table: string) => new QueryBuilder(table) };

const stubs = new Map<string, unknown>([
    ["@supabase/supabase-js", { createClient: () => supabaseStub }],
    ["@/lib/supabase/server", { createServerSupabaseClient: () => supabaseStub }],
    ["@/lib/server-auth", { requireStaffAuth: async () => ({ error: null, user: { id: "u1" }, profile: { role: "admin" } }) }],
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

const originalLoad = (Module as any)._load;
(Module as any)._load = function loadWithStubs(this: unknown, request: string, parent?: ParentModule, isMain?: boolean) {
    const stub = getStub(request, parent);
    if (stub !== null) return stub;
    return originalLoad.call(this, request, parent, isMain);
};

const { GET } = require("./route") as { GET: (req: unknown) => Promise<unknown> };

const START = "2026-08-10";
const END = "2026-08-24";

const fakeRequest = {
    nextUrl: { searchParams: new URLSearchParams({ start: START, end: END }) },
    headers: new Headers(),
    cookies: { get: () => undefined, getAll: () => [] },
};

async function main() {
await GET(fakeRequest);

const ops = recorded.get("room_blocks");
assert.ok(ops, "expected the calendar route to query room_blocks");

// 1. The tautology is gone. `.or()` on this table is the defect itself.
assert.equal(
    ops.filter((o) => o.type === "or").length,
    0,
    `room_blocks must not use .or() — that filter is a tautology (a row escapes only if end_date < start_date). Got: ${JSON.stringify(ops)}`
);

// 2. The window is applied as an AND of two bounds.
assert.deepEqual(
    ops.filter((o) => o.type === "lte" || o.type === "gte").sort((a, b) => a.column!.localeCompare(b.column!)),
    [
        { type: "gte", column: "end_date", value: START },
        { type: "lte", column: "start_date", value: END },
    ],
    `expected inclusive AND-overlap bounds on room_blocks. Got: ${JSON.stringify(ops)}`
);

// 3. Evaluate the EMITTED predicate against boundary rows, rather than trusting its shape.
function emittedPredicate(operations: Operation[]) {
    return (row: Record<string, string>) =>
        operations.every((op) => {
            const v = row[op.column as string];
            switch (op.type) {
                case "lte": return v <= (op.value as string);
                case "gte": return v >= (op.value as string);
                case "lt": return v < (op.value as string);
                case "gt": return v > (op.value as string);
                default: throw new Error(`predicate contains an unevaluatable op: ${op.type}`);
            }
        });
}

const accepts = emittedPredicate(ops);

const cases: Array<[string, Record<string, string>, boolean]> = [
    ["spans the whole window", { start_date: "2026-08-01", end_date: "2026-09-01" }, true],
    ["strictly inside", { start_date: "2026-08-12", end_date: "2026-08-13" }, true],
    ["ends exactly ON the window start (inclusive)", { start_date: "2026-08-01", end_date: START }, true],
    ["starts exactly ON the window end (inclusive)", { start_date: END, end_date: "2026-09-05" }, true],
    ["ends the day before the window", { start_date: "2026-08-01", end_date: "2026-08-09" }, false],
    ["starts the day after the window", { start_date: "2026-08-25", end_date: "2026-08-30" }, false],
];

for (const [name, row, expected] of cases) {
    assert.equal(accepts(row), expected, `block that ${name} → expected ${expected ? "INCLUDED" : "EXCLUDED"} (row: ${JSON.stringify(row)})`);
}

// 4. The predicate must actually reject something — the property the tautology failed.
assert.ok(
    cases.some(([, row]) => !accepts(row)),
    "emitted predicate accepts every row — it is still a tautology"
);

console.log("PASS route.block-overlap: room_blocks uses an inclusive AND-overlap matching the client predicate");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
