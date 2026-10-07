import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DashboardKPI } from "@/lib/types";
import { getNightAuditSettings } from "@/lib/night-audit";
import { collectSameRoomLinkedContinuationReservationIds } from "@/lib/linked-stay-continuity";
import { requireStaffAuth } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function isMissingRelationError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  const message = String(error.message ?? "").toLowerCase();
  return message.includes("relation") && message.includes("does not exist");
}

function toLocalDate(date: Date, tz = "Asia/Bangkok"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function shiftDate(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type PreviewItem = {
  id: string;
  guest_name: string;
  source?: string;
  checkin_time?: string | null;
  total_price: number;
};

type DashboardKPIResponse = DashboardKPI & {
  arrivals_preview: PreviewItem[];
  departures_preview: PreviewItem[];
};

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;

    const settings = await getNightAuditSettings(supabase);
    const businessDate = settings.businessDate;
    const calendarDate = toLocalDate(new Date(), settings.hotelTimezone);
    const sellableRooms = settings.sellableRooms;

    const [
      arrivalsRes,
      departuresRes,
      occupiedTodayRes,
      inHouseRes,
      noShowPendingRes,
      dirtyRes,
      nightsRes,
      paymentsRes,
      depositsRes,
      transferTxsRes,
      tipsRes,
      posOrdersRes,
      dayusePaymentsRes,
      dayuseSessionsRes,
      dayuseRoomsRes,
      snapshotsRes,
    ] = await Promise.all([
      supabase
        .from("reservations")
        .select("id, guest_name, source, checkin_time, total_price, checked_in_at", { count: "exact" })
        .eq("checkin_date", businessDate)
        .eq("status", "active")
        .eq("is_dayuse", false)
        .order("checkin_time", { ascending: true, nullsFirst: false }),
      supabase
        .from("reservations")
        .select(`
          id,
          parent_reservation_id,
          guest_name,
          total_price,
          status,
          checkout_date,
          reservation_nights(
            stay_date,
            room_id,
            cancelled_at
          )
        `, { count: "exact" })
        .eq("checkout_date", businessDate)
        .eq("is_dayuse", false)
        .in("status", ["active", "checked_out"])
        .order("guest_name", { ascending: true }),
      supabase
        .from("reservation_nights")
        .select(`
          room_id,
          reservations!reservation_nights_reservation_id_fkey(
            id,
            parent_reservation_id,
            checkin_date,
            status
          )
        `)
        .eq("stay_date", businessDate)
        .is("cancelled_at", null),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .lte("checkin_date", businessDate)
        .gte("checkout_date", businessDate)
        .eq("status", "active")
        .eq("is_dayuse", false),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .eq("is_dayuse", false)
        .lte("checkin_date", businessDate)
        .is("checked_in_at", null),
      supabase
        .from("housekeeping_tasks")
        .select("id", { count: "exact", head: true })
        .eq("stay_date", businessDate)
        .in("status", ["dirty", "in_progress", "paused"]),
      supabase
        .from("reservation_nights")
        .select("nightly_price, reservations!inner(source, status, is_dayuse)")
        .eq("stay_date", businessDate)
        .is("cancelled_at", null)
        .neq("reservations.status", "cancelled")
        .eq("reservations.is_dayuse", false),
      supabase
        .from("folio_payments")
        .select("method, amount")
        .eq("paid_date", businessDate)
        .eq("tx_type", "payment"),
      supabase
        .from("folio_payments")
        .select("tx_type, amount, revenue_category, note")
        .eq("paid_date", businessDate)
        .in("tx_type", ["deposit", "refund"]),
      supabase
        .from("transfer_transactions")
        .select("tx_type, selling_price, margin")
        .gte("created_at", `${businessDate}T00:00:00+07:00`)
        .lt("created_at", `${businessDate}T24:00:00+07:00`),
      supabase
        .from("tip_ledger")
        .select("amount, status")
        .gte("created_at", `${businessDate}T00:00:00+07:00`)
        .lt("created_at", `${businessDate}T24:00:00+07:00`)
        .neq("status", "reversed"),
      supabase
        .from("pos_orders")
        .select("total")
        .eq("order_date", businessDate)
        .eq("status", "completed"),
      supabase
        .from("folio_payments")
        .select("amount")
        .eq("paid_date", businessDate)
        .eq("tx_type", "payment")
        .eq("revenue_category", "dayuse_revenue"),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("checkin_date", businessDate)
        .eq("is_dayuse", true)
        .eq("status", "checked_out"),
      supabase
        .from("rooms")
        .select("id", { count: "exact", head: true })
        .eq("is_sellable", true)
        .eq("is_dayuse", true),
      supabase
        .from("daily_snapshots")
        .select("business_date, total_revenue, occupancy_pct, adr, payment_total")
        .gte("business_date", shiftDate(businessDate, -6))
        .lte("business_date", shiftDate(businessDate, -1))
        .order("business_date", { ascending: true }),
    ]);

    if (arrivalsRes.error) return NextResponse.json({ success: false, error: arrivalsRes.error.message }, { status: 500 });
    if (departuresRes.error) return NextResponse.json({ success: false, error: departuresRes.error.message }, { status: 500 });
    if (occupiedTodayRes.error) return NextResponse.json({ success: false, error: occupiedTodayRes.error.message }, { status: 500 });
    if (inHouseRes.error) return NextResponse.json({ success: false, error: inHouseRes.error.message }, { status: 500 });
    if (noShowPendingRes.error) return NextResponse.json({ success: false, error: noShowPendingRes.error.message }, { status: 500 });
    if (dirtyRes.error) return NextResponse.json({ success: false, error: dirtyRes.error.message }, { status: 500 });
    if (nightsRes.error) return NextResponse.json({ success: false, error: nightsRes.error.message }, { status: 500 });
    if (paymentsRes.error) return NextResponse.json({ success: false, error: paymentsRes.error.message }, { status: 500 });
    if (depositsRes.error) return NextResponse.json({ success: false, error: depositsRes.error.message }, { status: 500 });
    if (transferTxsRes.error) return NextResponse.json({ success: false, error: transferTxsRes.error.message }, { status: 500 });
    if (tipsRes.error) return NextResponse.json({ success: false, error: tipsRes.error.message }, { status: 500 });
    if (posOrdersRes.error && !isMissingRelationError(posOrdersRes.error)) {
      return NextResponse.json({ success: false, error: posOrdersRes.error.message }, { status: 500 });
    }
    if (dayusePaymentsRes.error) return NextResponse.json({ success: false, error: dayusePaymentsRes.error.message }, { status: 500 });
    if (dayuseSessionsRes.error) return NextResponse.json({ success: false, error: dayuseSessionsRes.error.message }, { status: 500 });
    if (dayuseRoomsRes.error) return NextResponse.json({ success: false, error: dayuseRoomsRes.error.message }, { status: 500 });
    if (snapshotsRes.error) return NextResponse.json({ success: false, error: snapshotsRes.error.message }, { status: 500 });

    const sameRoomContinuationIds = collectSameRoomLinkedContinuationReservationIds({
      departures: (departuresRes.data ?? []) as any[],
      occupiedStays: (occupiedTodayRes.data ?? [])
        .map((night: any) => {
          const reservationRef = Array.isArray(night?.reservations)
            ? night.reservations[0]
            : night?.reservations;
          if (!reservationRef || String(reservationRef.status ?? "") !== "active") return null;
          return {
            reservation_id: reservationRef?.id ? String(reservationRef.id) : null,
            parent_reservation_id: reservationRef?.parent_reservation_id
              ? String(reservationRef.parent_reservation_id)
              : null,
            room_id: night?.room_id ? String(night.room_id) : null,
            checkin_date: reservationRef?.checkin_date ? String(reservationRef.checkin_date) : null,
          };
        })
        .filter(Boolean) as any[],
    });
    const filteredDepartures = (departuresRes.data ?? []).filter(
      (row: any) => !sameRoomContinuationIds.has(String(row?.id ?? ""))
    );

    const arrivals = arrivalsRes.count ?? 0;
    const arrivalsCheckedIn = (arrivalsRes.data ?? []).filter((row) => row.checked_in_at).length;
    const departures = filteredDepartures.length;
    const departuresCheckedOut = filteredDepartures.filter((row: any) => row.status === "checked_out").length;
    const inHouse = inHouseRes.count ?? 0;
    const dirtyRooms = dirtyRes.count ?? 0;

    const sources = ["walkin", "ota", "direct", "agent"] as const;
    const bySource: DashboardKPI["revenue"]["by_source"] = {
      walkin: { nights: 0, revenue: 0, pct: 0 },
      ota: { nights: 0, revenue: 0, pct: 0 },
      direct: { nights: 0, revenue: 0, pct: 0 },
      agent: { nights: 0, revenue: 0, pct: 0 },
    };

    let totalRevenue = 0;
    let occupiedNights = 0;
    for (const night of nightsRes.data ?? []) {
      const price = Number(night.nightly_price ?? 0);
      const reservation = Array.isArray(night.reservations) ? night.reservations[0] : night.reservations;
      const source = ((reservation as { source?: string } | null)?.source ?? "walkin") as keyof typeof bySource;
      totalRevenue += price;
      occupiedNights += 1;
      bySource[source].nights += 1;
      bySource[source].revenue = round2(bySource[source].revenue + price);
    }
    Object.values(bySource).forEach((entry) => {
      entry.pct = totalRevenue > 0 ? Math.round((entry.revenue / totalRevenue) * 1000) / 10 : 0;
    });

    const dayuseSellableRooms = dayuseRoomsRes.count ?? 0;
    const regularSellableRooms = Math.max(0, sellableRooms - dayuseSellableRooms);
    const occupancyPct = regularSellableRooms > 0 ? round2((occupiedNights / regularSellableRooms) * 100) : 0;
    const adr = occupiedNights > 0 ? round2(totalRevenue / occupiedNights) : 0;
    const revpar = regularSellableRooms > 0 ? round2(totalRevenue / regularSellableRooms) : 0;

    const paymentTotals = { cash: 0, transfer: 0, credit_card: 0, other: 0 };
    for (const payment of paymentsRes.data ?? []) {
      const method = String(payment.method ?? "");
      const amount = Number(payment.amount ?? 0);
      if (method in paymentTotals) {
        paymentTotals[method as keyof typeof paymentTotals] += amount;
      } else {
        paymentTotals.other += amount;
      }
    }
    const paymentTotal = round2(
      paymentTotals.cash + paymentTotals.transfer + paymentTotals.credit_card + paymentTotals.other
    );

    let depositsReceived = 0;
    let depositsRefunded = 0;
    for (const row of depositsRes.data ?? []) {
      const amount = Number(row.amount ?? 0);
      if (row.tx_type === "deposit") {
        depositsReceived += amount;
      } else if (
        row.tx_type === "refund" &&
        (row.revenue_category === "deposit" || String(row.note ?? "").toLowerCase().includes("deposit refund"))
      ) {
        depositsRefunded += amount;
      }
    }

    let transferRevenue = 0;
    let transferMargin = 0;
    for (const tx of transferTxsRes.data ?? []) {
      const revenue = Number(tx.selling_price ?? 0);
      const margin = Number(tx.margin ?? 0);
      if (tx.tx_type === "charge") {
        transferRevenue += revenue;
        transferMargin += margin;
      } else if (tx.tx_type === "refund") {
        transferRevenue -= revenue;
        transferMargin -= margin;
      }
    }

    const tipTotal = round2(
      (tipsRes.data ?? []).reduce((sum, row) => sum + (Number(row.amount ?? 0) || 0), 0)
    );
    const posRevenue = round2(
      ((posOrdersRes.error && isMissingRelationError(posOrdersRes.error)) ? [] : (posOrdersRes.data ?? []))
        .reduce((sum, row) => sum + (Number(row.total ?? 0) || 0), 0)
    );
    const dayuseRevenue = round2(
      (dayusePaymentsRes.data ?? []).reduce((sum, row) => sum + (Number(row.amount ?? 0) || 0), 0)
    );
    const dayuseSessions = dayuseSessionsRes.count ?? 0;

    const trend: DashboardKPI["trend"] = [
      ...(snapshotsRes.data ?? []).map((row) => ({
        date: String(row.business_date ?? ""),
        revenue: Number(row.total_revenue ?? 0),
        occupancy_pct: Number(row.occupancy_pct ?? 0),
        adr: Number(row.adr ?? 0),
        payment_total: Number(row.payment_total ?? 0),
      })),
      {
        date: businessDate,
        revenue: round2(totalRevenue),
        occupancy_pct: occupancyPct,
        adr,
        payment_total: paymentTotal,
      },
    ];

    const data: DashboardKPIResponse = {
      business_date: businessDate,
      calendar_date: calendarDate,
      needs_eod: businessDate < calendarDate,
      live: {
        arrivals,
        arrivals_checked_in: arrivalsCheckedIn,
        departures,
        departures_checked_out: departuresCheckedOut,
        in_house: inHouse,
        no_show_pending: noShowPendingRes.count ?? 0,
        dirty_rooms: dirtyRooms,
        sellable_rooms: regularSellableRooms,
        occupancy_pct: occupancyPct,
      },
      revenue: {
        total: round2(totalRevenue),
        adr,
        revpar,
        occupied_nights: occupiedNights,
        by_source: bySource,
      },
      payments: {
        total: paymentTotal,
        cash: round2(paymentTotals.cash),
        transfer: round2(paymentTotals.transfer),
        credit_card: round2(paymentTotals.credit_card),
        other: round2(paymentTotals.other),
        deposits_received: round2(depositsReceived),
        deposits_refunded: round2(depositsRefunded),
      },
      trend,
      extras: {
        transfer_revenue: round2(transferRevenue),
        transfer_margin: round2(transferMargin),
        tip_total: tipTotal,
        pos_revenue: posRevenue,
        dayuse_revenue: dayuseRevenue,
        dayuse_sessions: dayuseSessions,
      },
      arrivals_preview: (arrivalsRes.data ?? []).slice(0, 10).map((row) => ({
        id: String(row.id),
        guest_name: String(row.guest_name ?? ""),
        source: row.source ? String(row.source) : undefined,
        checkin_time: row.checkin_time ? String(row.checkin_time) : null,
        total_price: Number(row.total_price ?? 0),
      })),
      departures_preview: filteredDepartures.slice(0, 10).map((row: any) => ({
        id: String(row.id),
        guest_name: String(row.guest_name ?? ""),
        total_price: Number(row.total_price ?? 0),
      })),
    };

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("dashboard/kpi GET failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
