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
import { NextRequest, NextResponse } from "next/server";

const REVENUE_REPORT_PAGE_SIZE = 1000;
const REVENUE_REPORT_MAX_ROWS = 20000;

type RevenueQueryError = { message: string };
type RevenueRangeQuery<T> = {
    range(from: number, to: number): PromiseLike<{ data: T[] | null; error: RevenueQueryError | null }>;
};

function toLocalDate(d: Date) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

async function fetchRevenueRows<T>(
    createQuery: () => RevenueRangeQuery<T>
): Promise<{ data: T[] | null; error: RevenueQueryError | null }> {
    const rows: T[] = [];
    let offset = 0;

    while (offset < REVENUE_REPORT_MAX_ROWS) {
        const { data, error } = await createQuery().range(offset, offset + REVENUE_REPORT_PAGE_SIZE - 1);
        if (error) return { data: null, error };

        const page = data ?? [];
        rows.push(...page);
        if (page.length < REVENUE_REPORT_PAGE_SIZE) return { data: rows, error: null };
        offset += REVENUE_REPORT_PAGE_SIZE;
    }

    return {
        data: null,
        error: { message: `Revenue report exceeded ${REVENUE_REPORT_MAX_ROWS} rows. Narrow the date range.` },
    };
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

        const [{ data: rooms, error: roomsErr }, { data: nights, error: nightsErr }, { data: posOrders, error: posErr }, { data: extraRows, error: extraErr }, { data: dayuseRows, error: dayuseErr }] = await Promise.all([
            supabase
                .from("rooms")
                .select("id, room_number, floor_number, is_dayuse, closure_reason, is_sellable")
                .eq("is_sellable", true),
            fetchRevenueRows<RevenueNightRow>(() => supabase
                .from("reservation_nights")
                .select(`
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
      `)
                .gte("stay_date", startDate)
                .lte("stay_date", endDate)
                .neq("reservations.status", "cancelled")),
            fetchRevenueRows<RevenuePosOrderRow>(() => supabase
                .from("pos_orders")
                .select("total, order_date, status")
                .gte("order_date", startDate)
                .lte("order_date", endDate)
                .eq("status", "completed")),
            fetchRevenueRows<RevenueExtraRow>(() => supabase
                .from("folio_payments")
                .select("id, paid_date, paid_at, tx_type, amount, note, revenue_category, is_record_only, is_correction, is_void_reversal, void_of")
                .gte("paid_date", startDate)
                .lte("paid_date", endDate)
                .eq("revenue_category", "extra_charge")
                .in("tx_type", ["payment", "refund"])),
            fetchRevenueRows<RevenueDayuseRow>(() => supabase
                .from("folio_payments")
                .select("id, reservation_id, paid_date, paid_at, tx_type, amount, note, revenue_category, is_record_only, is_correction, is_void_reversal, void_of")
                .gte("paid_date", startDate)
                .lte("paid_date", endDate)
                .eq("revenue_category", "dayuse_revenue")
                .in("tx_type", ["payment", "refund"])),
        ]);

        if (roomsErr) return NextResponse.json({ error: roomsErr.message }, { status: 500 });
        if (nightsErr) return NextResponse.json({ error: nightsErr.message }, { status: 500 });
        if (posErr) return NextResponse.json({ error: posErr.message }, { status: 500 });
        if (extraErr) return NextResponse.json({ error: extraErr.message }, { status: 500 });
        if (dayuseErr) return NextResponse.json({ error: dayuseErr.message }, { status: 500 });

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
