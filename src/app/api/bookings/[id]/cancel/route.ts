import { NextResponse } from "next/server";
import { z } from "zod";
import { mapBookingErrorToStatus } from "@/lib/bookings";
import { refreshBookingGroupTotalRooms, syncBookingGroupStatusById } from "@/lib/booking-group-status";
import { assertBusinessDayOpen, normalizeOperatorPaymentMethod, resolveBusinessDate, toLocalDate } from "@/lib/folio-fees";
import {
  loadReservationSheetSyncGroups,
  pushToGoogleSheet,
  type ReservationSheetSyncGroup,
  type SheetSyncDateEntry,
} from "@/lib/google-sheet-sync";
import { computePrepaidNetAmount, suggestRefundMethod } from "@/lib/settlement-preview";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { fromSatang, toSatang } from "@/lib/money";
import { markRoomDirtyTask } from "@/lib/hk-dirty";
import { clearAlertsForInactiveReservations } from "@/lib/alerts/lifecycle";

const cancelSchema = z.object({
  cancel_reason: z.string().min(1).optional(),
  fee_amount: z.number().min(0).optional(),
  fee_method: z.enum(["cash", "transfer", "credit_card"]).optional(), // legacy key
  fee_collect_method: z.enum(["cash", "transfer", "credit_card"]).optional(),
  refund_method: z.enum(["cash", "transfer"]).optional(),
  fee_note: z.string().optional(),
  refund_note: z.string().optional(),
  /** When true, cascade cancel to all linked reservations (default: true for root, false for child). */
  cascade_linked: z.coerce.boolean().optional(),
});

function normalizeAmount(value: number): number {
  return fromSatang(toSatang(value));
}

function isCheckedInColumnMissing(message?: string | null): boolean {
  return /checked_in_at/i.test(String(message ?? ""));
}

type CancelTarget = {
  id: string;
  booking_code: string | null;
  booking_group_id: string | null;
  parent_reservation_id: string | null;
  status: string;
  checked_in_at?: string | null;
};

async function loadLinkedCancelTargets(supabase: any, rootReservationId: string): Promise<CancelTarget[]> {
  const withCheckedIn = await supabase
    .from("reservations")
    .select("id, booking_code, booking_group_id, parent_reservation_id, status, checked_in_at")
    .or(`id.eq.${rootReservationId},parent_reservation_id.eq.${rootReservationId}`);

  if (withCheckedIn.error && isCheckedInColumnMissing(withCheckedIn.error.message)) {
    const fallback = await supabase
      .from("reservations")
      .select("id, booking_code, booking_group_id, parent_reservation_id, status")
      .or(`id.eq.${rootReservationId},parent_reservation_id.eq.${rootReservationId}`);
    if (fallback.error) {
      throw new Error(fallback.error.message ?? "Failed to load linked cancel targets.");
    }
    return (fallback.data ?? []).map((row: any) => ({
      id: String(row.id),
      booking_code: row.booking_code ? String(row.booking_code) : null,
      booking_group_id: row.booking_group_id ? String(row.booking_group_id) : null,
      parent_reservation_id: row.parent_reservation_id ? String(row.parent_reservation_id) : null,
      status: String(row.status ?? ""),
      checked_in_at: null,
    }));
  }

  if (withCheckedIn.error) {
    throw new Error(withCheckedIn.error.message ?? "Failed to load linked cancel targets.");
  }

  return (withCheckedIn.data ?? []).map((row: any) => ({
    id: String(row.id),
    booking_code: row.booking_code ? String(row.booking_code) : null,
    booking_group_id: row.booking_group_id ? String(row.booking_group_id) : null,
    parent_reservation_id: row.parent_reservation_id ? String(row.parent_reservation_id) : null,
    status: String(row.status ?? ""),
    checked_in_at: row.checked_in_at ? String(row.checked_in_at) : null,
  }));
}

async function resolveWasCheckedIn(supabase: any, target: CancelTarget): Promise<boolean> {
  if (target.checked_in_at) return true;
  const { data: checkinLog } = await supabase
    .from("audit_logs")
    .select("id")
    .eq("entity_type", "reservation")
    .eq("entity_id", target.id)
    .eq("action", "checked_in")
    .limit(1)
    .maybeSingle();
  return Boolean(checkinLog?.id);
}

async function resolveDirtyRoomIdForReservation(params: {
  supabase: any;
  reservationId: string;
  localDate: string;
}): Promise<string | null> {
  const { supabase, reservationId, localDate } = params;
  const { data: activeNights, error: activeNightsError } = await supabase
    .from("reservation_nights")
    .select("room_id, stay_date")
    .eq("reservation_id", reservationId)
    .is("cancelled_at", null)
    .order("stay_date", { ascending: true });
  if (activeNightsError) return null;
  const nights = (activeNights ?? []).filter((row: any) => row?.room_id);
  const roomForToday = nights.find((row: any) => String(row?.stay_date ?? "") === localDate);
  const fallbackRoom = roomForToday ?? nights[0];
  return fallbackRoom?.room_id ? String(fallbackRoom.room_id) : null;
}

function mergeSheetSyncGroupsByRoom(
  groupedByReservationId: Map<string, ReservationSheetSyncGroup[]>,
  reservationIds: string[]
): ReservationSheetSyncGroup[] {
  const byRoom = new Map<string, Map<string, SheetSyncDateEntry>>();

  for (const reservationId of reservationIds) {
    const groups = groupedByReservationId.get(reservationId) ?? [];
    for (const group of groups) {
      const roomNumber = String(group.room_number ?? "").trim();
      if (!roomNumber) continue;
      if (!byRoom.has(roomNumber)) {
        byRoom.set(roomNumber, new Map<string, SheetSyncDateEntry>());
      }
      const byDate = byRoom.get(roomNumber)!;
      for (const entry of group.dates ?? []) {
        const stayDate = String(entry?.date ?? "").trim();
        if (!stayDate) continue;
        byDate.set(stayDate, {
          date: stayDate,
          guest_name: null,
          price: 0,
          is_ota: false,
        });
      }
    }
  }

  return Array.from(byRoom.entries())
    .map(([roomNumber, byDate]) => ({
      room_number: roomNumber,
      dates: Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date)),
    }))
    .filter((group) => group.dates.length > 0);
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const body = await request.json().catch(() => ({}));
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const reservationId = params.id;
  if (!reservationId) {
    return NextResponse.json({ error: "Missing reservation id." }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const cancelReason = parsed.data.cancel_reason?.trim() || null;
  const feeAmount = normalizeAmount(Number(parsed.data.fee_amount ?? 0));
  const feeCollectMethodRaw = parsed.data.fee_collect_method ?? parsed.data.fee_method ?? null;
  const feeCollectMethod = feeCollectMethodRaw ? normalizeOperatorPaymentMethod(feeCollectMethodRaw) : null;
  const feeNote = parsed.data.fee_note?.trim() || null;
  const refundNote = parsed.data.refund_note?.trim() || null;

  let reservationRef: {
    id: string;
    booking_code: string | null;
    booking_group_id: string | null;
    parent_reservation_id: string | null;
    checked_in_at?: string | null;
  } | null = null;
  const withCheckedIn = await supabase
    .from("reservations")
    .select("id, booking_code, booking_group_id, parent_reservation_id, checked_in_at")
    .eq("id", reservationId)
    .maybeSingle();

  if (withCheckedIn.error && isCheckedInColumnMissing(withCheckedIn.error.message)) {
    const fallback = await supabase
      .from("reservations")
      .select("id, booking_code, booking_group_id, parent_reservation_id")
      .eq("id", reservationId)
      .maybeSingle();
    if (fallback.error) {
      return NextResponse.json({ error: fallback.error.message }, { status: 500 });
    }
    reservationRef = fallback.data as {
      id: string;
      booking_code: string | null;
      booking_group_id: string | null;
      parent_reservation_id: string | null;
    } | null;
  } else if (withCheckedIn.error) {
    return NextResponse.json({ error: withCheckedIn.error.message }, { status: 500 });
  } else {
    reservationRef = withCheckedIn.data as {
      id: string;
      booking_code: string | null;
      booking_group_id: string | null;
      parent_reservation_id: string | null;
      checked_in_at?: string | null;
    } | null;
  }

  if (!reservationRef) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }

  const { data: paymentRows, error: paymentRowsError } = await supabase
    .from("folio_payments")
    .select("amount, tx_type, revenue_category, note, is_record_only, method")
    .eq("reservation_id", reservationId);

  if (paymentRowsError) {
    return NextResponse.json({ error: paymentRowsError.message }, { status: 500 });
  }

  const prepaidNet = normalizeAmount(computePrepaidNetAmount(paymentRows ?? []));
  const suggestedRefundMethod = suggestRefundMethod(paymentRows ?? []);

  let feeFromPrepaid = 0;
  let feeCollectedNow = 0;
  let refundDue = 0;

  if (prepaidNet > 0) {
    if (feeAmount > prepaidNet) {
      return NextResponse.json(
        { error: `Cancellation fee cannot exceed pre-paid amount (฿${prepaidNet.toFixed(2)}).` },
        { status: 400 }
      );
    }
    feeFromPrepaid = feeAmount;
    refundDue = normalizeAmount(prepaidNet - feeFromPrepaid);
  } else {
    if (feeAmount > 0) {
      if (!feeCollectMethod) {
        return NextResponse.json(
          { error: "fee_collect_method is required when collecting a new cancellation fee." },
          { status: 400 }
        );
      }
      feeCollectedNow = feeAmount;
    }
  }

  const refundMethod = parsed.data.refund_method ?? suggestedRefundMethod;
  if (refundDue > 0 && !refundMethod) {
    return NextResponse.json({ error: "refund_method is required when refund due > 0." }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const localDate = toLocalDate(new Date(nowIso));
  const businessDate = await resolveBusinessDate(supabase, localDate);
  const rootReservationId = reservationRef.parent_reservation_id
    ? String(reservationRef.parent_reservation_id)
    : reservationId;
  const isChildReservation = Boolean(reservationRef.parent_reservation_id);
  const cancellationWarnings: string[] = [];

  // Cascade logic:
  // - Root reservation: cascade by default (unless explicitly false)
  // - Child reservation: do NOT cascade by default (cancel only this child)
  // This prevents accidentally cancelling the parent OTA when only cancelling an extension.
  const cascadeLinked = parsed.data.cascade_linked ?? !isChildReservation;

  let linkedTargets: CancelTarget[] = [];
  if (cascadeLinked) {
    try {
      linkedTargets = await loadLinkedCancelTargets(supabase, rootReservationId);
    } catch (error) {
      cancellationWarnings.push(
        `Failed to load linked chain for cascade cancel: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (linkedTargets.length === 0) {
    linkedTargets = [
      {
        id: reservationId,
        booking_code: reservationRef.booking_code ?? null,
        booking_group_id: reservationRef.booking_group_id ?? null,
        parent_reservation_id: reservationRef.parent_reservation_id ?? null,
        status: "active",
        checked_in_at: reservationRef.checked_in_at ?? null,
      },
    ];
  }

  const activeCancelTargets = linkedTargets.filter((row) => row.status === "active");
  if (!activeCancelTargets.some((row) => row.id === reservationId)) {
    activeCancelTargets.unshift({
      id: reservationId,
      booking_code: reservationRef.booking_code ?? null,
      booking_group_id: reservationRef.booking_group_id ?? null,
      parent_reservation_id: reservationRef.parent_reservation_id ?? null,
      status: "active",
      checked_in_at: reservationRef.checked_in_at ?? null,
    });
  }

  const secondaryCancelTargets = activeCancelTargets.filter((row) => row.id !== reservationId);
  const syncApiKey = String(process.env.GOOGLE_SYNC_API_KEY ?? "").trim();
  const shouldAttemptGoogleSheetSync = Boolean(syncApiKey);
  const preCancelSyncGroupsByReservationId = new Map<string, ReservationSheetSyncGroup[]>();

  if (shouldAttemptGoogleSheetSync) {
    await Promise.all(
      activeCancelTargets.map(async (target) => {
        try {
          const groups = await loadReservationSheetSyncGroups({
            supabase: supabase as any,
            reservationId: target.id,
            action: "clear",
            includeCancelledNights: false,
          });
          preCancelSyncGroupsByReservationId.set(target.id, groups);
        } catch (error) {
          cancellationWarnings.push(
            `Google Sheet pre-cancel snapshot failed (${target.booking_code ?? target.id}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })
    );
  }

  const checkinByReservationId = new Map<string, boolean>();
  const dirtyRoomIdByReservationId = new Map<string, string | null>();
  await Promise.all(
    activeCancelTargets.map(async (target) => {
      const wasCheckedInTarget = await resolveWasCheckedIn(supabase, target);
      checkinByReservationId.set(target.id, wasCheckedInTarget);
      if (!wasCheckedInTarget) return;
      const dirtyRoomId = await resolveDirtyRoomIdForReservation({
        supabase,
        reservationId: target.id,
        localDate: businessDate,
      });
      dirtyRoomIdByReservationId.set(target.id, dirtyRoomId);
    })
  );
  const wasCheckedIn = checkinByReservationId.get(reservationId) ?? false;
  const roomIdForDirtyAfterCancel = dirtyRoomIdByReservationId.get(reservationId) ?? null;

  try {
    await assertBusinessDayOpen(supabase, businessDate);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Business day already closed." },
      { status: 400 }
    );
  }

  let cancelFeeRecordOnlyExists = false;
  if (feeFromPrepaid > 0) {
    const { data: existingFeeRows, error: existingFeeError } = await supabase
      .from("folio_payments")
      .select("id")
      .eq("reservation_id", reservationId)
      .eq("fee_template_code", "CANCEL_FEE")
      .eq("is_record_only", true)
      .limit(1);
    if (existingFeeError) return NextResponse.json({ error: existingFeeError.message }, { status: 500 });
    cancelFeeRecordOnlyExists = (existingFeeRows ?? []).length > 0;
  }

  const settlementRows: Record<string, unknown>[] = [];
  if (feeFromPrepaid > 0 && !cancelFeeRecordOnlyExists) {
    settlementRows.push({
      reservation_id: reservationId,
      tx_type: "payment",
      method: null,
      amount: feeFromPrepaid,
      note: feeNote || cancelReason || "Cancellation fee (settled from pre-paid)",
      revenue_category: "extra_charge",
      fee_template_code: "CANCEL_FEE",
      is_record_only: true,
      cashier_name: "FO",
      paid_date: businessDate,
      paid_at: nowIso,
    });
  }
  if (feeCollectedNow > 0) {
    settlementRows.push({
      reservation_id: reservationId,
      tx_type: "payment",
      method: feeCollectMethod,
      amount: feeCollectedNow,
      note: feeNote || cancelReason || "Cancellation fee",
      revenue_category: "extra_charge",
      fee_template_code: "CANCEL_FEE",
      is_record_only: false,
      cashier_name: "FO",
      paid_date: businessDate,
      paid_at: nowIso,
    });
  }
  if (refundDue > 0) {
    settlementRows.push({
      reservation_id: reservationId,
      tx_type: "refund",
      method: refundMethod,
      amount: refundDue,
      note: refundNote || `Refund (Cancel) — ${refundMethod}`,
      revenue_category: "room_revenue",
      is_record_only: false,
      cashier_name: "FO",
      paid_date: businessDate,
      paid_at: nowIso,
    });
  }

  if (settlementRows.length > 0) {
    const { error: settlementError } = await supabase
      .from("folio_payments")
      .insert(settlementRows);
    if (settlementError) {
      return NextResponse.json({ error: settlementError.message }, { status: 500 });
    }
  }

  const { data, error } = await supabase.rpc("booking_cancel_reservation", {
    p_reservation_id: reservationId,
    p_cancel_reason: cancelReason
  });

  if (error) {
    const status = mapBookingErrorToStatus(error.message);
    return NextResponse.json(
      {
        error: error.message,
        settlement_recorded: settlementRows.length > 0,
        warning: settlementRows.length > 0
          ? "Settlement rows were recorded, but cancel action failed. Please retry cancel only."
          : null,
      },
      { status }
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Cancel reservation failed." }, { status: 500 });
  }

  const linkedCancelled: Array<{ id: string; booking_code: string | null }> = [];
  const linkedCancelFailed: Array<{ id: string; booking_code: string | null; error: string }> = [];
  for (const target of secondaryCancelTargets) {
    const { error: linkedCancelError } = await supabase.rpc("booking_cancel_reservation", {
      p_reservation_id: target.id,
      p_cancel_reason: cancelReason ?? "Cancelled via linked stay cascade",
    });
    if (linkedCancelError) {
      const reason = linkedCancelError.message ?? "Unknown error";
      linkedCancelFailed.push({
        id: target.id,
        booking_code: target.booking_code ?? null,
        error: reason,
      });
      cancellationWarnings.push(
        `Linked reservation ${target.booking_code ?? target.id} could not be cancelled: ${reason}`
      );
      continue;
    }
    linkedCancelled.push({
      id: target.id,
      booking_code: target.booking_code ?? null,
    });
  }

  const cancelledReservationIds = [reservationId, ...linkedCancelled.map((row) => row.id)];

  try {
    const alertCleanupCounts = await clearAlertsForInactiveReservations({
      supabase,
      reservationIds: cancelledReservationIds,
      reason: "cancelled",
    });
    console.warn("[alerts:lifecycle] cleared on cancel", {
      reservationIds: cancelledReservationIds,
      ...alertCleanupCounts,
    });
  } catch (alertCleanupError) {
    const warningMessage = `Cancellation succeeded, but failed to clear alerts: ${
      alertCleanupError instanceof Error ? alertCleanupError.message : String(alertCleanupError)
    }`;
    cancellationWarnings.push(warningMessage);
    console.error("[alerts:lifecycle] cleanup failed (cancel succeeded)", {
      reservationIds: cancelledReservationIds,
      error: alertCleanupError instanceof Error ? alertCleanupError.message : String(alertCleanupError),
    });
  }

  // When cancelling a child without cascade, auto-unlink it from the parent
  // so the linked stay group stays clean (cancelled children should not appear in linked stay).
  let autoUnlinked = false;
  if (isChildReservation && !cascadeLinked) {
    const { error: unlinkError } = await supabase
      .from("reservations")
      .update({ parent_reservation_id: null })
      .eq("id", reservationId);
    if (unlinkError) {
      cancellationWarnings.push(
        `Cancel succeeded but auto-unlink failed: ${unlinkError.message}. Child may still appear in linked stay.`
      );
    } else {
      autoUnlinked = true;
    }
  }

  let cancelledPlannedMoveCount = 0;
  let plannedMoveCleanupWarning: string | null = null;
  const { data: plannedMoves, error: plannedMovesError } = await supabase
    .from("reservation_room_plans")
    .select("id, reservation_id")
    .in("reservation_id", cancelledReservationIds)
    .eq("status", "planned");

  if (plannedMovesError) {
    plannedMoveCleanupWarning = `Cancellation succeeded, but failed to load planned moves: ${plannedMovesError.message}`;
    cancellationWarnings.push(plannedMoveCleanupWarning);
  } else if ((plannedMoves ?? []).length > 0) {
    const planIds = (plannedMoves ?? []).map((row: any) => String(row.id)).filter(Boolean);
    cancelledPlannedMoveCount = planIds.length;
    const { error: cancelPlansError } = await supabase
      .from("reservation_room_plans")
      .update({
        status: "cancelled",
        cancelled_at: nowIso,
        updated_by: null,
      })
      .in("id", planIds);

    if (cancelPlansError) {
      plannedMoveCleanupWarning = `Cancellation succeeded, but failed to cancel planned moves: ${cancelPlansError.message}`;
      cancellationWarnings.push(plannedMoveCleanupWarning);
      cancelledPlannedMoveCount = 0;
    }
  }

  // If reservation was already checked in, room must become dirty immediately after cancellation.
  let hkDirtyMarked = false;
  let hkDirtyWarning: string | null = null;
  let linkedDirtyMarkedCount = 0;

  for (const cancelledReservationId of cancelledReservationIds) {
    const wasCheckedInTarget = checkinByReservationId.get(cancelledReservationId) ?? false;
    if (!wasCheckedInTarget) continue;

    const dirtyRoomId = dirtyRoomIdByReservationId.get(cancelledReservationId) ?? null;
    if (!dirtyRoomId) {
      const warningMessage = `Cancellation succeeded, but room_id not found for HK dirty mark (${cancelledReservationId}).`;
      if (cancelledReservationId === reservationId) {
        hkDirtyWarning = warningMessage;
      }
      cancellationWarnings.push(warningMessage);
      continue;
    }

    try {
      await markRoomDirtyTask(supabase as any, {
        roomId: dirtyRoomId,
        stayDate: businessDate,
        assignedMaidName: null,
        clearDailyPlanWhenUnassigned: true,
        logNote: "Marked dirty after cancellation (post check-in)",
      });
      if (cancelledReservationId === reservationId) {
        hkDirtyMarked = true;
      } else {
        linkedDirtyMarkedCount += 1;
      }
    } catch (dirtyError: any) {
      const warningMessage = `Cancellation succeeded, but failed to mark room dirty (${cancelledReservationId}): ${String(dirtyError?.message ?? dirtyError)}`;
      if (cancelledReservationId === reservationId) {
        hkDirtyWarning = warningMessage;
      }
      cancellationWarnings.push(warningMessage);
    }
  }

  const cancelTargetById = new Map<string, CancelTarget>();
  activeCancelTargets.forEach((target) => {
    cancelTargetById.set(target.id, target);
  });
  const bookingGroupIdsToSync = Array.from(
    new Set(
      cancelledReservationIds
        .map((id) => cancelTargetById.get(id)?.booking_group_id ?? null)
        .filter((id): id is string => Boolean(id))
    )
  );

  let groupUnlinkedCount = 0;
  if (cancelledReservationIds.length > 0) {
    const { data: linkedRows, error: linkedRowsError } = await supabase
      .from("reservations")
      .select("id")
      .in("id", cancelledReservationIds)
      .not("booking_group_id", "is", null);

    if (linkedRowsError) {
      cancellationWarnings.push(
        `Cancel succeeded, but failed to inspect booking-group links: ${linkedRowsError.message}`
      );
    } else {
      const linkedIds = (linkedRows ?? []).map((row: any) => String(row.id ?? "")).filter(Boolean);
      if (linkedIds.length > 0) {
        const { error: unlinkGroupError } = await supabase
          .from("reservations")
          .update({ booking_group_id: null })
          .in("id", linkedIds);

        if (unlinkGroupError) {
          cancellationWarnings.push(
            `Cancel succeeded, but failed to unlink booking group: ${unlinkGroupError.message}`
          );
        } else {
          groupUnlinkedCount = linkedIds.length;
        }
      }
    }
  }

  for (const groupId of bookingGroupIdsToSync) {
    try {
      await refreshBookingGroupTotalRooms(supabase, String(groupId));
      await syncBookingGroupStatusById(supabase, String(groupId));
    } catch (syncError) {
      const warningMessage = `Group status sync after cancel failed (${groupId}): ${String((syncError as any)?.message ?? syncError)}`;
      cancellationWarnings.push(warningMessage);
      console.error("group status sync after cancel failed:", groupId, syncError);
    }
  }

  // Fire-and-forget: GAS sync runs in background, does not block response
  if (shouldAttemptGoogleSheetSync) {
    const groupedByRoom = mergeSheetSyncGroupsByRoom(
      preCancelSyncGroupsByReservationId,
      cancelledReservationIds
    );

    if (groupedByRoom.length > 0) {
      Promise.allSettled(
        groupedByRoom.map((group) =>
          pushToGoogleSheet({
            action: "clear",
            room_number: group.room_number,
            dates: group.dates,
            api_key: syncApiKey,
          })
        )
      ).catch((error) => {
        console.error("[GoogleSheetSync] cancel sync failed:", error);
      });
    }
  }

  return NextResponse.json(
    {
      success: true,
      reservation: data,
      settlement: {
        prepaid_net: prepaidNet,
        fee_from_prepaid: feeFromPrepaid,
        fee_collected_now: feeCollectedNow,
        refund_due: refundDue,
        refund_method: refundDue > 0 ? refundMethod : null,
        suggested_refund_method: suggestedRefundMethod,
      },
      housekeeping: {
        was_checked_in: wasCheckedIn,
        dirty_marked: hkDirtyMarked,
        warning: hkDirtyWarning,
        linked_dirty_marked_count: linkedDirtyMarkedCount,
      },
      planned_move_cleanup: {
        cancelled_count: cancelledPlannedMoveCount,
        warning: plannedMoveCleanupWarning,
      },
      linked_chain: {
        root_reservation_id: rootReservationId,
        cascade_linked: cascadeLinked,
        auto_unlinked: autoUnlinked,
        cancelled_count: linkedCancelled.length,
        cancelled: linkedCancelled,
        failed_count: linkedCancelFailed.length,
        failed: linkedCancelFailed,
      },
      group_unlinked_count: groupUnlinkedCount,
      warnings: cancellationWarnings,
    },
    { status: 200 }
  );
}
