/**
 * Total-nights-per-room aggregation over `room_stay_history`.
 *
 * WHAT THIS PROVES: the reader pages past PostgREST's 1000-row default cap (row 1001 is
 * counted), that an incomplete or failed read THROWS rather than returning a plausible-looking
 * partial map, and that a not-yet-migrated table still degrades gracefully.
 *
 * WHY IT MATTERS: `room_stay_history` is one row per room per night per source and is
 * bulk-imported, so it is expected to be >1000 in production. Both call sites previously did a bare
 * `.select("room_id")` with the error discarded — so an arbitrary <=1000-row slice, and a
 * failed read, were both indistinguishable from "this hotel has no stay history" (every room
 * scoring 0 nights).
 *
 * Run: npx tsx src/lib/room-stay-nights.test.mts
 */
import assert from "node:assert/strict";
import { loadRoomStayNights, RoomStayHistoryIncompleteError } from "./room-stay-nights.ts";

type Recorded = { offsets: Array<[number, number]>; ordered: string[]; countRequested: boolean };

/**
 * Fake PostgREST that serves `rows` in pages and enforces the same cap the real one does:
 * a request wider than pageSize is truncated to pageSize.
 */
function fakeSupabase(
    rows: Array<{ room_id: string }>,
    opts: { pageSize?: number; error?: { code?: string; message?: string }; countOverride?: number | null } = {}
) {
    const pageSize = opts.pageSize ?? 1000;
    const recorded: Recorded = { offsets: [], ordered: [], countRequested: false };

    const builder = () => {
        let wantCount = false;
        const api: any = {
            select(_fields: string, options?: { count?: string }) {
                if (options?.count === "exact") { wantCount = true; recorded.countRequested = true; }
                return api;
            },
            order(column: string) { recorded.ordered.push(column); return api; },
            range(from: number, to: number) {
                recorded.offsets.push([from, to]);
                const width = Math.min(to - from + 1, pageSize);
                const page = opts.error ? null : rows.slice(from, from + width);
                const result = {
                    data: page,
                    error: opts.error ?? null,
                    count: wantCount ? (opts.countOverride !== undefined ? opts.countOverride : rows.length) : null,
                };
                return Promise.resolve(result);
            },
        };
        return api;
    };

    return { client: { from: (_table: string) => builder() }, recorded };
}

function makeRows(n: number, roomId: (i: number) => string) {
    return Array.from({ length: n }, (_, i) => ({ room_id: roomId(i) }));
}

// ── 1. The cap itself: row 1001 must be counted ──────────────────────────────
{
    // 1500 rows: room-A gets the first 1000 (exactly filling page 1), room-B the next 500.
    // A single un-paged read would see room-B ZERO times.
    const rows = makeRows(1500, (i) => (i < 1000 ? "room-A" : "room-B"));
    const { client, recorded } = fakeSupabase(rows);

    const nights = await loadRoomStayNights(client as any);

    assert.ok(nights, "expected a nights map, got null");
    assert.equal(nights["room-A"], 1000, "room-A should have all 1000 of its nights");
    assert.equal(
        nights["room-B"],
        500,
        "room-B lives entirely past the 1000-row cap — a single un-paged read returns 0 for it"
    );
    assert.ok(recorded.offsets.length >= 2, `expected pagination, saw ranges: ${JSON.stringify(recorded.offsets)}`);
    assert.ok(
        recorded.ordered.includes("id"),
        `pagination without a stable .order() can skip/duplicate rows across pages; ordered by: ${JSON.stringify(recorded.ordered)}`
    );
}

// ── 2. Exact boundary: row 1001 specifically ─────────────────────────────────
{
    const rows = makeRows(1001, (i) => (i === 1000 ? "room-LAST" : "room-BULK"));
    const { client } = fakeSupabase(rows);

    const nights = await loadRoomStayNights(client as any);

    assert.equal(nights?.["room-LAST"], 1, "the 1001st row must be counted — it is the whole point");
    assert.equal(nights?.["room-BULK"], 1000);
}

// ── 3. A failed read must THROW, not read as "no history" ────────────────────
{
    const { client } = fakeSupabase([], { error: { code: "57014", message: "statement timeout" } });

    await assert.rejects(
        () => loadRoomStayNights(client as any),
        (err: unknown) => {
            assert.ok(err instanceof RoomStayHistoryIncompleteError, `expected RoomStayHistoryIncompleteError, got ${err}`);
            assert.match(String((err as Error).message), /statement timeout/);
            return true;
        },
        "a failed read must throw — silently returning {} makes every room score 0 nights"
    );
}

// ── 4. Not-yet-migrated table degrades gracefully (settled: progressive migration) ──
for (const code of ["42P01", "PGRST205"]) {
    const { client } = fakeSupabase([], { error: { code, message: 'relation "room_stay_history" does not exist' } });

    const nights = await loadRoomStayNights(client as any);

    assert.equal(nights, null, `${code} (table not migrated yet) must return null, not throw`);
}

// ── 5. Completeness guard: fewer rows than the table reports ─────────────────
{
    // Table claims 2000 rows but only serves 1200 — a real partial read.
    const rows = makeRows(1200, () => "room-A");
    const { client } = fakeSupabase(rows, { countOverride: 2000 });

    await assert.rejects(
        () => loadRoomStayNights(client as any),
        (err: unknown) => {
            assert.ok(err instanceof RoomStayHistoryIncompleteError, `expected RoomStayHistoryIncompleteError, got ${err}`);
            assert.match(String((err as Error).message), /1200/);
            assert.match(String((err as Error).message), /2000/);
            return true;
        },
        "counted rows != count:'exact' total must throw"
    );
}

// ── 6. Empty table is a legitimate zero, not an error ────────────────────────
{
    const { client } = fakeSupabase([]);
    const nights = await loadRoomStayNights(client as any);
    assert.deepEqual(nights, {}, "a genuinely empty table returns an empty map (distinct from null/throw)");
}

console.log("PASS room-stay-nights: pages past the cap, throws on incomplete, degrades on unmigrated");
