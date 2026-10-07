import {
  getNightAuditSettings,
  toBangkokWindow,
} from "@/lib/night-audit";
import {
  GET as getPaymentDailyReport,
  createNightAuditPaymentDailyRequest,
} from "@/app/api/reports/payment-daily/route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NightAuditSnapshot } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function isMissingRelationError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  const message = String(error.message ?? "").toLowerCase();
  return message.includes("relation") && message.includes("does not exist");
}

function parseAuditJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function GET() {
  try {
    const supabase = createServerSupabaseClient();
    const settings = await getNightAuditSettings(supabase);
    const businessDate = settings.businessDate;
    const sellableRooms = settings.sellableRooms;
    const { from, to } = toBangkokWindow(businessDate);

    const dayUseSellableRes = await supabase
      .from("rooms")
      .select("id", { count: "exact", head: true })
      .eq("is_sellable", true)
      .eq("is_dayuse", true);
    if (dayUseSellableRes.error) {
      return NextResponse.json({ success: false, error: dayUseSellableRes.error.message }, { status: 500 });
    }
    const regularSellableRooms = Math.max(0, sellableRooms - (dayUseSellableRes.count ?? 0));

    const nightsRes = await supabase
      .from("reservation_nights")
      .select("nightly_price, reservations!inner(source, status, is_dayuse)")
      .eq("stay_date", businessDate)
      .is("cancelled_at", null)
      .neq("reservations.status", "cancelled")
      .eq("reservations.is_dayuse", false);
    if (nightsRes.error) return NextResponse.json({ success: false, error: nightsRes.error.message }, { status: 500 });

    const sources = ["walkin", "ota", "direct", "agent"] as const;
    const agg: Record<string, { nights: number; revenue: number }> = {};
    sources.forEach((s) => {
      agg[s] = { nights: 0, revenue: 0 };
    });

    let totalRevenue = 0;
    let occupiedNights = 0;
    (nightsRes.data ?? []).forEach((n) => {
      const price = Number(n.nightly_price) || 0;
      const reservation = Array.isArray(n.reservations) ? n.reservations[0] : n.reservations;
      const src = String((reservation as { source?: string } | null)?.source ?? "walkin");
      totalRevenue += price;
      occupiedNights += 1;
      if (!agg[src]) agg[src] = { nights: 0, revenue: 0 };
      agg[src].nights += 1;
      agg[src].revenue += price;
    });

    const roomNights = regularSellableRooms;
    const occupancyPct = roomNights > 0 ? Math.round((occupiedNights / roomNights) * 1000) / 10 : 0;
    const adr = occupiedNights > 0 ? Math.round((totalRevenue / occupiedNights) * 100) / 100 : 0;
    const revpar = roomNights > 0 ? Math.round((totalRevenue / roomNights) * 100) / 100 : 0;

    const bySource: NightAuditSnapshot["by_source"] = {};
    sources.forEach((s) => {
      bySource[s] = {
        nights: agg[s].nights,
        revenue: agg[s].revenue,
        share_pct: totalRevenue > 0 ? Math.round((agg[s].revenue / totalRevenue) * 1000) / 10 : 0,
      };
    });

    const paymentDailyRequest = createNightAuditPaymentDailyRequest(businessDate);
    const paymentDailyResponse = await getPaymentDailyReport(paymentDailyRequest);
    const paymentDailyData = await paymentDailyResponse.json();
    if (!paymentDailyData?.success) {
      return NextResponse.json(
        { success: false, error: paymentDailyData?.error || "Failed to load payment daily summary." },
        { status: paymentDailyResponse.status || 500 }
      );
    }

    const paymentCash = Math.round(Number(paymentDailyData?.grand_total?.cash?.payment ?? 0) * 100) / 100;
    const paymentTransfer = Math.round(Number(paymentDailyData?.grand_total?.transfer?.payment ?? 0) * 100) / 100;
    const paymentCard = Math.round(Number(paymentDailyData?.grand_total?.credit_card?.payment ?? 0) * 100) / 100;
    const paymentOther = Math.round(Number(paymentDailyData?.grand_total?.other?.payment ?? 0) * 100) / 100;
    const paymentTotal = Math.round((paymentCash + paymentTransfer + paymentCard + paymentOther) * 100) / 100;
    const depositReceived = Math.round(
      (
        Number(paymentDailyData?.grand_total?.cash?.deposit ?? 0)
        + Number(paymentDailyData?.grand_total?.transfer?.deposit ?? 0)
        + Number(paymentDailyData?.grand_total?.credit_card?.deposit ?? 0)
        + Number(paymentDailyData?.grand_total?.other?.deposit ?? 0)
      ) * 100
    ) / 100;
    const depositRefunded = Math.round(
      ((paymentDailyData?.deposit_refunds ?? []) as Array<{ amount?: number | null }>)
        .reduce((sum, row) => sum + (Number(row.amount ?? 0) || 0), 0) * 100
    ) / 100;
    const posRevenue = Math.round(
      (
        Number(paymentDailyData?.pos?.cash?.payment ?? 0)
        + Number(paymentDailyData?.pos?.transfer?.payment ?? 0)
        + Number(paymentDailyData?.pos?.credit_card?.payment ?? 0)
        + Number(paymentDailyData?.pos?.other?.payment ?? 0)
        - Number(paymentDailyData?.pos?.cash?.refund ?? 0)
        - Number(paymentDailyData?.pos?.transfer?.refund ?? 0)
        - Number(paymentDailyData?.pos?.credit_card?.refund ?? 0)
        - Number(paymentDailyData?.pos?.other?.refund ?? 0)
      ) * 100
    ) / 100;

    const transferRes = await supabase
      .from("transfer_transactions")
      .select("tx_type, selling_price, cost_price, margin")
      .gte("created_at", from)
      .lt("created_at", to);
    if (transferRes.error) return NextResponse.json({ success: false, error: transferRes.error.message }, { status: 500 });

    let transferRevenue = 0;
    let transferCost = 0;
    let transferMargin = 0;
    (transferRes.data ?? []).forEach((t) => {
      if (t.tx_type === "charge") {
        transferRevenue += Number(t.selling_price) || 0;
        transferCost += Number(t.cost_price) || 0;
        transferMargin += Number(t.margin) || 0;
      } else if (t.tx_type === "refund") {
        transferRevenue -= Number(t.selling_price) || 0;
        transferCost -= Number(t.cost_price) || 0;
        transferMargin -= Number(t.margin) || 0;
      }
    });

    const tipsRes = await supabase
      .from("tip_ledger")
      .select("amount")
      .gte("created_at", from)
      .lt("created_at", to)
      .neq("status", "reversed");
    if (tipsRes.error) return NextResponse.json({ success: false, error: tipsRes.error.message }, { status: 500 });
    const tipTotal = (tipsRes.data ?? []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const commissionsRes = await supabase
      .from("commission_ledger")
      .select("commission_amount")
      .in("status", ["pending", "approved"]);
    if (commissionsRes.error) return NextResponse.json({ success: false, error: commissionsRes.error.message }, { status: 500 });
    const commissionLiability = (commissionsRes.data ?? []).reduce(
      (sum, c) => sum + (Number(c.commission_amount) || 0),
      0
    );

    const noShowLogsRes = await supabase
      .from("audit_logs")
      .select("id, after_json")
      .eq("action", "no_show")
      .eq("entity_type", "reservation")
      .eq("business_date", businessDate);
    if (noShowLogsRes.error) return NextResponse.json({ success: false, error: noShowLogsRes.error.message }, { status: 500 });
    const noShowCount = noShowLogsRes.data?.length ?? 0;
    const noShowFeeTotal = (noShowLogsRes.data ?? []).reduce((sum, row: any) => {
      const after = parseAuditJson(row?.after_json);
      return sum + (Number(after?.fee_amount) || 0);
    }, 0);

    const preview: NightAuditSnapshot = {
      total_revenue: Math.round(totalRevenue * 100) / 100,
      occupied_nights: occupiedNights,
      room_nights: roomNights,
      occupancy_pct: occupancyPct,
      adr,
      revpar,
      by_source: bySource,
      payment_total: Math.round(paymentTotal * 100) / 100,
      payment_cash: Math.round(paymentCash * 100) / 100,
      payment_transfer: Math.round(paymentTransfer * 100) / 100,
      payment_card: Math.round(paymentCard * 100) / 100,
      payment_other: Math.round(paymentOther * 100) / 100,
      transfer_revenue: Math.round(transferRevenue * 100) / 100,
      transfer_cost: Math.round(transferCost * 100) / 100,
      transfer_margin: Math.round(transferMargin * 100) / 100,
      tip_total: Math.round(tipTotal * 100) / 100,
      commission_liability: Math.round(commissionLiability * 100) / 100,
      deposit_received: Math.round(depositReceived * 100) / 100,
      deposit_refunded: Math.round(depositRefunded * 100) / 100,
      pos_revenue: Math.round(posRevenue * 100) / 100,
      no_show_count: noShowCount,
      no_show_fee_total: Math.round(noShowFeeTotal * 100) / 100,
    };

    return NextResponse.json({
      success: true,
      business_date: businessDate,
      preview,
    });
  } catch (err) {
    console.error("night-audit/preview GET failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
