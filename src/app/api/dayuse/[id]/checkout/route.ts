import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { markRoomDirtyTask } from "@/lib/hk-dirty";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z.object({
  force: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    const params = paramsSchema.safeParse(context.params);
    if (!params.success) {
      return NextResponse.json(
        { success: false, error: "Invalid reservation id.", details: params.error.flatten() },
        { status: 400 }
      );
    }

    const body = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: body.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
    if (auth.error) return auth.error;

    const { data: settings, error: settingsError } = await supabase
      .from("hotel_settings")
      .select("business_date")
      .eq("id", 1)
      .maybeSingle();

    if (settingsError || !settings?.business_date) {
      return NextResponse.json({ success: false, error: "Hotel settings not found." }, { status: 500 });
    }

    const businessDate = String(settings.business_date);
    const reservationId = params.data.id;
    const nowIso = new Date().toISOString();

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select(`
        id,
        booking_code,
        guest_name,
        status,
        is_dayuse,
        checkin_date,
        checkout_date,
        reservation_nights(
          room_id,
          stay_date,
          cancelled_at,
          rooms(room_number)
        )
      `)
      .eq("id", reservationId)
      .maybeSingle();

    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }
    if (!reservation || reservation.is_dayuse !== true || reservation.status !== "active") {
      return NextResponse.json({ success: false, error: "Day use reservation not found or not active." }, { status: 404 });
    }

    const activeNights = Array.isArray(reservation.reservation_nights)
      ? reservation.reservation_nights.filter((n: any) => !n?.cancelled_at)
      : [];
    const todayNight = activeNights.find((n: any) => String(n?.stay_date ?? "") === businessDate) ?? activeNights[0] ?? null;
    const roomId = todayNight?.room_id ? String(todayNight.room_id) : null;
    const roomRef = Array.isArray(todayNight?.rooms) ? todayNight.rooms[0] : todayNight?.rooms;
    const roomNumber = roomRef?.room_number ? String(roomRef.room_number) : null;

    const { error: updateError } = await supabase
      .from("reservations")
      .update({ status: "checked_out" })
      .eq("id", reservationId);

    if (updateError) {
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    const { error: cancelNightsError } = await supabase
      .from("reservation_nights")
      .update({ cancelled_at: nowIso })
      .eq("reservation_id", reservationId)
      .is("cancelled_at", null);

    if (cancelNightsError) {
      return NextResponse.json({ success: false, error: cancelNightsError.message }, { status: 500 });
    }

    if (roomId) {
      try {
        await markRoomDirtyTask(supabase, {
          roomId,
          stayDate: businessDate,
          assignedMaidName: null,
          clearDailyPlanWhenUnassigned: true,
          logNote: "Marked dirty from dayuse checkout",
        });
      } catch (housekeepingError) {
        return NextResponse.json({ success: false, error: String(housekeepingError) }, { status: 500 });
      }
    }

    await supabase.from("audit_logs").insert({
      action: "dayuse_checkout",
      entity_type: "reservation",
      entity_id: reservationId,
      after_json: {
        booking_code: reservation.booking_code,
        guest_name: reservation.guest_name,
        room_id: roomId,
        room_number: roomNumber,
        checked_out_at: nowIso,
        forced: body.data.force,
      },
      business_date: businessDate,
      source: normalizeAuditSource("manual"),
    });

    return NextResponse.json({
      success: true,
      message: "Day use checked out.",
      room_number: roomNumber ?? "—",
    });
  } catch (err) {
    console.error("dayuse/[id]/checkout POST failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
