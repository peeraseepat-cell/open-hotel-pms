/**
 * Admin Corrections — Core business logic (Phase 42)
 *
 * Design principle: Compensating Entry (not soft-delete)
 * Every void/adjustment inserts a new folio_payments row.
 * Existing outstanding/revenue queries work without modification.
 *
 * Future consideration: FO self-service void within 1 hour window
 * (not implemented yet — admin-only for initial release)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdminCorrectionAction,
  AdminCorrectionRecord,
  PaymentMethod,
} from "@/lib/types";
import {
  buildDepositSnapshotNote,
  computeHeldDepositFromRows,
  extractDepositGeneralNote,
} from "@/lib/deposit-ledger";
import { computeCheckoutNetPaidSatang, computeExtraChargeNetSatang } from "@/lib/checkout-balance";
import { fromSatang, toSatang } from "@/lib/money";
import { resolveBusinessDate, toLocalDate } from "@/lib/folio-fees";
import { assertRoomAvailableForDateRange, PlannedRoomMoveError } from "@/lib/planned-room-moves";
import { assertRoomTypeCapacityForDateRange } from "@/lib/room-type-capacity";
import { computeReservationDiscountAmount } from "@/lib/reservation-discount";

// ─── Helpers ───────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function affectsDepositLedger(payment: Pick<FolioPaymentRow, "tx_type" | "revenue_category" | "note">): boolean {
  const category = String(payment.revenue_category ?? "").toLowerCase();
  const note = String(payment.note ?? "").toLowerCase();
  return (
    payment.tx_type === "deposit"
    || category === "deposit"
    || note.includes("deposit refund")
    || note.includes("paid by deposit")
    || note.includes("void return to deposit")
  );
}

async function syncReservationDepositLedger(
  supabase: SupabaseClient,
  reservationId: string
): Promise<void> {
  const reservation = await loadReservationWithFolioFlag(supabase, reservationId, [
    "deposit_note",
    "deposit_amount",
    "deposit_paid_at",
  ]);

  const { data: allDepositRows, error: allDepositRowsError } = await supabase
    .from("folio_payments")
    .select("method, amount, note, paid_at, tx_type, revenue_category")
    .eq("reservation_id", reservationId)
    .in("tx_type", ["payment", "refund", "deposit"])
    .order("paid_at", { ascending: true });

  if (allDepositRowsError) {
    throw new AdminCorrectionError(`Failed to refresh deposit ledger: ${allDepositRowsError.message}`, 500);
  }

  const depositCategoryRows = (allDepositRows ?? []).filter(
    (row: any) => String(row.revenue_category ?? "").toLowerCase() === "deposit"
  );
  const generalNote = extractDepositGeneralNote(reservation.deposit_note);
  const netByMethod = new Map<string, { method: string; amount: number; note: string | null }>();

  for (const row of depositCategoryRows) {
    const method = String(row.method ?? "cash");
    const current = netByMethod.get(method) ?? { method, amount: 0, note: null };
    const amount = fromSatang(toSatang(row.amount ?? 0));
    if (row.tx_type === "deposit" || row.tx_type === "payment") current.amount += amount;
    else if (row.tx_type === "refund") current.amount -= amount;
    if (!current.note && typeof row.note === "string" && row.note.trim()) {
      current.note = row.note.trim();
    }
    netByMethod.set(method, current);
  }

  const activeLines = Array.from(netByMethod.values()).filter((line) => line.amount > 0);
  const nextDepositAmount = computeHeldDepositFromRows(allDepositRows ?? []);
  const nextPaidAt =
    depositCategoryRows.some((row: any) => row.tx_type === "deposit" || row.tx_type === "payment")
      ? String(
        [...depositCategoryRows]
          .filter((row: any) => row.tx_type === "deposit" || row.tx_type === "payment")
          .slice(-1)[0]?.paid_at ?? ""
      ) || null
      : null;
  const nextDepositNote = buildDepositSnapshotNote(
    activeLines,
    nextDepositAmount > 0 ? null : generalNote
  );

  const { error: updateError } = await supabase
    .from("reservations")
    .update({
      deposit_amount: nextDepositAmount,
      deposit_paid_at: nextPaidAt,
      deposit_note: nextDepositNote,
      updated_at: nowISO(),
    })
    .eq("id", reservationId);

  if (updateError) {
    throw new AdminCorrectionError(`Failed to sync deposit ledger: ${updateError.message}`, 500);
  }
}

async function resolveCorrectionBusinessDate(supabase: SupabaseClient): Promise<string> {
  return resolveBusinessDate(supabase as any, toLocalDate(new Date(), "Asia/Bangkok"));
}

/**
 * Defensive reservation loader — handles case where folio_reopened column
 * may not exist yet (migration not applied). Falls back to false.
 */
async function loadReservationWithFolioFlag<T extends string>(
  supabase: SupabaseClient,
  reservationId: string,
  extraFields: T[] = [],
): Promise<Record<string, unknown> & { id: string; status: string; folio_reopened: boolean }> {
  const baseFields = ["id", "status", "folio_reopened", ...extraFields];
  const { data, error } = await supabase
    .from("reservations")
    .select(baseFields.join(", "))
    .eq("id", reservationId)
    .single();

  if (error && error.message?.includes("folio_reopened")) {
    // Column not yet migrated — fallback without it
    const fallbackFields = ["id", "status", ...extraFields];
    const { data: fb, error: fbErr } = await supabase
      .from("reservations")
      .select(fallbackFields.join(", "))
      .eq("id", reservationId)
      .single();
    if (fbErr || !fb) {
      throw new AdminCorrectionError("Reservation not found.", 404);
    }
    return { ...(fb as any), folio_reopened: false };
  }
  if (error || !data) {
    console.error("[AdminCorrections] loadReservation failed:", error?.message, "id:", reservationId);
    throw new AdminCorrectionError(
      error ? `Reservation lookup failed: ${error.message}` : "Reservation not found.",
      404
    );
  }
  return data as any;
}

// ─── Types ─────────────────────────────────────────────────────

interface FolioPaymentRow {
  id: string;
  reservation_id: string;
  tx_type: string;
  method: string;
  amount: number;
  revenue_category: string | null;
  note: string | null;
  paid_date: string;
  paid_at: string;
  recorded_by: string | null;
  is_record_only: boolean;
  is_void_reversal: boolean;
  void_of: string | null;
  is_correction: boolean;
  correction_ref: string | null;
  correction_reason: string | null;
}

export interface CorrectionResult {
  success: boolean;
  action: AdminCorrectionAction;
  correction_id: string;
  message: string;
  created_payment_ids?: string[];
}

export interface ReinstateAvailabilityResult {
  can_reinstate: boolean;
  room_assignment_mode: "pending" | "specific_room";
  room_type_id: number | null;
  room_type_name: string | null;
  target_room_id: string | null;
  target_room_number: string | null;
  stay_dates: string[];
  message: string;
}

export class AdminCorrectionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AdminCorrectionError";
    this.status = status;
  }
}

async function getReinstateAvailability(
  supabase: SupabaseClient,
  params: {
    reservationId: string;
    targetRoomId?: string | null;
  }
): Promise<ReinstateAvailabilityResult> {
  const { reservationId, targetRoomId = null } = params;

  const { data: nights, error: nightsError } = await supabase
    .from("reservation_nights")
    .select("stay_date, room_id, room_type_id")
    .eq("reservation_id", reservationId)
    .order("stay_date", { ascending: true });

  if (nightsError) {
    throw new AdminCorrectionError(
      `Failed to validate room availability for reinstate: ${nightsError.message}`,
      500
    );
  }

  const stayDates = Array.from(
    new Set(
      (nights ?? [])
        .map((row: any) => String(row?.stay_date ?? ""))
        .filter(Boolean)
    )
  );
  if (stayDates.length === 0) {
    throw new AdminCorrectionError("Cannot reinstate: no stay nights found for this reservation.", 409);
  }

  const roomTypeId = (nights ?? [])
    .map((row: any) => Number(row?.room_type_id ?? 0))
    .find((value: number) => Number.isFinite(value) && value > 0) ?? 0;
  let roomTypeName: string | null = null;

  if (roomTypeId > 0) {
    const { data: roomTypeRow } = await supabase
      .from("room_types")
      .select("name_en")
      .eq("id", roomTypeId)
      .maybeSingle();
    roomTypeName = roomTypeRow?.name_en ? String(roomTypeRow.name_en) : null;
  }

  if (targetRoomId) {
    const firstStayDate = stayDates[0];
    const lastStayDate = stayDates[stayDates.length - 1];
    const checkoutDate = new Date(`${lastStayDate}T00:00:00Z`);
    checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 1);
    const checkoutDateText = checkoutDate.toISOString().slice(0, 10);

    try {
      await assertRoomAvailableForDateRange(supabase as any, {
        roomId: targetRoomId,
        checkinDate: firstStayDate,
        checkoutDate: checkoutDateText,
        excludeReservationId: reservationId,
      });
    } catch (error) {
      if (error instanceof PlannedRoomMoveError) {
        throw new AdminCorrectionError(`Cannot reinstate: selected room is not available. ${error.message}`, 409);
      }
      throw error;
    }

    const { data: roomRow } = await supabase
      .from("rooms")
      .select("room_number")
      .eq("id", targetRoomId)
      .maybeSingle();

    return {
      can_reinstate: true,
      room_assignment_mode: "specific_room",
      room_type_id: roomTypeId > 0 ? roomTypeId : null,
      room_type_name: roomTypeName,
      target_room_id: targetRoomId,
      target_room_number: roomRow?.room_number ? String(roomRow.room_number) : null,
      stay_dates: stayDates,
      message: roomRow?.room_number
        ? `Selected room ${String(roomRow.room_number)} is available for the full stay.`
        : "Selected room is available for the full stay.",
    };
  }

  if (!Number.isFinite(roomTypeId) || roomTypeId <= 0) {
    throw new AdminCorrectionError(
      "Cannot reinstate: original room type could not be determined for availability check.",
      409
    );
  }

  try {
    await assertRoomTypeCapacityForDateRange(supabase as any, {
      roomTypeId,
      nights: stayDates,
      excludeReservationId: reservationId,
    });
  } catch (error) {
    if (error instanceof PlannedRoomMoveError) {
      throw new AdminCorrectionError(`Cannot reinstate: original room type is fully booked. ${error.message}`, 409);
    }
    throw error;
  }

  return {
    can_reinstate: true,
    room_assignment_mode: "pending",
    room_type_id: roomTypeId,
    room_type_name: roomTypeName,
    target_room_id: null,
    target_room_number: null,
    stay_dates: stayDates,
    message: roomTypeName
      ? `Original room type ${roomTypeName} still has availability for the full stay.`
      : "Original room type still has availability for the full stay.",
  };
}

async function assertReinstateAvailability(
  supabase: SupabaseClient,
  params: {
    reservationId: string;
    targetRoomId?: string | null;
  }
): Promise<void> {
  await getReinstateAvailability(supabase, params);
}

export async function previewReinstateAvailability(
  supabase: SupabaseClient,
  reservationId: string,
  targetRoomId?: string | null
): Promise<ReinstateAvailabilityResult> {
  return getReinstateAvailability(supabase, {
    reservationId,
    targetRoomId: targetRoomId ?? null,
  });
}

// ─── Business Day Check ────────────────────────────────────────

async function isBusinessDayClosed(
  supabase: SupabaseClient,
  targetDate: string
): Promise<boolean> {
  const { data } = await supabase
    .from("daily_snapshots")
    .select("business_date")
    .gte("business_date", targetDate)
    .order("business_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  return Boolean(data?.business_date);
}

// ─── Load Payment ──────────────────────────────────────────────

async function loadPayment(
  supabase: SupabaseClient,
  paymentId: string
): Promise<FolioPaymentRow> {
  const { data, error } = await supabase
    .from("folio_payments")
    .select("*")
    .eq("id", paymentId)
    .single();

  if (error || !data) {
    throw new AdminCorrectionError("Payment not found.", 404);
  }
  return data as FolioPaymentRow;
}

// ─── Check Already Voided ──────────────────────────────────────

async function hasExistingVoid(
  supabase: SupabaseClient,
  paymentId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("folio_payments")
    .select("id")
    .eq("void_of", paymentId)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

// ─── Insert Correction Log ────────────────────────────────────

async function insertCorrectionLog(
  supabase: SupabaseClient,
  params: {
    reservationId: string;
    action: AdminCorrectionAction;
    actorUserId: string;
    beforeSnapshot: Record<string, unknown>;
    afterSnapshot: Record<string, unknown>;
    reason: string;
    relatedPaymentIds: string[];
    businessDate: string;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("admin_corrections")
    .insert({
      reservation_id: params.reservationId,
      action: params.action,
      actor_user_id: params.actorUserId,
      before_snapshot: params.beforeSnapshot,
      after_snapshot: params.afterSnapshot,
      reason: params.reason,
      related_payment_ids: params.relatedPaymentIds,
      business_date: params.businessDate,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    // Fail-open: financial correction must not be lost due audit table issue.
    // Caller still writes audit_logs (fallback history source).
    console.error("[AdminCorrections] Failed to log correction:", error?.message ?? "unknown error");
    return `audit-fallback-${Date.now()}`;
  }
  return String(data.id);
}

// ═══════════════════════════════════════════════════════════════
// ACTION 1: VOID PAYMENT
// Admin/Supervisor void should remain available even after Night Audit closes.
// We always preserve an audit trail by inserting a compensating reversal entry.
// ═══════════════════════════════════════════════════════════════

export async function voidPayment(
  supabase: SupabaseClient,
  actorUserId: string,
  paymentId: string,
  reason: string
): Promise<CorrectionResult> {
  if (!reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }

  const payment = await loadPayment(supabase, paymentId);
  const today = await resolveCorrectionBusinessDate(supabase);

  // Guard: cannot void a void
  if (payment.is_void_reversal) {
    throw new AdminCorrectionError("Cannot void a void reversal entry.");
  }

  // Guard: already voided
  const alreadyVoided = await hasExistingVoid(supabase, paymentId);
  if (alreadyVoided) {
    throw new AdminCorrectionError("This payment has already been voided.");
  }

  const paymentAffectsDepositLedger = affectsDepositLedger(payment);

  // Determine reversal tx_type (payment↔refund; deposit refund restores deposit held)
  const reversalTxType = payment.tx_type === "refund" && paymentAffectsDepositLedger ? "deposit"
    : payment.tx_type === "refund" ? "payment"
    : payment.tx_type === "deposit" ? "refund"
    : "refund";

  // Insert compensating entry
  const { data: reversalRow, error: insertError } = await supabase
    .from("folio_payments")
    .insert({
      reservation_id: payment.reservation_id,
      tx_type: reversalTxType,
      method: payment.method,
      amount: payment.amount,
      revenue_category: payment.revenue_category,
      is_void_reversal: true,
      void_of: payment.id,
      correction_reason: reason,
      paid_date: today,
      paid_at: nowISO(),
      recorded_by: actorUserId,
      note: `VOID: ${reason} (ref: ${payment.id.slice(0, 8)})`,
      is_record_only: payment.is_record_only,
    })
    .select("id")
    .single();

  if (insertError || !reversalRow) {
    throw new AdminCorrectionError("Failed to create void reversal entry.");
  }

  // Log correction
  const correctionId = await insertCorrectionLog(supabase, {
    reservationId: payment.reservation_id,
    action: "void",
    actorUserId,
    beforeSnapshot: {
      payment_id: payment.id,
      tx_type: payment.tx_type,
      method: payment.method,
      amount: payment.amount,
      revenue_category: payment.revenue_category,
    },
    afterSnapshot: {
      reversal_id: reversalRow.id,
      reversal_tx_type: reversalTxType,
    },
    reason,
    relatedPaymentIds: [payment.id, reversalRow.id],
    businessDate: today,
  });

  // Also write to audit_logs for Audit Explorer
  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: payment.reservation_id,
      action: "void",
      actor_user_id: actorUserId,
      after_json: {
        payment_id: payment.id,
        reversal_id: reversalRow.id,
        amount: payment.amount,
        method: payment.method,
        reason,
      },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  if (paymentAffectsDepositLedger) {
    await syncReservationDepositLedger(supabase, payment.reservation_id);
  }

  return {
    success: true,
    action: "void",
    correction_id: correctionId,
    message: `Voided ${payment.tx_type} of ${payment.amount} (${payment.method}).`,
    created_payment_ids: [reversalRow.id],
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION 2: ADJUSTMENT (post any time, including after Night Audit)
// ═══════════════════════════════════════════════════════════════

export async function postAdjustment(
  supabase: SupabaseClient,
  actorUserId: string,
  params: {
    reservationId: string;
    direction: "add_charge" | "reduce_charge";
    amount: number;
    method: PaymentMethod;
    originalPaymentId?: string | null;
    reason: string;
  }
): Promise<CorrectionResult> {
  if (!params.reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }
  if (params.amount <= 0) {
    throw new AdminCorrectionError("Amount must be positive.");
  }

  // Verify reservation exists (defensive: folio_reopened may not exist yet)
  const res = await loadReservationWithFolioFlag(supabase, params.reservationId);

  // Guard: if checked_out, folio must be reopened
  if (res.status === "checked_out" && !res.folio_reopened) {
    throw new AdminCorrectionError(
      "Reservation is checked out. Reopen folio first before posting adjustments."
    );
  }

  const today = await resolveCorrectionBusinessDate(supabase);

  // ── Adjustment direction logic (locked policy) ──────────────────
  // Keep revenue_category fixed to "extra_charge" for both directions.
  //
  // add_charge    -> tx_type=payment (record-only) : outstanding increases
  // reduce_charge -> tx_type=refund  (non-record)  : outstanding decreases
  const isAddCharge = params.direction === "add_charge";
  const txType = isAddCharge ? "payment" : "refund";
  const revenueCategory = "extra_charge";
  let isRecordOnly = isAddCharge;

  if (!isAddCharge && !params.originalPaymentId) {
    throw new AdminCorrectionError("reduce_charge requires selecting the charge being reduced.");
  }

  // If correcting a specific payment, verify it exists
  let correctionRef: string | null = null;
  if (params.originalPaymentId) {
    const original = await loadPayment(supabase, params.originalPaymentId);
    if (original.reservation_id !== params.reservationId) {
      throw new AdminCorrectionError("Original payment belongs to a different reservation.");
    }
    if (!isAddCharge) {
      if (original.tx_type !== "payment" || original.revenue_category !== "extra_charge") {
        throw new AdminCorrectionError("reduce_charge requires selecting an extra charge row.");
      }
      isRecordOnly = original.is_record_only;
    }
    correctionRef = params.originalPaymentId;
  }

  // Insert adjustment entry
  const { data: adjRow, error: insertError } = await supabase
    .from("folio_payments")
    .insert({
      reservation_id: params.reservationId,
      tx_type: txType,
      method: params.method,
      amount: params.amount,
      revenue_category: revenueCategory,
      is_correction: true,
      correction_ref: correctionRef,
      correction_reason: params.reason,
      paid_date: today,
      paid_at: nowISO(),
      recorded_by: actorUserId,
      note: `ADJ: ${params.reason}${correctionRef ? ` (ref: ${correctionRef.slice(0, 8)})` : ""}`,
      is_record_only: isRecordOnly,
    })
    .select("id")
    .single();

  if (insertError || !adjRow) {
    throw new AdminCorrectionError("Failed to create adjustment entry.");
  }

  const correctionId = await insertCorrectionLog(supabase, {
    reservationId: params.reservationId,
    action: "adjustment",
    actorUserId,
    beforeSnapshot: correctionRef
      ? { original_payment_id: correctionRef }
      : {},
    afterSnapshot: {
      adjustment_id: adjRow.id,
      tx_type: txType,
      amount: params.amount,
      method: params.method,
      revenue_category: revenueCategory,
      is_record_only: isRecordOnly,
    },
    reason: params.reason,
    relatedPaymentIds: [adjRow.id, ...(correctionRef ? [correctionRef] : [])],
    businessDate: today,
  });

  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: params.reservationId,
      action: "adjustment",
      actor_user_id: actorUserId,
      after_json: {
        adjustment_id: adjRow.id,
        direction: params.direction,
        amount: params.amount,
        method: params.method,
        revenue_category: revenueCategory,
        is_record_only: isRecordOnly,
        reason: params.reason,
      },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  return {
    success: true,
    action: "adjustment",
    correction_id: correctionId,
    message: `Posted ${params.direction} of ${params.amount} (${params.method}).`,
    created_payment_ids: [adjRow.id],
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION 3: REINSTATE RESERVATION (undo accidental cancel)
// ═══════════════════════════════════════════════════════════════

export async function reinstateReservation(
  supabase: SupabaseClient,
  actorUserId: string,
  reservationId: string,
  reason: string,
  targetRoomId?: string | null
): Promise<CorrectionResult> {
  if (!reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }

  const normalizedReservationRef = String(reservationId).trim();

  // Be defensive here: admin UI should send UUID, but allow booking_code too
  // so reinstatement still works even if the client passes the visible code.
  let res: any = null;
  let resError: any = null;

  const byIdResult = await supabase
    .from("reservations")
    .select("id, status, guest_name, booking_code, checkin_date, checkout_date")
    .eq("id", normalizedReservationRef)
    .maybeSingle();

  res = byIdResult.data;
  resError = byIdResult.error;

  if (!res) {
    const byCodeResult = await supabase
      .from("reservations")
      .select("id, status, guest_name, booking_code, checkin_date, checkout_date")
      .eq("booking_code", normalizedReservationRef)
      .maybeSingle();

    res = byCodeResult.data;
    resError = byCodeResult.error;
  }

  if (resError || !res) {
    throw new AdminCorrectionError("Reservation not found.", 404);
  }

  const resolvedReservationId = String(res.id);

  if (res.status !== "cancelled") {
    throw new AdminCorrectionError(
      `Cannot reinstate: reservation status is "${res.status}", expected "cancelled".`
    );
  }

  const today = await resolveCorrectionBusinessDate(supabase);

  await assertReinstateAvailability(supabase, {
    reservationId: resolvedReservationId,
    targetRoomId: targetRoomId ?? null,
  });

  // Restore reservation status
  const { error: updateError } = await supabase
    .from("reservations")
    .update({ status: "active" })
    .eq("id", resolvedReservationId);

  if (updateError) {
    throw new AdminCorrectionError("Failed to update reservation status.");
  }

  // Restore cancelled nights
  const { data: restoredNights, error: nightsError } = await supabase
    .from("reservation_nights")
    .update({ cancelled_at: null })
    .eq("reservation_id", resolvedReservationId)
    .not("cancelled_at", "is", null)
    .select("id");

  if (nightsError) {
    console.error("[AdminCorrections] Failed to restore nights:", nightsError.message);
  }

  const nightsRestored = restoredNights?.length ?? 0;

  // Void any cancel settlement rows (cancel fee + refund entries)
  // Find folio_payments created by the cancel flow
  const { data: cancelSettlements } = await supabase
    .from("folio_payments")
    .select("id, tx_type, amount, method, revenue_category, note, is_record_only")
    .eq("reservation_id", resolvedReservationId)
    .or("note.ilike.%cancel%,note.ilike.%CANCEL%")
    .order("created_at", { ascending: false });

  const voidedIds: string[] = [];
  for (const settlement of (cancelSettlements ?? [])) {
    // Skip if already voided
    const alreadyVoided = await hasExistingVoid(supabase, settlement.id);
    if (alreadyVoided) continue;

    const reversalTxType = settlement.tx_type === "refund" ? "payment" : "refund";

    const { data: rev } = await supabase
      .from("folio_payments")
      .insert({
        reservation_id: resolvedReservationId,
        tx_type: reversalTxType,
        method: settlement.method,
        amount: settlement.amount,
        revenue_category: settlement.revenue_category,
        is_void_reversal: true,
        void_of: settlement.id,
        correction_reason: `Reinstate: ${reason}`,
        paid_date: today,
        paid_at: nowISO(),
        recorded_by: actorUserId,
        note: `REINSTATE VOID: ${reason} (ref: ${settlement.id.slice(0, 8)})`,
        is_record_only: settlement.is_record_only,
      })
      .select("id")
      .single();

    if (rev) voidedIds.push(rev.id);
  }

  // Restore room assignment state:
  // - explicit target room => assign all restored nights there
  // - no target room      => keep unassigned/pending as UI promises
  const roomUpdatePayload = targetRoomId ? { room_id: targetRoomId } : { room_id: null };
  const { error: roomUpdateError } = await supabase
    .from("reservation_nights")
    .update(roomUpdatePayload)
    .eq("reservation_id", resolvedReservationId)
    .is("cancelled_at", null);

  if (roomUpdateError) {
    throw new AdminCorrectionError(
      targetRoomId
        ? `Failed to assign reinstated room: ${roomUpdateError.message}`
        : `Failed to clear room assignment on reinstated reservation: ${roomUpdateError.message}`,
      500
    );
  }

  const correctionId = await insertCorrectionLog(supabase, {
    reservationId: resolvedReservationId,
    action: "reinstate",
    actorUserId,
    beforeSnapshot: {
      status: "cancelled",
      guest_name: res.guest_name,
      booking_code: res.booking_code,
    },
    afterSnapshot: {
      status: "active",
      nights_restored: nightsRestored,
      settlement_rows_voided: voidedIds.length,
      target_room_id: targetRoomId ?? null,
    },
    reason,
    relatedPaymentIds: voidedIds,
    businessDate: today,
  });

  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: resolvedReservationId,
      action: "reinstate",
      actor_user_id: actorUserId,
      after_json: {
        from_status: "cancelled",
        to_status: "active",
        nights_restored: nightsRestored,
        settlement_voided: voidedIds.length,
        reason,
      },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  return {
    success: true,
    action: "reinstate",
    correction_id: correctionId,
    message: `Reinstated ${res.guest_name ?? normalizedReservationRef}. ${nightsRestored} nights restored, ${voidedIds.length} settlement entries voided.`,
    created_payment_ids: voidedIds,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION 4: REOPEN / CLOSE FOLIO
// ═══════════════════════════════════════════════════════════════

export async function reopenFolio(
  supabase: SupabaseClient,
  actorUserId: string,
  reservationId: string,
  reason: string
): Promise<CorrectionResult> {
  if (!reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }

  const res = await loadReservationWithFolioFlag(supabase, reservationId, ["guest_name"]);

  if (res.status !== "checked_out") {
    throw new AdminCorrectionError(
      `Cannot reopen folio: reservation status is "${res.status}", expected "checked_out".`
    );
  }

  if (res.folio_reopened) {
    throw new AdminCorrectionError("Folio is already open.");
  }

  const { error: updateError } = await supabase
    .from("reservations")
    .update({ folio_reopened: true })
    .eq("id", reservationId);

  if (updateError) {
    throw new AdminCorrectionError("Failed to reopen folio.");
  }

  const today = await resolveCorrectionBusinessDate(supabase);
  const correctionId = await insertCorrectionLog(supabase, {
    reservationId,
    action: "reopen_folio",
    actorUserId,
    beforeSnapshot: { folio_reopened: false },
    afterSnapshot: { folio_reopened: true },
    reason,
    relatedPaymentIds: [],
    businessDate: today,
  });

  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: reservationId,
      action: "reopen_folio",
      actor_user_id: actorUserId,
      after_json: { reason },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  return {
    success: true,
    action: "reopen_folio",
    correction_id: correctionId,
    message: `Folio reopened for ${res.guest_name ?? reservationId}.`,
  };
}

export async function closeFolio(
  supabase: SupabaseClient,
  actorUserId: string,
  reservationId: string,
  reason: string
): Promise<CorrectionResult> {
  if (!reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }

  const res = await loadReservationWithFolioFlag(supabase, reservationId, [
    "guest_name",
    "total_price",
    "discount_type",
    "discount_value",
    "discount_percent",
    "checkin_date",
    "checkout_date",
  ]);

  if (!res.folio_reopened) {
    throw new AdminCorrectionError("Folio is not currently open.");
  }

  // Check balance is zero before closing
  const { data: payments } = await supabase
    .from("folio_payments")
    .select("tx_type, amount, revenue_category, note, is_record_only")
    .eq("reservation_id", reservationId);

  const totalPriceSatang = toSatang((res.total_price as number) ?? 0);
  const discountSatang = toSatang(
    computeReservationDiscountAmount({
      totalPrice: res.total_price as number | string | null | undefined,
      discountType: res.discount_type as string | null | undefined,
      discountValue: res.discount_value as number | string | null | undefined,
      discountPercent: res.discount_percent as number | string | null | undefined,
      checkinDate: res.checkin_date as string | null | undefined,
      checkoutDate: res.checkout_date as string | null | undefined,
    })
  );
  const baseRoomChargeSatang = Math.max(0, totalPriceSatang - discountSatang);
  const netPaid = computeCheckoutNetPaidSatang(payments ?? []);
  const extraChargeNetSatang = computeExtraChargeNetSatang(payments ?? []);
  const outstandingSatang = baseRoomChargeSatang + extraChargeNetSatang - netPaid.netPaidSatang;
  const outstanding = fromSatang(outstandingSatang);

  if (Math.abs(outstandingSatang) > 1) {
    throw new AdminCorrectionError(
      `Cannot close folio: outstanding balance is ${outstanding.toFixed(2)}. Must be zero.`
    );
  }

  const { error: updateError } = await supabase
    .from("reservations")
    .update({ folio_reopened: false })
    .eq("id", reservationId);

  if (updateError) {
    throw new AdminCorrectionError("Failed to close folio.");
  }

  const today = await resolveCorrectionBusinessDate(supabase);
  const correctionId = await insertCorrectionLog(supabase, {
    reservationId,
    action: "close_folio",
    actorUserId,
    beforeSnapshot: { folio_reopened: true, outstanding },
    afterSnapshot: { folio_reopened: false },
    reason,
    relatedPaymentIds: [],
    businessDate: today,
  });

  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: reservationId,
      action: "close_folio",
      actor_user_id: actorUserId,
      after_json: { reason },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  return {
    success: true,
    action: "close_folio",
    correction_id: correctionId,
    message: `Folio closed for ${res.guest_name ?? reservationId}.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION 5: TRANSFER PAYMENT (cross-booking)
// ═══════════════════════════════════════════════════════════════

export async function transferPayment(
  supabase: SupabaseClient,
  actorUserId: string,
  params: {
    sourceReservationId: string;
    destinationReservationId: string;
    amount: number;
    method: PaymentMethod;
    reason: string;
  }
): Promise<CorrectionResult> {
  if (!params.reason.trim()) {
    throw new AdminCorrectionError("Reason is required.");
  }
  if (params.amount <= 0) {
    throw new AdminCorrectionError("Amount must be positive.");
  }
  if (params.sourceReservationId === params.destinationReservationId) {
    throw new AdminCorrectionError("Source and destination must be different reservations.");
  }

  // Verify both reservations exist
  const { data: srcRes } = await supabase
    .from("reservations")
    .select("id, guest_name")
    .eq("id", params.sourceReservationId)
    .single();
  if (!srcRes) throw new AdminCorrectionError("Source reservation not found.", 404);

  const dstRes = await loadReservationWithFolioFlag(
    supabase, params.destinationReservationId, ["guest_name"]
  );

  // Guard: destination must be writable
  if (dstRes.status === "checked_out" && !dstRes.folio_reopened) {
    throw new AdminCorrectionError(
      "Destination reservation is checked out. Reopen its folio first."
    );
  }

  const today = await resolveCorrectionBusinessDate(supabase);

  // 1. Insert refund on source (remove credit)
  const { data: srcRefund, error: srcError } = await supabase
    .from("folio_payments")
    .insert({
      reservation_id: params.sourceReservationId,
      tx_type: "refund",
      method: params.method,
      amount: params.amount,
      revenue_category: "room_revenue",
      is_correction: true,
      correction_reason: `Transfer to ${params.destinationReservationId.slice(0, 8)}: ${params.reason}`,
      paid_date: today,
      paid_at: nowISO(),
      recorded_by: actorUserId,
      note: `TRANSFER OUT: ${params.reason} → ${dstRes.guest_name ?? params.destinationReservationId.slice(0, 8)}`,
      is_record_only: false,
    })
    .select("id")
    .single();

  if (srcError || !srcRefund) {
    throw new AdminCorrectionError("Failed to create transfer-out entry.");
  }

  // 2. Insert payment on destination (add credit)
  const { data: dstPayment, error: dstError } = await supabase
    .from("folio_payments")
    .insert({
      reservation_id: params.destinationReservationId,
      tx_type: "payment",
      method: params.method,
      amount: params.amount,
      revenue_category: "room_revenue",
      is_correction: true,
      correction_ref: srcRefund.id,
      correction_reason: `Transfer from ${params.sourceReservationId.slice(0, 8)}: ${params.reason}`,
      paid_date: today,
      paid_at: nowISO(),
      recorded_by: actorUserId,
      note: `TRANSFER IN: ${params.reason} ← ${srcRes.guest_name ?? params.sourceReservationId.slice(0, 8)}`,
      is_record_only: false,
    })
    .select("id")
    .single();

  if (dstError || !dstPayment) {
    throw new AdminCorrectionError("Failed to create transfer-in entry.");
  }

  const correctionId = await insertCorrectionLog(supabase, {
    reservationId: params.sourceReservationId,
    action: "transfer_payment",
    actorUserId,
    beforeSnapshot: {
      source_reservation_id: params.sourceReservationId,
      source_guest: srcRes.guest_name,
    },
    afterSnapshot: {
      destination_reservation_id: params.destinationReservationId,
      destination_guest: dstRes.guest_name,
      amount: params.amount,
      method: params.method,
      source_refund_id: srcRefund.id,
      destination_payment_id: dstPayment.id,
    },
    reason: params.reason,
    relatedPaymentIds: [srcRefund.id, dstPayment.id],
    businessDate: today,
  });

  await insertCorrectionLog(supabase, {
    reservationId: params.destinationReservationId,
    action: "transfer_payment",
    actorUserId,
    beforeSnapshot: {
      transfer_direction: "incoming",
      source_reservation_id: params.sourceReservationId,
      source_guest: srcRes.guest_name,
    },
    afterSnapshot: {
      amount: params.amount,
      method: params.method,
      payment_id: dstPayment.id,
    },
    reason: params.reason,
    relatedPaymentIds: [dstPayment.id],
    businessDate: today,
  });

  try {
    await supabase.from("audit_logs").insert({
      entity_type: "admin_correction",
      entity_id: params.sourceReservationId,
      action: "transfer_payment",
      actor_user_id: actorUserId,
      after_json: {
        source: params.sourceReservationId,
        destination: params.destinationReservationId,
        amount: params.amount,
        method: params.method,
        reason: params.reason,
      },
      business_date: today,
      source: "manual",
    });
  } catch { /* non-blocking */ }

  return {
    success: true,
    action: "transfer_payment",
    correction_id: correctionId,
    message: `Transferred ${params.amount} (${params.method}) from ${srcRes.guest_name ?? "source"} to ${dstRes.guest_name ?? "destination"}.`,
    created_payment_ids: [srcRefund.id, dstPayment.id],
  };
}

// ═══════════════════════════════════════════════════════════════
// QUERY: Correction History
// ═══════════════════════════════════════════════════════════════

export async function getCorrectionHistory(
  supabase: SupabaseClient,
  reservationId: string
): Promise<AdminCorrectionRecord[]> {
  const { data, error } = await supabase
    .from("admin_corrections")
    .select("*")
    .eq("reservation_id", reservationId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[AdminCorrections] getCorrectionHistory failed:", error.message);
    throw new AdminCorrectionError("Failed to load correction history.");
  }

  const rows = (data ?? []) as any[];
  const actorIds = Array.from(
    new Set(
      rows
        .map((row) => String(row.actor_user_id ?? "").trim())
        .filter(Boolean)
    )
  );

  let actorNameByUserId = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", actorIds);
    if (!profileError) {
      actorNameByUserId = new Map(
        ((profileRows ?? []) as Array<{ user_id: string | null; full_name: string | null }>)
          .map((profile) => [
            String(profile.user_id ?? "").trim(),
            String(profile.full_name ?? "").trim(),
          ] as [string, string])
          .filter(([userId, fullName]) => Boolean(userId) && Boolean(fullName))
      );
    }
  }

  const mappedRows = rows.map((row) => ({
    id: row.id,
    reservation_id: row.reservation_id,
    action: row.action,
    actor_user_id: row.actor_user_id,
    actor_name: actorNameByUserId.get(String(row.actor_user_id ?? "").trim()) ?? "Unknown",
    before_snapshot: row.before_snapshot ?? {},
    after_snapshot: row.after_snapshot ?? {},
    reason: row.reason,
    related_payment_ids: row.related_payment_ids ?? [],
    business_date: row.business_date,
    created_at: row.created_at,
  }));

  if (mappedRows.length > 0) {
    return mappedRows;
  }

  // Fallback from audit trail for environments where admin_corrections rows
  // are unavailable but audit_logs exists.
  const { data: auditRows, error: auditError } = await supabase
    .from("audit_logs")
    .select("id, action, actor_user_id, before_json, after_json, note, business_date, created_at")
    .eq("entity_type", "admin_correction")
    .eq("entity_id", reservationId)
    .order("created_at", { ascending: false });

  if (auditError || !(auditRows ?? []).length) {
    return [];
  }

  const fallbackActorIds = Array.from(
    new Set(
      (auditRows ?? [])
        .map((row: any) => String(row?.actor_user_id ?? "").trim())
        .filter(Boolean)
    )
  );
  let fallbackActorNameByUserId = new Map<string, string>();
  if (fallbackActorIds.length > 0) {
    const { data: profileRows } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", fallbackActorIds);
    fallbackActorNameByUserId = new Map(
      ((profileRows ?? []) as Array<{ user_id: string | null; full_name: string | null }>)
        .map((profile) => [
          String(profile.user_id ?? "").trim(),
          String(profile.full_name ?? "").trim(),
        ] as [string, string])
        .filter(([userId, fullName]) => Boolean(userId) && Boolean(fullName))
    );
  }

  const fallbackBusinessDate = await resolveCorrectionBusinessDate(supabase);

  return (auditRows ?? []).map((row: any) => ({
    id: `audit-${String(row.id ?? "")}`,
    reservation_id: reservationId,
    action: String(row.action ?? "adjustment") as AdminCorrectionAction,
    actor_user_id: String(row.actor_user_id ?? ""),
    actor_name: fallbackActorNameByUserId.get(String(row.actor_user_id ?? "").trim()) ?? "Unknown",
    before_snapshot: (row.before_json as Record<string, unknown> | null) ?? {},
    after_snapshot: (row.after_json as Record<string, unknown> | null) ?? {},
    reason: String(row.note ?? "Recovered from audit trail"),
    related_payment_ids: [],
    business_date: String(row.business_date ?? fallbackBusinessDate),
    created_at: String(row.created_at ?? nowISO()),
  }));
}

export function isAdminCorrectionError(err: unknown): err is AdminCorrectionError {
  return err instanceof AdminCorrectionError;
}
