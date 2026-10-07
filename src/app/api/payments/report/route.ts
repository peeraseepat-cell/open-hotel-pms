import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import {
  PAYMENT_REPORT_CATEGORIES,
  PAYMENT_REPORT_METHOD_KEYS,
  PaymentReportCategory,
  PaymentReportExcludedReason,
  PaymentReportMethodKey,
  PaymentReportRow,
  PaymentReportTxType,
  applyPaymentReportMovement,
  buildPaymentReportPolicyFeeDedupKey,
  buildPaymentReportVoidedIdSet,
  createPaymentReportMethodsMap,
  finalizePaymentReportMethods,
  isPaymentReportDepositRefundEntry,
  isPaymentReportLinkedDepositTransferEntry,
  isPaymentReportPosDepositRecord,
  normalizePaymentReportCategory,
  normalizePaymentReportMethod,
  normalizePaymentReportTxType,
  resolvePaymentReportBusinessDates,
  round2,
} from "@/lib/payment-reporting";
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";

type SummaryBreakdown = {
  grand_total: number;
  grand_refunds: number;
  net_total: number;
  tx_count: number;
};

type ExcludedBreakdownRow = {
  reason: PaymentReportExcludedReason;
  label: string;
  count: number;
  amount: number;
};

function chunkArray<T>(items: T[], size = 200): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function countTowardsPaymentDailyNet(
  txType: PaymentReportTxType,
  amount: number,
  isAdvanceDeposit: boolean
): number {
  if (txType === "refund") return -amount;
  if (txType === "deposit") return isAdvanceDeposit ? amount : 0;
  return amount;
}

function excludedReasonLabel(reason: PaymentReportExcludedReason): string {
  if (reason === "void_pair") return "Void Pair";
  if (reason === "record_only") return "Record-only";
  if (reason === "deposit_refund_separate") return "Deposit Refund";
  if (reason === "paid_by_deposit_trace") return "Paid by Deposit Trace";
  if (reason === "linked_deposit_transfer") return "Linked Deposit Transfer";
  return "Policy Fee Duplicate";
}

function emptySummary(): SummaryBreakdown {
  return { grand_total: 0, grand_refunds: 0, net_total: 0, tx_count: 0 };
}

export async function GET(request: NextRequest) {
  noStore();
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);

    const startDate = (searchParams.get("start") ?? "").trim();
    const endDate = (searchParams.get("end") ?? "").trim();

    const { resolveBusinessDate } = await import("@/lib/folio-fees");
    const fallbackDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    const businessDate = await resolveBusinessDate(supabase, fallbackDate);
    const effectiveStart = startDate || businessDate;
    const effectiveEnd = endDate || businessDate;

    const {
      calendarDate,
      currentBusinessDate,
      scopedDates,
      countedDateAlias,
    } = await resolvePaymentReportBusinessDates(supabase, effectiveStart, effectiveEnd);
    const spilloverIncluded = countedDateAlias.size > 0;

    const [paymentsRes, posOrdersRes] = await Promise.all([
      supabase
        .from("folio_payments")
        .select("id, reservation_id, pos_order_id, paid_date, paid_at, method, tx_type, amount, note, revenue_category, cashier_name, is_record_only, is_correction, is_void_reversal, void_of")
        .in("paid_date", scopedDates)
        .order("paid_date", { ascending: true })
        .order("paid_at", { ascending: true }),
      supabase
        .from("pos_orders")
        .select("id, order_date, total, payment_method")
        .eq("status", "completed")
        .eq("order_type", "walkin")
        .in("order_date", scopedDates)
        .order("order_date", { ascending: true }),
    ]);

    if (paymentsRes.error) {
      return NextResponse.json({ success: false, error: paymentsRes.error.message }, { status: 500 });
    }
    if (posOrdersRes.error) {
      return NextResponse.json({ success: false, error: posOrdersRes.error.message }, { status: 500 });
    }

    const rows = (paymentsRes.data ?? []) as PaymentReportRow[];
    const scopedPaymentIds = rows
      .map((row) => String(row.id ?? "").trim())
      .filter(Boolean);
    const laterVoidedOriginalIds = new Set<string>();
    if (scopedPaymentIds.length > 0) {
      for (const chunk of chunkArray(scopedPaymentIds)) {
        const { data: laterVoidRows, error: laterVoidError } = await supabase
          .from("folio_payments")
          .select("id, void_of")
          .eq("is_void_reversal", true)
          .in("void_of", chunk);
        if (laterVoidError) {
          return NextResponse.json({ success: false, error: laterVoidError.message }, { status: 500 });
        }
        for (const row of laterVoidRows ?? []) {
          const originalId = String((row as { void_of?: string | null }).void_of ?? "").trim();
          if (originalId) laterVoidedOriginalIds.add(originalId);
        }
      }
    }
    const voidedIds = buildPaymentReportVoidedIdSet(rows, laterVoidedOriginalIds);

    const policyExtraChargeKeys = new Set<string>();
    for (const row of rows) {
      const txType = normalizePaymentReportTxType(row.tx_type);
      const category = String(row.revenue_category ?? "").trim().toLowerCase();
      const note = String(row.note ?? "").trim().toLowerCase();
      if (txType === "payment" && category === "extra_charge" && note.includes("fee")) {
        policyExtraChargeKeys.add(buildPaymentReportPolicyFeeDedupKey(row));
      }
    }

    const reservationIds = Array.from(
      new Set(rows.map((row) => String(row.reservation_id ?? "").trim()).filter(Boolean))
    );
    const reservationContextById = new Map<
      string,
      {
        checkin_date: string | null;
        source: string | null;
        parent_reservation_id: string | null;
        deposit_note: string | null;
      }
    >();
    if (reservationIds.length > 0) {
      for (const chunk of chunkArray(reservationIds)) {
        const { data: reservationRows, error: reservationError } = await supabase
          .from("reservations")
          .select("id, checkin_date, source, parent_reservation_id, deposit_note")
          .in("id", chunk);
        if (reservationError) {
          return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
        }
        for (const row of reservationRows ?? []) {
          const reservationId = String((row as { id?: string | null }).id ?? "").trim();
          if (!reservationId) continue;
          reservationContextById.set(reservationId, {
            checkin_date: (row as { checkin_date?: string | null }).checkin_date ?? null,
            source: (row as { source?: string | null }).source ?? null,
            parent_reservation_id: (row as { parent_reservation_id?: string | null }).parent_reservation_id ?? null,
            deposit_note: (row as { deposit_note?: string | null }).deposit_note ?? null,
          });
        }
      }
    }

    const countedMethods = createPaymentReportMethodsMap();
    const countedCategoryMap = Object.fromEntries(
      PAYMENT_REPORT_CATEGORIES.map((category) => [
        category,
        { category, inflow: 0, refunds: 0, net: 0 },
      ])
    ) as Record<PaymentReportCategory, { category: PaymentReportCategory; inflow: number; refunds: number; net: number }>;
    const countedByDayMap: Record<
      string,
      {
        date: string;
        cash: number;
        transfer: number;
        credit_card: number;
        other: number;
        total_inflow: number;
        refunds: number;
        net: number;
        tx_count: number;
      }
    > = {};
    const countedSummary = emptySummary();
    const allPostedSummary = emptySummary();
    const excludedMap = new Map<PaymentReportExcludedReason, { count: number; amount: number }>();

    const depositRowsByReservation = new Map<
      string,
      Array<{ method: PaymentReportMethodKey; amount: number; tx_type: string; paid_date: string }>
    >();

    function ensureDay(date: string) {
      if (!countedByDayMap[date]) {
        countedByDayMap[date] = {
          date,
          cash: 0,
          transfer: 0,
          credit_card: 0,
          other: 0,
          total_inflow: 0,
          refunds: 0,
          net: 0,
          tx_count: 0,
        };
      }
      return countedByDayMap[date];
    }

    function addExcluded(reason: PaymentReportExcludedReason, amount: number) {
      const current = excludedMap.get(reason) ?? { count: 0, amount: 0 };
      current.count += 1;
      current.amount += amount;
      excludedMap.set(reason, current);
    }

    for (const row of rows) {
      const paidDate = String(row.paid_date ?? effectiveStart);
      const countedDate = countedDateAlias.get(paidDate) ?? paidDate;
      const rawMethod = normalizePaymentReportMethod(row.method);
      const rawTxType = normalizePaymentReportTxType(row.tx_type);
      const amount = Number(row.amount ?? 0);
      const note = String(row.note ?? "").trim();
      const category = normalizePaymentReportCategory(row.revenue_category, rawTxType, row.note);
      const reservationId = String(row.reservation_id ?? "").trim();
      const reservationContext = reservationContextById.get(reservationId);
      const reservationCheckinDate = String(reservationContext?.checkin_date ?? "").trim();
      const isLinkedDepositTransfer = isPaymentReportLinkedDepositTransferEntry(row, reservationContext);
      const isAdvanceDeposit =
        rawTxType === "deposit" &&
        !isPaymentReportPosDepositRecord(rawTxType, String(category), note) &&
        reservationCheckinDate > countedDate;

      if (rawTxType === "refund") allPostedSummary.grand_refunds += amount;
      else allPostedSummary.grand_total += amount;
      allPostedSummary.tx_count += 1;

      if (category === "deposit" && reservationId && !isLinkedDepositTransfer) {
        const current = depositRowsByReservation.get(reservationId) ?? [];
        current.push({
          method: rawMethod,
          amount,
          tx_type: rawTxType,
          paid_date: paidDate,
        });
        depositRowsByReservation.set(reservationId, current);
      }

      const isPosDeposit = isPaymentReportPosDepositRecord(rawTxType, String(category), note);
      const isPosRemainder =
        rawTxType === "payment" &&
        String(category) === "pos_revenue" &&
        note.toLowerCase().includes("pos remainder");
      const isRecordOnly = row.is_record_only === true && !isPosDeposit && !isPosRemainder;
      const paymentId = String(row.id ?? "").trim();

      let excludedReason: PaymentReportExcludedReason | null = null;
      if (row.is_void_reversal === true || (paymentId && voidedIds.has(paymentId))) {
        excludedReason = "void_pair";
      } else if (isRecordOnly) {
        excludedReason = "record_only";
      } else if (isLinkedDepositTransfer) {
        excludedReason = "linked_deposit_transfer";
      } else if (
        String(category) === "deposit" &&
        (note.toLowerCase().includes("paid by deposit") || note.toLowerCase().includes("void return to deposit"))
      ) {
        excludedReason = "paid_by_deposit_trace";
      } else if (isPaymentReportDepositRefundEntry(rawTxType, String(category), note)) {
        excludedReason = "deposit_refund_separate";
      } else if (
        rawTxType === "payment" &&
        String(category) === "room_revenue" &&
        policyExtraChargeKeys.has(buildPaymentReportPolicyFeeDedupKey(row))
      ) {
        excludedReason = "policy_fee_duplicate";
      }

      if (excludedReason) {
        addExcluded(excludedReason, amount);
        continue;
      }

      const method = isPosDeposit ? "cash" : rawMethod;
      const txType: PaymentReportTxType = isPosDeposit ? "payment" : rawTxType;
      const netContribution = countTowardsPaymentDailyNet(txType, amount, isAdvanceDeposit);
      applyPaymentReportMovement(countedMethods, method, txType, amount);

      const day = ensureDay(countedDate);
      if (txType === "refund") {
        countedSummary.grand_refunds += amount;
        countedCategoryMap[category].refunds += amount;
        day.refunds += amount;
      } else {
        countedSummary.grand_total += amount;
        countedCategoryMap[category].inflow += amount;
        day[method] += amount;
        day.total_inflow += amount;
      }
      countedSummary.net_total += netContribution;
      countedSummary.tx_count += 1;
      countedCategoryMap[category].net = round2(
        countedCategoryMap[category].inflow - countedCategoryMap[category].refunds
      );
      day.net += netContribution;
      day.tx_count += 1;
    }

    for (const posOrder of (posOrdersRes.data ?? []) as Array<{ id: string; order_date: string | null; total: number | null; payment_method: string | null }>) {
      const paidDate = String(posOrder.order_date ?? effectiveStart);
      const countedDate = countedDateAlias.get(paidDate) ?? paidDate;
      const method = normalizePaymentReportMethod(posOrder.payment_method);
      const amount = Number(posOrder.total ?? 0);
      applyPaymentReportMovement(countedMethods, method, "payment", amount);
      countedSummary.grand_total += amount;
      countedSummary.tx_count += 1;
      countedCategoryMap.pos_revenue.inflow += amount;
      countedCategoryMap.pos_revenue.net = round2(
        countedCategoryMap.pos_revenue.inflow - countedCategoryMap.pos_revenue.refunds
      );
      const day = ensureDay(countedDate);
      day[method] += amount;
      day.total_inflow += amount;
      day.net += amount;
      day.tx_count += 1;

      allPostedSummary.grand_total += amount;
      allPostedSummary.tx_count += 1;
    }

    countedSummary.net_total = round2(countedSummary.net_total);
    allPostedSummary.net_total = round2(allPostedSummary.grand_total - allPostedSummary.grand_refunds);

    const byMethodSummary = PAYMENT_REPORT_METHOD_KEYS.map((method) => {
      const row = finalizePaymentReportMethods(countedMethods)[method];
      const gross = row.payment + row.deposit;
      const sharePct = countedSummary.grand_total > 0
        ? Number(((gross / countedSummary.grand_total) * 100).toFixed(1))
        : 0;
      return { method, ...row, total: row.payment, share_pct: sharePct };
    });

    const byCategorySummary = PAYMENT_REPORT_CATEGORIES.map((category) => {
      const row = countedCategoryMap[category];
      return {
        category,
        inflow: round2(row.inflow),
        refunds: round2(row.refunds),
        net: round2(row.net),
      };
    });

    const byDay = Object.values(countedByDayMap)
      .map((row) => ({
        ...row,
        cash: round2(row.cash),
        transfer: round2(row.transfer),
        credit_card: round2(row.credit_card),
        other: round2(row.other),
        total_inflow: round2(row.total_inflow),
        refunds: round2(row.refunds),
        net: round2(row.net),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const excludedBreakdown: ExcludedBreakdownRow[] = Array.from(excludedMap.entries())
      .map(([reason, value]) => ({
        reason,
        label: excludedReasonLabel(reason),
        count: value.count,
        amount: round2(value.amount),
      }))
      .sort((a, b) => b.amount - a.amount);

    const depositMethodMismatches: Array<{
      reservation_id: string;
      deposit_method: string;
      refund_method: string;
      deposit_amount: number;
      refund_amount: number;
      deposit_date: string;
      refund_date: string;
      note: string;
    }> = [];

    for (const [reservationId, items] of depositRowsByReservation.entries()) {
      const deposits = items.filter((item) => item.tx_type === "deposit");
      const refunds = items.filter((item) => item.tx_type === "refund");
      for (const deposit of deposits) {
        for (const refund of refunds) {
          if (deposit.method === refund.method) continue;
          depositMethodMismatches.push({
            reservation_id: reservationId,
            deposit_method: deposit.method,
            refund_method: refund.method,
            deposit_amount: round2(deposit.amount),
            refund_amount: round2(refund.amount),
            deposit_date: deposit.paid_date,
            refund_date: refund.paid_date,
            note: `Deposit via ${deposit.method} but refunded via ${refund.method}`,
          });
        }
      }
    }

    return NextResponse.json(
      {
        success: true,
        business_date: currentBusinessDate,
        calendar_date: calendarDate,
        spillover_included: spilloverIncluded,
        start_date: effectiveStart,
        end_date: effectiveEnd,
        summary: countedSummary,
        summary_counted: countedSummary,
        summary_all_posted: allPostedSummary,
        by_method: byMethodSummary,
        by_method_counted: byMethodSummary,
        by_category: byCategorySummary,
        by_category_counted: byCategorySummary,
        by_day: byDay,
        by_day_counted: byDay,
        excluded_breakdown: excludedBreakdown,
        deposit_method_mismatches: depositMethodMismatches,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("api/payments/report GET failed", err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
