import { assertBusinessDayOpen, normalizePaymentMethod, toLocalDate } from "@/lib/folio-fees";
import { getNightAuditSettings } from "@/lib/night-audit";
import { assertRoomAvailableForDateRange, PlannedRoomMoveError } from "@/lib/planned-room-moves";
import { syncBookingGroupStatusById } from "@/lib/booking-group-status";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { listNights } from "@/lib/dates";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";

type PaymentRow = {
  id: string;
  tx_type: string | null;
  method: string | null;
  amount: number | null;
  note: string | null;
  revenue_category: string | null;
};

function normalizeRefundMethod(raw: unknown): "cash" | "transfer" {
  const method = normalizePaymentMethod(raw);
  if (method === "transfer") return "transfer";
  return "cash";
}

function isNoShowFeeRow(row: PaymentRow): boolean {
  const txType = String(row.tx_type ?? "").toLowerCase();
  if (txType !== "payment") return false;
  const note = String(row.note ?? "").toLowerCase();
  const category = String(row.revenue_category ?? "").toLowerCase();
  return category === "no_show_fee" || note.includes("no-show charge");
}

function buildRefundMatchKey(paymentId: string) {
  return `reverse-no-show:${paymentId}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const reservationId = params.id;
    if (!reservationId) {
      return NextResponse.json({ success: false, error: "Missing reservation id." }, { status: 400 });
    }

    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
    if (auth.error) return auth.error;

    const { businessDate } = await getNightAuditSettings(supabase);
    await assertBusinessDayOpen(supabase, businessDate);

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, booking_code, booking_group_id, status, guest_name, checkin_date, checkout_date, checked_in_at, note")
      .eq("id", reservationId)
      .maybeSingle();

    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }
    if (!reservation) {
      return NextResponse.json({ success: false, error: "Reservation not found." }, { status: 404 });
    }
    if (reservation.status !== "no_show" || reservation.checked_in_at) {
      return NextResponse.json(
        { success: false, error: "Only pending no-show reservations can be reversed." },
        { status: 409 }
      );
    }

    const originalCheckinDate = String(reservation.checkin_date ?? "");
    const originalCheckoutDate = String(reservation.checkout_date ?? "");
    const effectiveCheckinDate =
      originalCheckinDate && originalCheckinDate < businessDate ? businessDate : originalCheckinDate;

    let restoreDates: string[] = [];
    try {
      restoreDates = listNights(effectiveCheckinDate, originalCheckoutDate);
    } catch (error) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Invalid stay dates." },
        { status: 400 }
      );
    }
    if (restoreDates.length === 0) {
      return NextResponse.json(
        { success: false, error: "Reservation stay has already fully passed. Create a new booking instead." },
        { status: 409 }
      );
    }

    const [{ data: nightRows, error: nightRowsError }, { data: paymentRows, error: paymentRowsError }] = await Promise.all([
      supabase
        .from("reservation_nights")
        .select("id, stay_date, room_id, room_type_id, nightly_price, cancelled_at")
        .eq("reservation_id", reservationId)
        .order("stay_date", { ascending: true }),
      supabase
        .from("folio_payments")
        .select("id, tx_type, method, amount, note, revenue_category")
        .eq("reservation_id", reservationId)
        .order("paid_at", { ascending: true }),
    ]);

    if (nightRowsError) {
      return NextResponse.json({ success: false, error: nightRowsError.message }, { status: 500 });
    }
    if (paymentRowsError) {
      return NextResponse.json({ success: false, error: paymentRowsError.message }, { status: 500 });
    }

    const nights = Array.isArray(nightRows) ? nightRows : [];
    const restoreNightRows = nights.filter((row: any) => restoreDates.includes(String(row.stay_date ?? "")));
    if (restoreNightRows.length === 0) {
      return NextResponse.json(
        { success: false, error: "No reservation nights remain to restore for this stay." },
        { status: 409 }
      );
    }

    const distinctRoomIds = Array.from(
      new Set(
        restoreNightRows
          .map((row: any) => (row?.room_id ? String(row.room_id) : ""))
          .filter(Boolean)
      )
    );

    let keepAssignedRoom = false;
    let roomAssignmentCleared = false;
    if (distinctRoomIds.length === 1) {
      try {
        await assertRoomAvailableForDateRange(supabase as any, {
          roomId: distinctRoomIds[0],
          checkinDate: effectiveCheckinDate,
          checkoutDate: originalCheckoutDate,
          excludeReservationId: reservationId,
        });
        keepAssignedRoom = true;
      } catch (error) {
        if (!(error instanceof PlannedRoomMoveError)) {
          console.error("reverse-no-show room availability failed:", error);
        }
        roomAssignmentCleared = true;
      }
    } else if (distinctRoomIds.length > 1) {
      roomAssignmentCleared = true;
    }

    const nowIso = new Date().toISOString();
    const activeNightTotal = restoreNightRows.reduce((sum, row: any) => sum + Number(row?.nightly_price ?? 0), 0);
    const appendedLine = "[NO-SHOW REVERSED] Guest arrived late";
    const currentNote = String(reservation.note ?? "").trim();
    const nextNote = currentNote ? `${currentNote}\n${appendedLine}` : appendedLine;

    const { error: restoreNightsError } = await supabase
      .from("reservation_nights")
      .update({
        cancelled_at: null,
        ...(roomAssignmentCleared ? { room_id: null } : {}),
      })
      .eq("reservation_id", reservationId)
      .gte("stay_date", effectiveCheckinDate)
      .lt("stay_date", originalCheckoutDate);

    if (restoreNightsError) {
      return NextResponse.json({ success: false, error: restoreNightsError.message }, { status: 500 });
    }

    const { error: cancelPastNightsError } = await supabase
      .from("reservation_nights")
      .update({ cancelled_at: nowIso })
      .eq("reservation_id", reservationId)
      .lt("stay_date", effectiveCheckinDate)
      .is("cancelled_at", null);

    if (cancelPastNightsError) {
      return NextResponse.json({ success: false, error: cancelPastNightsError.message }, { status: 500 });
    }

    const { error: reservationUpdateError } = await supabase
      .from("reservations")
      .update({
        status: "active",
        checkin_date: effectiveCheckinDate,
        total_price: Math.round(activeNightTotal * 100) / 100,
        note: nextNote,
        updated_at: nowIso,
      })
      .eq("id", reservationId);

    if (reservationUpdateError) {
      return NextResponse.json({ success: false, error: reservationUpdateError.message }, { status: 500 });
    }

    const reverseRefundRows = (paymentRows ?? [])
      .filter((row: any) => isNoShowFeeRow(row as PaymentRow))
      .filter((row: any) => {
        const matchKey = buildRefundMatchKey(String(row.id));
        return !(paymentRows ?? []).some((candidate: any) =>
          String(candidate.tx_type ?? "").toLowerCase() === "refund" &&
          String(candidate.note ?? "").includes(matchKey)
        );
      });

    if (reverseRefundRows.length > 0) {
      const refundRows = reverseRefundRows.map((row: any) => {
        const originalMethod = normalizeRefundMethod(row.method);
        return {
          reservation_id: reservationId,
          tx_type: "refund",
          method: originalMethod,
          amount: Math.round((Number(row.amount ?? 0) || 0) * 100) / 100,
          note: `Refund (Reverse No-Show) ${buildRefundMatchKey(String(row.id))}`,
          revenue_category: row.revenue_category || "room_revenue",
          cashier_name: "FO",
          paid_date: businessDate,
          paid_at: nowIso,
        };
      });

      const { error: refundInsertError } = await supabase.from("folio_payments").insert(refundRows);
      if (refundInsertError) {
        return NextResponse.json({ success: false, error: refundInsertError.message }, { status: 500 });
      }
    }

    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "reverse_no_show",
      entity_type: "reservation",
      entity_id: reservationId,
      after_json: {
        booking_code: reservation.booking_code,
        guest_name: reservation.guest_name,
        business_date: businessDate,
        checkin_date_before: originalCheckinDate,
        checkin_date_after: effectiveCheckinDate,
        checkout_date: originalCheckoutDate,
        room_assignment_cleared: roomAssignmentCleared,
        no_show_fee_refunded: reverseRefundRows.length > 0,
        refunded_rows: reverseRefundRows.length,
        reversed_at: nowIso,
      },
      business_date: businessDate,
      source: normalizeAuditSource("manual"),
    });

    if (auditError) {
      return NextResponse.json({ success: false, error: auditError.message }, { status: 500 });
    }

    if (reservation.booking_group_id) {
      try {
        await syncBookingGroupStatusById(supabase, String(reservation.booking_group_id));
      } catch (syncError) {
        console.error("group status sync after reverse no-show failed:", reservation.booking_group_id, syncError);
      }
    }

    return NextResponse.json({
      success: true,
      reservation_id: reservationId,
      checkin_date: effectiveCheckinDate,
      checkout_date: originalCheckoutDate,
      room_assignment_cleared: roomAssignmentCleared,
      kept_assigned_room: keepAssignedRoom,
      refunded_fee_rows: reverseRefundRows.length,
      message: "No-show reversed successfully.",
    });
  } catch (error) {
    console.error("reverse-no-show POST failed", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
