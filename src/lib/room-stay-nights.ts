/**
 * Total-nights-per-room aggregation over `room_stay_history`.
 *
 * The table is one row per room per NIGHT per source and is bulk-imported
 * (scripts/migrate-hk-logs.ts), so it is expected to exceed PostgREST's 1000-row default
 * cap in production. A bare `.select("room_id")` returns an arbitrary <=1000-row slice, and with
 * the error discarded a failed read is indistinguishable from "this hotel has no stay
 * history" — every room then scores 0 nights.
 *
 * Shared by the auto-assign room scorer and the setup/rooms per-room stat.
 */

/** PostgREST / Postgres codes meaning "this relation does not exist yet". */
const UNDEFINED_TABLE_CODES = new Set(["42P01", "PGRST205"]);

export const ROOM_STAY_NIGHTS_PAGE_SIZE = 1000;

export class RoomStayHistoryIncompleteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RoomStayHistoryIncompleteError";
    }
}

type StayHistoryPage = {
    data: Array<{ room_id: string }> | null;
    error: { message?: string; code?: string } | null;
    count?: number | null;
};

type StayHistoryReader = {
    from: (table: string) => {
        select: (fields: string, options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) => {
            order: (column: string, options?: { ascending?: boolean }) => {
                range: (from: number, to: number) => PromiseLike<StayHistoryPage>;
            };
        };
    };
};

/**
 * Nights per room_id, or `null` when the table does not exist yet (progressive migration
 * is a settled decision — see hotel-ops "What's Been Decided").
 *
 * Throws {@link RoomStayHistoryIncompleteError} on any other read error and on a
 * count:'exact' mismatch. Callers must not convert that back into an empty map.
 */
export async function loadRoomStayNights(supabase: StayHistoryReader): Promise<Record<string, number> | null> {
    const nights: Record<string, number> = {};
    let fetched = 0;
    let expectedTotal: number | null = null;

    for (let offset = 0; ; offset += ROOM_STAY_NIGHTS_PAGE_SIZE) {
        const page = await supabase
            .from("room_stay_history")
            .select("room_id", { count: "exact" })
            .order("id", { ascending: true })
            .range(offset, offset + ROOM_STAY_NIGHTS_PAGE_SIZE - 1);

        if (page.error) {
            if (UNDEFINED_TABLE_CODES.has(String(page.error.code))) return null;
            throw new RoomStayHistoryIncompleteError(
                `Failed to read room_stay_history at offset ${offset}: ${page.error.message ?? "unknown error"}`
            );
        }

        if (expectedTotal === null && typeof page.count === "number") expectedTotal = page.count;

        const rows = page.data ?? [];
        for (const row of rows) {
            if (!row?.room_id) continue;
            nights[row.room_id] = (nights[row.room_id] ?? 0) + 1;
        }
        fetched += rows.length;

        if (rows.length < ROOM_STAY_NIGHTS_PAGE_SIZE) break;
    }

    if (expectedTotal !== null && fetched !== expectedTotal) {
        throw new RoomStayHistoryIncompleteError(
            `room_stay_history read incomplete: counted ${fetched} rows but the table reports ${expectedTotal}`
        );
    }

    return nights;
}
