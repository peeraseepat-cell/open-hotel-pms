import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import {
  PaymentReportExcludedReason,
  PaymentReportRow,
  buildPaymentReportPolicyFeeDedupKey,
  buildPaymentReportVoidedIdSet,
  isPaymentReportDepositRefundEntry,
  isPaymentReportLinkedDepositTransferEntry,
  isPaymentReportPosDepositRecord,
  normalizePaymentReportCategory,
  normalizePaymentReportMethod,
  normalizePaymentReportTxType,
  resolvePaymentReportBusinessDates,
  round2,
  toBangkokDateString,
} from "@/lib/payment-reporting";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  start: z.string().regex(dateRegex, "start must be YYYY-MM-DD").optional(),
  end: z.string().regex(dateRegex, "end must be YYYY-MM-DD").optional(),
  reservation_id: z.string().uuid().optional(),
});

type ReservationNightRoom = {
  stay_date: string;
  room_number: string | null;
};

function chunkArray<T>(items: T[], size = 200): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function countTowardsPaymentDailyNet(
  txType: "payment" | "refund" | "deposit",
  amount: number,
  isAdvanceDeposit: boolean
): number {
  if (txType === "refund") return -amount;
  if (txType === "deposit") return isAdvanceDeposit ? amount : 0;
  return amount;
}

function excludedReasonLabel(reason: PaymentReportExcludedReason): string {
  if (reason === "void_pair") return "Voided";
  if (reason === "record_only") return "Record-only";
  if (reason === "deposit_refund_separate") return "Deposit Refund";
  if (reason === "paid_by_deposit_trace") return "Paid by Deposit Trace";
  if (reason === "linked_deposit_transfer") return "Linked Deposit Transfer";
  return "Policy Fee Duplicate";
}

function resolveRoomNumberForDate(nights: ReservationNightRoom[] | undefined, targetDate: string): string | null {
  if (!nights || nights.length === 0) return null;

  const exact = nights.find((night) => night.stay_date === targetDate && night.room_number);
  if (exact?.room_number) return exact.room_number;

  let latest: ReservationNightRoom | null = null;
  for (const night of nights) {
    if (night.stay_date <= targetDate && (!latest || night.stay_date > latest.stay_date)) {
      latest = night;
    }
  }
  return latest?.room_number ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const parsed = querySchema.safeParse({
      start: request.nextUrl.searchParams.get("start") ?? undefined,
      end: request.nextUrl.searchParams.get("end") ?? undefined,
      reservation_id: request.nextUrl.searchParams.get("reservation_id") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;

    const { resolveBusinessDate } = await import("@/lib/folio-fees");
    const fallbackDate = toBangkokDateString();
    const businessDate = await resolveBusinessDate(supabase, fallbackDate);
    const startDate = parsed.data.start ?? businessDate;
    const endDate = parsed.data.end ?? businessDate;
    const {
      calendarDate,
      currentBusinessDate,
      scopedDates,
      countedDateAlias,
    } = await resolvePaymentReportBusinessDates(supabase, startDate, endDate);

    let paymentsQuery = supabase
      .from("folio_payments")
      .select("id, reservation_id, pos_order_id, paid_date, paid_at, method, tx_type, amount, note, revenue_category, cashier_name, is_record_only, is_correction, is_void_reversal, void_of")
      .in("paid_date", scopedDates)
      .order("paid_date", { ascending: true })
      .order("paid_at", { ascending: true });

    if (parsed.data.reservation_id) {
      paymentsQuery = paymentsQuery.eq("reservation_id", parsed.data.reservation_id);
    }

    const [paymentsRes, posOrdersRes] = await Promise.all([
      paymentsQuery,
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

    const paymentRows = (paymentsRes.data ?? []) as PaymentReportRow[];
    const scopedPaymentIds = paymentRows
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
    const voidedIds = buildPaymentReportVoidedIdSet(paymentRows, laterVoidedOriginalIds);

    const policyExtraChargeKeys = new Set<string>();
    for (const row of paymentRows) {
      const txType = normalizePaymentReportTxType(row.tx_type);
      const category = String(row.revenue_category ?? "").trim().toLowerCase();
      const note = String(row.note ?? "").trim().toLowerCase();
      if (txType === "payment" && category === "extra_charge" && note.includes("fee")) {
        policyExtraChargeKeys.add(buildPaymentReportPolicyFeeDedupKey(row));
      }
    }

    const reservationIds = Array.from(
      new Set(paymentRows.map((row) => String(row.reservation_id ?? "")).filter(Boolean))
    );

    const reservationMap = new Map<
      string,
      {
        booking_code: string | null;
        guest_name: string | null;
        guest_profile_id: string | null;
        checkin_date: string | null;
        source: string | null;
        parent_reservation_id: string | null;
        deposit_note: string | null;
      }
    >();
    const nightsByReservation = new Map<string, ReservationNightRoom[]>();

    if (reservationIds.length > 0) {
      for (const chunk of chunkArray(reservationIds)) {
        const [reservationsRes, nightsRes] = await Promise.all([
          supabase
            .from("reservations")
            .select("id, booking_code, guest_name, guest_profile_id, checkin_date, source, parent_reservation_id, deposit_note")
            .in("id", chunk),
          supabase
            .from("reservation_nights")
            .select("reservation_id, stay_date, rooms:room_id(room_number)")
            .in("reservation_id", chunk)
            .lte("stay_date", endDate)
            .is("cancelled_at", null),
        ]);

        if (reservationsRes.error) {
          return NextResponse.json({ success: false, error: reservationsRes.error.message }, { status: 500 });
        }
        if (nightsRes.error) {
          return NextResponse.json({ success: false, error: nightsRes.error.message }, { status: 500 });
        }

        for (const row of reservationsRes.data ?? []) {
          reservationMap.set(String(row.id), {
            booking_code: row.booking_code ? String(row.booking_code) : null,
            guest_name: row.guest_name ? String(row.guest_name) : null,
            guest_profile_id: row.guest_profile_id ? String(row.guest_profile_id) : null,
            checkin_date: row.checkin_date ? String(row.checkin_date) : null,
            source: row.source ? String(row.source) : null,
            parent_reservation_id: row.parent_reservation_id ? String(row.parent_reservation_id) : null,
            deposit_note: row.deposit_note ? String(row.deposit_note) : null,
          });
        }

        for (const row of (nightsRes.data ?? []) as any[]) {
          const reservationId = String(row.reservation_id ?? "");
          if (!reservationId) continue;
          const roomRef = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
          const next: ReservationNightRoom = {
            stay_date: String(row.stay_date ?? ""),
            room_number: roomRef?.room_number ? String(roomRef.room_number) : null,
          };
          const current = nightsByReservation.get(reservationId);
          if (current) current.push(next);
          else nightsByReservation.set(reservationId, [next]);
        }
      }
    }

    const grouped = new Map<
      string,
      {
        reservation_id: string;
        booking_code: string | null;
        guest_name: string | null;
        guest_profile_id: string | null;
        room_number: string | null;
        totals: { inflow: number; refunds: number; net: number };
        audit_totals: { inflow: number; refunds: number; net: number };
        entries: Array<Record<string, unknown>>;
      }
    >();

    function ensureGroup(input: {
      reservationId: string;
      bookingCode: string | null;
      guestName: string | null;
      guestProfileId: string | null;
      roomNumber: string | null;
    }) {
      const key = input.reservationId || `walkin:${input.roomNumber ?? "NA"}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          reservation_id: input.reservationId,
          booking_code: input.bookingCode,
          guest_name: input.guestName,
          guest_profile_id: input.guestProfileId,
          room_number: input.roomNumber,
          totals: { inflow: 0, refunds: 0, net: 0 },
          audit_totals: { inflow: 0, refunds: 0, net: 0 },
          entries: [],
        });
      }
      return grouped.get(key)!;
    }

    for (const row of paymentRows) {
      const reservationId = String(row.reservation_id ?? "");
      const reservation = reservationMap.get(reservationId);
      const actualPaidDate = String(row.paid_date ?? startDate);
      const countedPaidDate = countedDateAlias.get(actualPaidDate) ?? actualPaidDate;
      const rawAmount = Number(row.amount ?? 0);
      const rawTxType = normalizePaymentReportTxType(row.tx_type);
      const rawCategory = normalizePaymentReportCategory(row.revenue_category, rawTxType, row.note);
      const note = String(row.note ?? "").trim();
      const isAdvanceDeposit =
        rawTxType === "deposit" &&
        !isPaymentReportPosDepositRecord(rawTxType, String(rawCategory), note) &&
        String(reservation?.checkin_date ?? "").trim() > countedPaidDate;
      const roomNumber = reservationId
        ? resolveRoomNumberForDate(nightsByReservation.get(reservationId), countedPaidDate)
        : null;
      const rawSignedAmount = rawTxType === "refund" ? -rawAmount : rawAmount;

      const target = ensureGroup({
        reservationId,
        bookingCode: reservation?.booking_code ?? null,
        guestName: reservation?.guest_name ?? null,
        guestProfileId: reservation?.guest_profile_id ?? null,
        roomNumber,
      });
      if (!target.room_number && roomNumber) target.room_number = roomNumber;

      if (rawTxType === "refund") target.audit_totals.refunds += rawAmount;
      else target.audit_totals.inflow += rawAmount;
      target.audit_totals.net += rawSignedAmount;

      const isPosDeposit = isPaymentReportPosDepositRecord(rawTxType, String(rawCategory), note);
      const isPosRemainder =
        rawTxType === "payment" &&
        String(rawCategory) === "pos_revenue" &&
        note.toLowerCase().includes("pos remainder");
      const isRecordOnly = row.is_record_only === true && !isPosDeposit && !isPosRemainder;
      const isLinkedDepositTransfer = isPaymentReportLinkedDepositTransferEntry(row, reservation);

      let excludedReason: PaymentReportExcludedReason | null = null;
      const paymentId = String(row.id ?? "").trim();
      if (row.is_void_reversal === true || (paymentId && voidedIds.has(paymentId))) {
        excludedReason = "void_pair";
      } else if (isRecordOnly) {
        excludedReason = "record_only";
      } else if (isLinkedDepositTransfer) {
        excludedReason = "linked_deposit_transfer";
      } else if (
        String(rawCategory) === "deposit" &&
        (note.toLowerCase().includes("paid by deposit") || note.toLowerCase().includes("void return to deposit"))
      ) {
        excludedReason = "paid_by_deposit_trace";
      } else if (isPaymentReportDepositRefundEntry(rawTxType, String(rawCategory), note)) {
        excludedReason = "deposit_refund_separate";
      } else if (
        rawTxType === "payment" &&
        String(rawCategory) === "room_revenue" &&
        policyExtraChargeKeys.has(buildPaymentReportPolicyFeeDedupKey(row))
      ) {
        excludedReason = "policy_fee_duplicate";
      }

      const countedMethod = isPosDeposit ? "cash" : normalizePaymentReportMethod(row.method);
      const countedTxType = isPosDeposit ? "payment" : rawTxType;
      const countedSignedAmount = countTowardsPaymentDailyNet(countedTxType, rawAmount, isAdvanceDeposit);
      const countedInTotals = excludedReason === null;

      if (countedInTotals) {
        if (countedTxType === "refund") target.totals.refunds += rawAmount;
        else target.totals.inflow += rawAmount;
        target.totals.net += countedSignedAmount;
      }

      target.entries.push({
        id: row.id,
        source_type: "folio_payment",
        counted_in_totals: countedInTotals,
        excluded_reason: excludedReason,
        excluded_reason_label: excludedReason ? excludedReasonLabel(excludedReason) : null,
        paid_date: actualPaidDate,
        counted_date: countedPaidDate,
        paid_at: row.paid_at,
        tx_type: rawTxType,
        display_tx_type: countedTxType,
        method: normalizePaymentReportMethod(row.method),
        display_method: countedMethod,
        revenue_category: rawCategory,
        amount: round2(rawAmount),
        signed_amount: round2(rawSignedAmount),
        counted_signed_amount: round2(countedSignedAmount),
        cashier_name: row.cashier_name ?? null,
        note: row.note ?? null,
        room_number: roomNumber,
        is_record_only: row.is_record_only === true,
        is_correction: row.is_correction === true,
        is_void_reversal: row.is_void_reversal === true,
      });
    }

    for (const posOrder of (posOrdersRes.data ?? []) as Array<{ id: string; order_date: string | null; total: number | null; payment_method: string | null }>) {
      const paidDate = String(posOrder.order_date ?? startDate);
      const countedPaidDate = countedDateAlias.get(paidDate) ?? paidDate;
      const amount = Number(posOrder.total ?? 0);
      const method = normalizePaymentReportMethod(posOrder.payment_method);
      const target = ensureGroup({
        reservationId: "",
        bookingCode: "WALK-IN POS",
        guestName: "Walk-in POS",
        guestProfileId: null,
        roomNumber: null,
      });

      target.audit_totals.inflow += amount;
      target.audit_totals.net += amount;
      target.totals.inflow += amount;
      target.totals.net += amount;

      target.entries.push({
        id: `walkin-pos-${posOrder.id}`,
        source_type: "pos_order",
        counted_in_totals: true,
        excluded_reason: null,
        excluded_reason_label: null,
        paid_date: paidDate,
        counted_date: countedPaidDate,
        paid_at: null,
        tx_type: "payment",
        display_tx_type: "payment",
        method,
        display_method: method,
        revenue_category: "pos_revenue",
        amount: round2(amount),
        signed_amount: round2(amount),
        counted_signed_amount: round2(amount),
        cashier_name: null,
        note: "Walk-in POS settlement",
        room_number: null,
        is_record_only: false,
        is_correction: false,
        is_void_reversal: false,
      });
    }

    const reservations = Array.from(grouped.values())
      .map((group) => ({
        ...group,
        totals: {
          inflow: round2(group.totals.inflow),
          refunds: round2(group.totals.refunds),
          net: round2(group.totals.net),
        },
        audit_totals: {
          inflow: round2(group.audit_totals.inflow),
          refunds: round2(group.audit_totals.refunds),
          net: round2(group.audit_totals.net),
        },
        entries: group.entries.sort((a, b) => {
          const left = String(a.paid_at ?? a.paid_date ?? "");
          const right = String(b.paid_at ?? b.paid_date ?? "");
          return left.localeCompare(right);
        }),
      }))
      .sort((a, b) => {
        const roomA = a.room_number ?? "ZZZ";
        const roomB = b.room_number ?? "ZZZ";
        if (roomA !== roomB) return roomA.localeCompare(roomB, undefined, { numeric: true, sensitivity: "base" });
        return (a.booking_code ?? "").localeCompare(b.booking_code ?? "", undefined, { sensitivity: "base" });
      });

    return NextResponse.json({
      success: true,
      business_date: currentBusinessDate,
      calendar_date: calendarDate,
      start_date: startDate,
      end_date: endDate,
      reservations,
    });
  } catch (err) {
    console.error("api/payments/detail GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
