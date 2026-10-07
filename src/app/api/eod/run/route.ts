import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
    getNightAuditSpilloverScope,
    listPendingNoShows,
    normalizePendingGroupCheckinWizardDrafts,
} from "@/lib/night-audit";
import {
    GET as getPaymentDailyReport,
    createNightAuditPaymentDailyRequest,
} from "@/app/api/reports/payment-daily/route";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { computeStockSnapshot } from "@/lib/stock-snapshot";
import { computeLinenDailySnapshot } from "@/lib/linen/daily-snapshot";
import { NextRequest, NextResponse } from "next/server";

function isMissingRelationError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
    if (!error) return false;
    if (error.code === "42P01") return true;
    const message = String(error.message ?? "").toLowerCase();
    return message.includes("relation") && message.includes("does not exist");
}

function toLocalDate(date: Date, tz = "Asia/Bangkok"): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
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

/* ─── POST — Run Night Audit (EOD) ─────────────────
   1. Compute Revenue KPIs for business_date
   2. Compute Payment totals for business_date
   3. Upsert into daily_snapshots
   4. Advance business_date by +1
*/
export async function POST(request: NextRequest) {
    try {
        const supabase = createServerSupabaseClient();
        const body = await request.json().catch(() => ({}));
        const notes: string | undefined = body.notes;
        const force: boolean = body.force === true;


        /* ── Fetch current settings ──────────────────── */
        const { data: settings, error: settingsErr } = await supabase
            .from("hotel_settings")
            .select("business_date, hotel_timezone, sellable_rooms")
            .eq("id", 1)
            .maybeSingle();

        if (settingsErr || !settings) {
            return NextResponse.json({ error: "Hotel settings not found. Run Supabase migrations first." }, { status: 500 });
        }

        const businessDate = settings.business_date as string;
        const tz = (settings.hotel_timezone as string) ?? "Asia/Bangkok";
        const sellableRooms = (settings.sellable_rooms as number) ?? 1;
        const calendarDate = toLocalDate(new Date(), tz);
        const spillover = await getNightAuditSpilloverScope(supabase, businessDate, tz);

        const { count: dayuseSellableCount, error: dayuseSellableError } = await supabase
            .from("rooms")
            .select("id", { count: "exact", head: true })
            .eq("is_sellable", true)
            .eq("is_dayuse", true);

        if (dayuseSellableError) {
            return NextResponse.json({ error: dayuseSellableError.message }, { status: 500 });
        }
        const regularSellableRooms = Math.max(0, sellableRooms - (dayuseSellableCount ?? 0));

        // Prevent running EOD on future date (bypass with force=true for testing)
        if (!force && businessDate >= calendarDate) {
            return NextResponse.json({
                error: `EOD already up to date. Business date (${businessDate}) = today (${calendarDate}).`
            }, { status: 400 });
        }

        const pendingNoShows = await listPendingNoShows(supabase, businessDate);
        if (!force && pendingNoShows.length > 0) {
            return NextResponse.json({
                error: `Night Audit blocked. ${pendingNoShows.length} pending no-show booking(s) must be resolved first.`,
                code: "PENDING_NO_SHOWS",
                business_date: businessDate,
                pending_no_show_count: pendingNoShows.length,
                pending_no_shows: pendingNoShows,
            }, { status: 409 });
        }

        let pendingWizardDraftCount = 0;
        try {
            pendingWizardDraftCount = (await normalizePendingGroupCheckinWizardDrafts(supabase, businessDate)).pendingCount;
        } catch (error) {
            if (isMissingRelationError(error as { code?: string | null; message?: string | null })) {
                pendingWizardDraftCount = 0;
            } else if (error instanceof Error) {
                return NextResponse.json({ error: error.message }, { status: 500 });
            } else {
                return NextResponse.json({ error: "Failed to normalize group check-in wizard drafts." }, { status: 500 });
            }
        }

        if (!force && (pendingWizardDraftCount ?? 0) > 0) {
            return NextResponse.json({
                error: `Night Audit blocked. ${pendingWizardDraftCount} group check-in wizard draft(s) are still open.`,
                code: "PENDING_GROUP_CHECKIN_WIZARD_DRAFTS",
                business_date: businessDate,
                pending_group_checkin_wizard_drafts: pendingWizardDraftCount,
            }, { status: 409 });
        }

        if (force && (pendingWizardDraftCount ?? 0) > 0) {
            const { data: openDrafts, error: openDraftsError } = await supabase
                .from("group_checkin_wizard_drafts")
                .select("id, booking_group_id, business_date, current_step")
                .eq("business_date", businessDate)
                .eq("status", "draft");

            if (openDraftsError) {
                return NextResponse.json({ error: openDraftsError.message }, { status: 500 });
            }

            const { error: cancelDraftsError } = await supabase
                .from("group_checkin_wizard_drafts")
                .update({
                    status: "cancelled",
                    last_committed_at: new Date().toISOString(),
                })
                .eq("business_date", businessDate)
                .eq("status", "draft");

            if (cancelDraftsError) {
                return NextResponse.json({ error: cancelDraftsError.message }, { status: 500 });
            }

            const draftAuditRows = (openDrafts ?? []).map((draft: any) => ({
                action: "night_audit_force_cancelled_wizard_draft",
                entity_type: "booking_group",
                entity_id: String(draft.booking_group_id ?? ""),
                after_json: {
                    draft_id: String(draft.id ?? ""),
                    business_date: draft.business_date ?? businessDate,
                    current_step: Number(draft.current_step ?? 0),
                    reason: "force_eod",
                },
                business_date: draft.business_date ?? businessDate,
                source: normalizeAuditSource("night_audit"),
            })).filter((row) => row.entity_id);

            if (draftAuditRows.length > 0) {
                await supabase.from("audit_logs").insert(draftAuditRows);
            }
        }

        const { count: activeDayUseCount, error: activeDayUseError } = await supabase
            .from("reservations")
            .select("id", { count: "exact", head: true })
            .eq("is_dayuse", true)
            .eq("status", "active")
            .eq("checkin_date", businessDate)
            .eq("checkout_date", businessDate);

        if (activeDayUseError) {
            return NextResponse.json({ error: activeDayUseError.message }, { status: 500 });
        }
        if (!force && (activeDayUseCount ?? 0) > 0) {
            return NextResponse.json({
                error: `Night Audit blocked. ${activeDayUseCount} active day use session(s) must be checked out first.`,
                code: "ACTIVE_DAYUSE",
                business_date: businessDate,
                active_dayuse_count: activeDayUseCount,
            }, { status: 409 });
        }

        /* ── 1. Revenue KPIs (accrual — stay_date = businessDate) ── */
        const { data: nights, error: nightsErr } = await supabase
            .from("reservation_nights")
            .select("nightly_price, is_ota, reservation_id, reservations!inner(source, status, is_dayuse)")
            .eq("stay_date", businessDate)
            .is("cancelled_at", null)
            .neq("reservations.status", "cancelled")
            .eq("reservations.is_dayuse", false);

        if (nightsErr) return NextResponse.json({ error: nightsErr.message }, { status: 500 });

        const sources = ["walkin", "ota", "direct", "agent"] as const;
        const agg: Record<string, { nights: number; revenue: number }> = {};
        sources.forEach((s) => { agg[s] = { nights: 0, revenue: 0 }; });

        let totalRevenue = 0;
        let occupiedNights = 0;

        (nights ?? []).forEach((n) => {
            const price = Number(n.nightly_price) || 0;
            const resRow = Array.isArray(n.reservations) ? n.reservations[0] : n.reservations;
            const src = ((resRow as { source: string })?.source ?? "walkin") as typeof sources[number];
            totalRevenue += price;
            occupiedNights += 1;
            if (agg[src]) { agg[src].revenue += price; agg[src].nights += 1; }
        });

        const dayCount = 1;
        const roomNights = regularSellableRooms * dayCount;
        const occPct = roomNights > 0 ? Math.round((occupiedNights / roomNights) * 1000) / 10 : 0;
        const adr = occupiedNights > 0 ? Math.round((totalRevenue / occupiedNights) * 100) / 100 : 0;
        const revpar = roomNights > 0 ? Math.round((totalRevenue / roomNights) * 100) / 100 : 0;

        const bySource: Record<string, { nights: number; revenue: number; share_pct: number }> = {};
        sources.forEach((s) => {
            bySource[s] = {
                nights: agg[s].nights,
                revenue: agg[s].revenue,
                share_pct: totalRevenue > 0 ? Math.round((agg[s].revenue / totalRevenue) * 1000) / 10 : 0
            };
        });

        /* ── 2. Payment totals / deposits / POS (mirror Payment Daily) ── */
        const paymentDailyRequest = createNightAuditPaymentDailyRequest(businessDate);
        const paymentDailyResponse = await getPaymentDailyReport(paymentDailyRequest);
        const paymentDailyData = await paymentDailyResponse.json();
        if (!paymentDailyData?.success) {
            return NextResponse.json(
                { error: paymentDailyData?.error || "Failed to load payment daily summary." },
                { status: paymentDailyResponse.status || 500 }
            );
        }

        const payTotals = {
            cash: Math.round(Number(paymentDailyData?.grand_total?.cash?.payment ?? 0) * 100) / 100,
            transfer: Math.round(Number(paymentDailyData?.grand_total?.transfer?.payment ?? 0) * 100) / 100,
            credit_card: Math.round(Number(paymentDailyData?.grand_total?.credit_card?.payment ?? 0) * 100) / 100,
            other: Math.round(Number(paymentDailyData?.grand_total?.other?.payment ?? 0) * 100) / 100,
        };
        const paymentTotal = Math.round(
            (payTotals.cash + payTotals.transfer + payTotals.credit_card + payTotals.other) * 100
        ) / 100;

        /* ── 2b. Transfer revenue (separate from hotel — Phase 11A) ── */
        const { data: transferTxs } = await supabase
            .from("transfer_transactions")
            .select("tx_type, amount, selling_price, cost_price, margin")
            .gte("created_at", `${businessDate}T00:00:00+07:00`)
            .lt("created_at", `${businessDate}T24:00:00+07:00`);

        let transferRevenue = 0;
        let transferCost = 0;
        let transferMargin = 0;
        (transferTxs ?? []).forEach((t) => {
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

        /* ── 2c. Tip total (Phase 11A) ── */
        const { data: tips } = await supabase
            .from("tip_ledger")
            .select("amount, status")
            .gte("created_at", `${businessDate}T00:00:00+07:00`)
            .lt("created_at", `${businessDate}T24:00:00+07:00`)
            .neq("status", "reversed");

        const tipTotal = (tips ?? []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        /* ── 2d. Commission liability (pending + approved, Phase 11A) ── */
        const { data: commissions } = await supabase
            .from("commission_ledger")
            .select("commission_amount, status")
            .in("status", ["pending", "approved"]);

        const commissionLiability = (commissions ?? []).reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);

        /* ── 2e. Deposit received vs refunded + POS revenue (mirror Payment Daily) ── */
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

        /* ── 2g. No-show stats for businessDate ── */
        const { data: noShowLogs, error: noShowLogsErr } = await supabase
            .from("audit_logs")
            .select("id, after_json")
            .eq("action", "no_show")
            .eq("entity_type", "reservation")
            .eq("business_date", businessDate);

        if (noShowLogsErr) return NextResponse.json({ error: noShowLogsErr.message }, { status: 500 });

        const noShowCount = noShowLogs?.length ?? 0;
        const noShowFeeTotal = (noShowLogs ?? []).reduce((sum, row: any) => {
            const after = parseAuditJson(row?.after_json);
            return sum + (Number(after?.fee_amount) || 0);
        }, 0);

        /* ── 2h. Day-use stats (kept separate from room KPIs) ── */
        const { data: dayUsePayments, error: dayUsePaymentsError } = await supabase
            .from("folio_payments")
            .select("amount")
            .eq("paid_date", businessDate)
            .eq("tx_type", "payment")
            .eq("revenue_category", "dayuse_revenue");

        if (dayUsePaymentsError) {
            return NextResponse.json({ error: dayUsePaymentsError.message }, { status: 500 });
        }

        const dayuseRevenue = (dayUsePayments ?? []).reduce((sum, row: any) => sum + (Number(row.amount) || 0), 0);

        const { count: dayUseSessionCount, error: dayUseSessionError } = await supabase
            .from("reservations")
            .select("id", { count: "exact", head: true })
            .eq("checkin_date", businessDate)
            .eq("is_dayuse", true)
            .eq("status", "checked_out");

        if (dayUseSessionError) {
            return NextResponse.json({ error: dayUseSessionError.message }, { status: 500 });
        }

        const dayuseSessions = dayUseSessionCount ?? 0;

        /* ── 3. Upsert daily_snapshots ───────────────── */
        const { error: upsertErr } = await supabase
            .from("daily_snapshots")
            .upsert({
                business_date: businessDate,
                total_revenue: totalRevenue,
                occupied_nights: occupiedNights,
                room_nights: roomNights,
                occupancy_pct: occPct,
                adr,
                revpar,
                by_source: bySource,
                payment_cash: payTotals.cash,
                payment_transfer: payTotals.transfer,
                payment_card: payTotals.credit_card,
                payment_other: payTotals.other,
                payment_total: paymentTotal,
                // ★ Phase 11A: New snapshot fields
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
                dayuse_revenue: Math.round(dayuseRevenue * 100) / 100,
                dayuse_sessions: dayuseSessions,
                is_eod_closed: true,
                eod_run_at: new Date().toISOString(),
                notes: notes ?? null
            }, { onConflict: "business_date" });

        if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

        let stockSnapshotResult: any = null;
        let stockSnapshotWarning: string | null = null;
        try {
            stockSnapshotResult = await computeStockSnapshot(supabase, businessDate);
        } catch (stockErr) {
            stockSnapshotWarning = stockErr instanceof Error ? stockErr.message : "Stock snapshot compute failed.";
            console.error("EOD stock snapshot compute failed", stockErr);
        }

        let linenSnapshotResult: any = null;
        let linenSnapshotWarning: string | null = null;
        try {
            linenSnapshotResult = await computeLinenDailySnapshot(supabase, businessDate, {
                reason: "EOD auto snapshot",
            });
        } catch (linenErr) {
            linenSnapshotWarning = linenErr instanceof Error ? linenErr.message : "Linen snapshot compute failed.";
            console.error("EOD linen snapshot compute failed", linenErr);
        }

        /* ── 4. Advance business_date ────────────────── */
        const nextDate = new Date(businessDate + "T00:00:00");
        nextDate.setDate(nextDate.getDate() + 1);
        const newBusinessDate = toLocalDate(nextDate);

        const { error: advanceErr } = await supabase
            .from("hotel_settings")
            .update({ business_date: newBusinessDate, updated_at: new Date().toISOString() })
            .eq("id", 1);

        if (advanceErr) return NextResponse.json({ error: advanceErr.message }, { status: 500 });

        return NextResponse.json({
            success: true,
            closed_date: businessDate,
            new_business_date: newBusinessDate,
            stock_snapshot: stockSnapshotResult,
            stock_snapshot_warning: stockSnapshotWarning,
            linen_snapshot: linenSnapshotResult ? {
                id: linenSnapshotResult.id,
                business_date: linenSnapshotResult.business_date,
                computed_at: linenSnapshotResult.computed_at,
                totals: linenSnapshotResult.totals,
            } : null,
            linen_snapshot_warning: linenSnapshotWarning,
            snapshot: {
                total_revenue: Math.round(totalRevenue * 100) / 100,
                occupied_nights: occupiedNights,
                room_nights: roomNights,
                occupancy_pct: occPct,
                adr,
                revpar,
                payment_total: Math.round(paymentTotal * 100) / 100,
                payment_cash: Math.round(payTotals.cash * 100) / 100,
                payment_transfer: Math.round(payTotals.transfer * 100) / 100,
                payment_card: Math.round(payTotals.credit_card * 100) / 100,
                payment_other: Math.round(payTotals.other * 100) / 100,
                by_source: bySource,
                by_payment: { ...payTotals, total: paymentTotal },
                // ★ Phase 11A
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
                dayuse_revenue: Math.round(dayuseRevenue * 100) / 100,
                dayuse_sessions: dayuseSessions,
            }
        });

    } catch (err) {
        return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
}
