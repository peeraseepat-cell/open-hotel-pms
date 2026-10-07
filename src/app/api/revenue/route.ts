import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveBusinessDate } from "@/lib/folio-fees";
import { requireStaffAuth } from "@/lib/server-auth";
import {
    summarizeRevenueRange,
    type RevenueDayuseRow,
    type RevenueExtraRow,
    type RevenueNightRow,
    type RevenuePosOrderRow,
    type RevenueRoomRow,
} from "@/lib/revenue-reporting";
import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { NextRequest, NextResponse } from "next/server";

function toLocalDate(d: Date) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

export async function GET(request: NextRequest) {
    try {
        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request);
        if (auth.error) return auth.error;

        const sp = request.nextUrl.searchParams;

        const fallbackDate = toLocalDate(new Date());
        const businessDate = await resolveBusinessDate(supabase, fallbackDate);
        const startDate = (sp.get("start") ?? "").trim() || businessDate;
        const endDate = (sp.get("end") ?? "").trim() || businessDate;

        // Every range-scoped read below pages by KEYSET, not by offset. Offset paging
        // without a total ORDER BY duplicates and skips rows across page boundaries, so
        // a range wide enough to cross 1000 rows returned revenue that was WRONG rather
        // than obviously missing. `id` leads each projection because it is the cursor;
        // `count: "exact"` is what lets the pager certify it read the whole set.
        const [{ data: rooms, error: roomsErr }, nights, posOrders, extraRows, dayuseRows] = await Promise.all([
            supabase
                .from("rooms")
                .select("id, room_number, floor_number, is_dayuse, closure_reason, is_sellable")
                .eq("is_sellable", true),
            fetchAllRowsComplete<RevenueNightRow>(() => supabase
                .from("reservation_nights")
                .select(`id,
        room_id,
        stay_date,
        nightly_price,
        cancelled_at,
        reservations!inner (
          id,
          source,
          status,
          is_dayuse
        )
      `, { count: "exact" })
                .gte("stay_date", startDate)
                .lte("stay_date", endDate)
                .neq("reservations.status", "cancelled"), { label: "revenue nights" }),
            fetchAllRowsComplete<RevenuePosOrderRow>(() => supabase
                .from("pos_orders")
                .select("id, total, order_date, status", { count: "exact" })
                .gte("order_date", startDate)
                .lte("order_date", endDate)
                .eq("status", "completed"), { label: "revenue POS orders" }),
            fetchAllRowsComplete<RevenueExtraRow>(() => supabase
                .from("folio_payments")
                .select("id, paid_date, paid_at, tx_type, amount, note, revenue_category, is_record_only, is_correction, is_void_reversal, void_of", { count: "exact" })
                .gte("paid_date", startDate)
                .lte("paid_date", endDate)
                .eq("revenue_category", "extra_charge")
                .in("tx_type", ["payment", "refund"]), { label: "revenue extra charges" }),
            fetchAllRowsComplete<RevenueDayuseRow>(() => supabase
                .from("folio_payments")
                .select("id, reservation_id, paid_date, paid_at, tx_type, amount, note, revenue_category, is_record_only, is_correction, is_void_reversal, void_of", { count: "exact" })
                .gte("paid_date", startDate)
                .lte("paid_date", endDate)
                .eq("revenue_category", "dayuse_revenue")
                .in("tx_type", ["payment", "refund"]), { label: "revenue day-use" }),
        ]);

        if (roomsErr) return NextResponse.json({ error: roomsErr.message }, { status: 500 });

        const scopedExtraRows = (extraRows ?? []) as RevenueExtraRow[];
        const scopedDayuseRows = (dayuseRows ?? []) as RevenueDayuseRow[];
        const ledgerIds = [...scopedExtraRows, ...scopedDayuseRows].map((row) => String(row.id ?? "").trim()).filter(Boolean);
        const laterVoidedExtraOriginalIds = new Set<string>();
        const laterVoidedDayuseOriginalIds = new Set<string>();
        if (ledgerIds.length > 0) {
            const { data: laterVoidRows, error: laterVoidError } = await supabase
                .from("folio_payments")
                .select("void_of")
                .eq("is_void_reversal", true)
                .in("void_of", ledgerIds);
            if (laterVoidError) return NextResponse.json({ error: laterVoidError.message }, { status: 500 });
            const extraIdSet = new Set(scopedExtraRows.map((row) => String(row.id ?? "").trim()).filter(Boolean));
            const dayuseIdSet = new Set(scopedDayuseRows.map((row) => String(row.id ?? "").trim()).filter(Boolean));
            for (const row of laterVoidRows ?? []) {
                const originalId = String((row as { void_of?: string | null }).void_of ?? "").trim();
                if (!originalId) continue;
                if (extraIdSet.has(originalId)) laterVoidedExtraOriginalIds.add(originalId);
                if (dayuseIdSet.has(originalId)) laterVoidedDayuseOriginalIds.add(originalId);
            }
        }

        const report = summarizeRevenueRange({
            rooms: (rooms ?? []) as RevenueRoomRow[],
            nights: (nights ?? []) as RevenueNightRow[],
            extraRows: scopedExtraRows,
            laterVoidedExtraOriginalIds,
            dayuseRows: scopedDayuseRows,
            laterVoidedDayuseOriginalIds,
            posOrders: (posOrders ?? []) as RevenuePosOrderRow[],
            startDate,
            endDate,
        });

        return NextResponse.json({
            success: true,
            business_date: businessDate,
            start_date: startDate,
            end_date: endDate,
            day_count: report.day_count,
            sellable_rooms: report.sellable_rooms,
            kpi: report.kpi,
            by_source: report.by_source,
            by_day: report.by_day
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
