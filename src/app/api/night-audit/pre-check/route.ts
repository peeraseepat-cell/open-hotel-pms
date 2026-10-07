import {
  getNightAuditSettings,
  normalizePendingGroupCheckinWizardDrafts,
} from "@/lib/night-audit";
import { collectSameRoomLinkedContinuationReservationIds } from "@/lib/linked-stay-continuity";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PreCheckItem, PreCheckResult } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const OPEN_HK_STATUSES = new Set(["dirty", "in_progress", "paused"]);

export async function GET() {
  try {
    const supabase = createServerSupabaseClient();
    const settings = await getNightAuditSettings(supabase);
    const businessDate = settings.businessDate;

    const [
      noShowPendingRes,
      arrivalsRes,
      checkedInRes,
      departuresRes,
      occupiedTodayRes,
      checkedOutRes,
      hkRoomsRes,
      hkTasksRes,
      noShowResolvedRes,
    ] = await Promise.all([
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .lte("checkin_date", businessDate)
        .is("checked_in_at", null),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("checkin_date", businessDate)
        .eq("status", "active"),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("checkin_date", businessDate)
        .eq("status", "active")
        .not("checked_in_at", "is", null),
      supabase
        .from("reservations")
        .select(`
          id,
          parent_reservation_id,
          checkout_date,
          status,
          reservation_nights(
            stay_date,
            room_id,
            cancelled_at
          )
        `)
        .eq("checkout_date", businessDate)
        .in("status", ["active", "checked_out"]),
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
        .eq("checkout_date", businessDate)
        .eq("status", "checked_out"),
      supabase
        .from("rooms")
        .select("id")
        .eq("is_visible_on_board", true),
      supabase
        .from("housekeeping_tasks")
        .select("room_id, status")
        .eq("stay_date", businessDate)
        .in("status", Array.from(OPEN_HK_STATUSES)),
      supabase
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .eq("action", "no_show")
        .eq("entity_type", "reservation")
        .eq("business_date", businessDate),
    ]);

    if (noShowPendingRes.error) return NextResponse.json({ success: false, error: noShowPendingRes.error.message }, { status: 500 });
    if (arrivalsRes.error) return NextResponse.json({ success: false, error: arrivalsRes.error.message }, { status: 500 });
    if (checkedInRes.error) return NextResponse.json({ success: false, error: checkedInRes.error.message }, { status: 500 });
    if (departuresRes.error) return NextResponse.json({ success: false, error: departuresRes.error.message }, { status: 500 });
    if (occupiedTodayRes.error) return NextResponse.json({ success: false, error: occupiedTodayRes.error.message }, { status: 500 });
    if (checkedOutRes.error) return NextResponse.json({ success: false, error: checkedOutRes.error.message }, { status: 500 });
    if (hkRoomsRes.error) return NextResponse.json({ success: false, error: hkRoomsRes.error.message }, { status: 500 });
    if (hkTasksRes.error) return NextResponse.json({ success: false, error: hkTasksRes.error.message }, { status: 500 });
    if (noShowResolvedRes.error) return NextResponse.json({ success: false, error: noShowResolvedRes.error.message }, { status: 500 });

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

    const noShowPending = noShowPendingRes.count ?? 0;
    const totalArrivals = arrivalsRes.count ?? 0;
    const checkedIn = checkedInRes.count ?? 0;
    const totalDepartures = filteredDepartures.length;
    const checkedOut = filteredDepartures.filter((row: any) => row.status === "checked_out").length;
    const noShowsResolved = noShowResolvedRes.count ?? 0;
    const pendingWizardDrafts = (await normalizePendingGroupCheckinWizardDrafts(supabase, businessDate)).pendingCount;
    const hkRoomIds = new Set((hkRoomsRes.data ?? []).map((row) => String((row as { id: string }).id)));
    const openHkRoomIds = new Set<string>();

    for (const row of hkTasksRes.data ?? []) {
      const roomId = String(row.room_id ?? "");
      if (!roomId || !hkRoomIds.has(roomId)) continue;
      openHkRoomIds.add(roomId);
    }

    const openHkTasks = openHkRoomIds.size;

    const { count: activeDayUseCount, error: activeDayUseError } = await supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("is_dayuse", true)
      .eq("status", "active")
      .eq("checkin_date", businessDate)
      .eq("checkout_date", businessDate);
    if (activeDayUseError) {
      return NextResponse.json({ success: false, error: activeDayUseError.message }, { status: 500 });
    }
    const activeDayUse = activeDayUseCount ?? 0;

    const blockers: PreCheckItem[] = [];
    if (noShowPending > 0) {
      blockers.push({
        type: "no_show_pending",
        count: noShowPending,
        message: `${noShowPending} pending no-show(s)`,
      });
    }

    if (pendingWizardDrafts > 0) {
      blockers.push({
        type: "group_checkin_wizard_draft_pending",
        count: pendingWizardDrafts,
        message: `${pendingWizardDrafts} group check-in wizard draft(s) still open`,
      });
    }

    if (activeDayUse > 0) {
      blockers.push({
        type: "active_dayuse",
        count: activeDayUse,
        message: `${activeDayUse} active day use session(s) must be checked out first`,
      });
    }

    const warnings: PreCheckItem[] = [];
    const arrivalsPending = Math.max(0, totalArrivals - checkedIn);
    if (arrivalsPending > 0) {
      warnings.push({
        type: "arrivals_pending",
        count: arrivalsPending,
        message: `${arrivalsPending} arrival(s) not checked in`,
      });
    }

    const departuresPending = Math.max(0, totalDepartures - checkedOut);
    if (departuresPending > 0) {
      warnings.push({
        type: "departures_pending",
        count: departuresPending,
        message: `${departuresPending} departure(s) not checked out`,
      });
    }

    if (openHkTasks > 0) {
      warnings.push({
        type: "hk_tasks_open",
        count: openHkTasks,
        message: `${openHkTasks} room(s) still have unfinished housekeeping tasks`,
      });
    }

    const payload: PreCheckResult = {
      business_date: businessDate,
      can_run: blockers.length === 0,
      blockers,
      warnings,
      summary: {
        total_arrivals: totalArrivals,
        checked_in: checkedIn,
        total_departures: totalDepartures,
        checked_out: checkedOut,
        no_shows_resolved: noShowsResolved,
        no_shows_pending: noShowPending,
        group_checkin_wizard_drafts_pending: pendingWizardDrafts,
      },
    };

    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    console.error("night-audit/pre-check GET failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
