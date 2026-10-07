import { NextRequest, NextResponse } from "next/server";
import { isValidDateString } from "@/lib/dates";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import type { BoardRoomStatus } from "@/lib/board-layout";
import { getBusinessDate } from "@/lib/fo-prepare";
import { resolveHotelCheckOutTime, resolveLinkedStayBatch } from "@/lib/linked-stay";
import { collectSameRoomLinkedContinuationReservationIds } from "@/lib/linked-stay-continuity";
import { findPossibleReturnCandidatesByBookingNames } from "@/lib/guest-booking-names";
import { buildReservationLoyaltyMap } from "@/lib/server-guest-loyalty";
import { attachTemplateFallback, filterAlertsForSurface, mapEffectiveReservationAlert, normalizeAlertCodeKey, summarizeAlerts } from "@/lib/reservation-alerts";
import { DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES, normalizeTransportAlertLeadMinutes } from "@/lib/transport-alert-settings";

type HousekeepingStatus = "dirty" | "in_progress" | "paused" | "cleaned" | "approved";
type GuestSummary = {
  reservation_id: string | null;
  reservation_status: string | null;
  parent_reservation_id: string | null;
  linked_root_id: string | null;
  linked_full_checkin: string | null;
  linked_full_checkout: string | null;
  linked_full_nights: number | null;
  linked_combined_total: number | null;
  linked_active_segment_id: string | null;
  guest_profile_id: string | null;
  is_checked_in: boolean;
  guest_name: string | null;
  booking_code: string | null;
  specials: string | null;
  note: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  source: string | null;
  booking_group_id: string | null;
  group_code: string | null;
  group_name: string | null;
};

type HousekeepingTaskSummary = {
  status: HousekeepingStatus;
  task_seq: number | null;
  assigned_maid_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  approved_at: string | null;
  is_no_service: boolean;
  no_service_note: string | null;
};

type HousekeepingTaskRow = {
  room_id: string;
  status: HousekeepingStatus;
  task_seq?: number | null;
  assigned_maid_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  approved_at: string | null;
  is_no_service: boolean | null;
  no_service_note?: string | null;
};

function parseJsonRecord(value: unknown): Record<string, any> {
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

function mapHousekeepingToBoardStatus(status: HousekeepingStatus): BoardRoomStatus {
  if (status === "dirty") return "dirty";
  if (status === "in_progress" || status === "paused") return "cleaning";
  if (status === "cleaned" || status === "approved") return "approved";
  return "available";
}

function isLaterDate(left: string | null | undefined, right: string | null | undefined): boolean {
  const l = typeof left === "string" ? left : "";
  const r = typeof right === "string" ? right : "";
  if (!l) return false;
  if (!r) return true;
  return l > r;
}

function shouldReplaceHistoricalOccupant(existing: GuestSummary | null | undefined, incoming: GuestSummary): boolean {
  if (!existing) return true;
  if (isLaterDate(incoming.checkin_date, existing.checkin_date)) return true;
  if (incoming.checkin_date === existing.checkin_date) {
    if (incoming.reservation_status === "active" && existing.reservation_status !== "active") return true;
    if ((incoming.reservation_id ?? "") > (existing.reservation_id ?? "")) return true;
  }
  return false;
}

function isAutoSplitPlannedMove(move: any): boolean {
  return String(move?.move_reason ?? "").toLowerCase().includes("auto split stay");
}

export async function GET(request: NextRequest) {
  const t0 = performance.now();
  const requestedDate = request.nextUrl.searchParams.get("date");
  if (requestedDate && !isValidDateString(requestedDate)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD." }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const auth = await requireStaffAuth(supabase, request);
  if (auth.error) return auth.error;
  const { data: hotelSettings } = await supabase
    .from("hotel_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  const transportAlertLeadMin = normalizeTransportAlertLeadMinutes(
    hotelSettings?.transport_alert_lead_min ?? DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES
  );
  const date = await getBusinessDate(supabase, requestedDate);
  const currentBusinessDate = await getBusinessDate(supabase);
  const isHistoricalPastDate = date < currentBusinessDate;
  const tDate = performance.now();

  // ── Wave 1: All independent queries in parallel ─────────────────────────
  const tW1Start = performance.now();
  const hkSelectBase = "room_id, task_seq, status, assigned_maid_name, started_at, finished_at, approved_at, is_no_service";
  const [
    roomsResult,
    reservationNightsResult,
    departuresTodayResult,
    effectivePlannedMovesResult,
    housekeepingResult,
    roomBlocksResult,
  ] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, room_number, is_sellable, closure_reason, wing, is_dayuse, room_types(name_en)")
      .eq("is_visible_on_board", true)
      .eq("is_dayuse", false)
      .order("floor_number", { ascending: true, nullsFirst: false })
      .order("wing", { ascending: true, nullsFirst: false })
      .order("sort_order", { ascending: true, nullsFirst: false }),
    supabase
      .from("reservation_nights")
      .select(`room_id, reservations!reservation_nights_reservation_id_fkey(id, parent_reservation_id, status, guest_profile_id, guest_name, booking_code, specials, note, booking_group_id, checkin_date, checkout_date, source)`)
      .eq("stay_date", date)
      .is("cancelled_at", null),
    supabase
      .from("reservations")
      .select(`id, parent_reservation_id, guest_profile_id, guest_name, booking_code, specials, note, booking_group_id, checkin_date, checkout_date, source, reservation_nights(room_id, stay_date, cancelled_at)`)
      .eq("status", "active")
      .eq("checkout_date", date),
    supabase
      .from("reservation_room_plans")
      .select("id, reservation_id, start_date, end_date, from_room_id_snapshot, to_room_id, move_reason")
      .eq("status", "planned")
      .lte("start_date", date)
      .gt("end_date", date),
    supabase
      .from("housekeeping_tasks")
      .select(`${hkSelectBase}, no_service_note`)
      .eq("stay_date", date)
      .order("task_seq", { ascending: true }),
    supabase
      .from("room_blocks")
      .select("room_id, block_type, reason")
      .lte("start_date", date)
      .gt("end_date", date),
  ]);

  const tW1End = performance.now();

  // Check wave 1 errors
  if (roomsResult.error) return NextResponse.json({ error: roomsResult.error.message }, { status: 500 });
  if (reservationNightsResult.error) return NextResponse.json({ error: reservationNightsResult.error.message }, { status: 500 });
  if (departuresTodayResult.error) return NextResponse.json({ error: departuresTodayResult.error.message }, { status: 500 });
  if (effectivePlannedMovesResult.error) return NextResponse.json({ error: effectivePlannedMovesResult.error.message }, { status: 500 });
  if (housekeepingResult.error) {
    const message = String(housekeepingResult.error.message ?? "").toLowerCase();
    if (message.includes("no_service_note")) {
      return NextResponse.json({ error: "DB migration required: apply 20260303_phase11_hk_no_service_note.sql before using board API." }, { status: 500 });
    }
    return NextResponse.json({ error: housekeepingResult.error.message }, { status: 500 });
  }

  const roomsData = roomsResult.data;
  const reservationNights = reservationNightsResult.data;
  const departuresToday = departuresTodayResult.data;
  const effectivePlannedMoves = effectivePlannedMovesResult.data;
  const housekeepingTasksRaw = housekeepingResult.data;
  const housekeepingTasks = (housekeepingTasksRaw ?? []) as unknown as HousekeepingTaskRow[];

  // Ignore stale planned moves when the reservation has already left its source room.
  // Auto-split stays prewrite reservation_nights to the target room, but the guest
  // must remain physically in the source room until the planned move is executed.
  const activeStayRoomByReservationId = new Map<string, string>();
  (reservationNights ?? []).forEach((night: any) => {
    const reservationRef = Array.isArray(night?.reservations)
      ? night.reservations[0]
      : night?.reservations;
    if (!reservationRef || reservationRef.status !== "active") return;
    const reservationId = reservationRef?.id ? String(reservationRef.id) : "";
    const roomId = night?.room_id ? String(night.room_id) : "";
    if (!reservationId || !roomId) return;
    if (!activeStayRoomByReservationId.has(reservationId)) {
      activeStayRoomByReservationId.set(reservationId, roomId);
    }
  });

  const effectivePlannedMoveRows = (effectivePlannedMoves ?? []).filter((row: any) => {
    const reservationId = row?.reservation_id ? String(row.reservation_id) : "";
    if (!reservationId) return false;
    const sourceRoomId = row?.from_room_id_snapshot ? String(row.from_room_id_snapshot) : "";
    if (!sourceRoomId) return true;
    const todayAssignedRoomId = activeStayRoomByReservationId.get(reservationId);
    if (!todayAssignedRoomId) return true;
    const targetRoomId = row?.to_room_id ? String(row.to_room_id) : "";
    return todayAssignedRoomId === sourceRoomId || (isAutoSplitPlannedMove(row) && todayAssignedRoomId === targetRoomId);
  });

  const blocksByRoomId = new Map<string, { type: string; reason: string }>();
  (roomBlocksResult.data || []).forEach((b) => {
    if (b.room_id) blocksByRoomId.set(b.room_id, { type: b.block_type, reason: b.reason });
  });

  // ── Wave 1 post-processing: compute inputs for Wave 2 ──────────────────
  const groupIds = new Set<string>();
  (reservationNights ?? []).forEach((night: any) => {
    const reservationRef = Array.isArray(night?.reservations)
      ? night.reservations[0]
      : night?.reservations;
    if (!reservationRef) return;
    const reservationStatus = String(reservationRef.status ?? "");
    if (reservationStatus !== "active" && !(isHistoricalPastDate && reservationStatus === "checked_out")) return;
    if (reservationRef?.booking_group_id) {
      groupIds.add(String(reservationRef.booking_group_id));
    }
  });
  (departuresToday ?? []).forEach((reservation: any) => {
    if (reservation?.booking_group_id) {
      groupIds.add(String(reservation.booking_group_id));
    }
  });

  // Compute remaining inputs for Wave 2 (pure JS, no DB)
  const effectivePlanReservationIds = Array.from(
    new Set(effectivePlannedMoveRows.map((row: any) => row?.reservation_id ? String(row.reservation_id) : "").filter(Boolean))
  );
  const reservationIdsForCheckin = new Set<string>();
  (reservationNights ?? []).forEach((night: any) => {
    const reservationRef = Array.isArray(night?.reservations) ? night.reservations[0] : night?.reservations;
    if (!reservationRef) return;
    const reservationStatus = String(reservationRef.status ?? "");
    const canAppearOnBoard =
      reservationStatus === "active" ||
      reservationStatus === "draft_checkin" ||
      (isHistoricalPastDate && reservationStatus === "checked_out");
    if (!canAppearOnBoard) return;
    if (reservationRef?.id) reservationIdsForCheckin.add(String(reservationRef.id));
  });
  (departuresToday ?? []).forEach((reservation: any) => {
    if (reservation?.id) reservationIdsForCheckin.add(String(reservation.id));
  });

  const hotelCheckOutTime = await resolveHotelCheckOutTime(supabase);

  // ── Wave 2: Dependent queries in parallel ───────────────────────────────
  const tW2Start = performance.now();
  const [groupsResult, plannedReservationsResult, checkedInLogsResult, groupReservationsResult] = await Promise.all([
    groupIds.size > 0
      ? supabase.from("booking_groups").select("id, group_code, group_name").in("id", Array.from(groupIds))
      : Promise.resolve({ data: [] as { id: string; group_code: string | null; group_name: string | null }[], error: null }),
    effectivePlanReservationIds.length > 0
      ? supabase.from("reservations").select("id, parent_reservation_id, guest_profile_id, guest_name, booking_code, specials, note, booking_group_id, checkin_date, checkout_date, source").in("id", effectivePlanReservationIds).eq("status", "active")
      : Promise.resolve({ data: [] as any[], error: null }),
    reservationIdsForCheckin.size > 0
      ? supabase.from("audit_logs").select("entity_id").eq("entity_type", "reservation").eq("action", "checked_in").in("entity_id", Array.from(reservationIdsForCheckin))
      : Promise.resolve({ data: [] as { entity_id: string }[], error: null }),
    groupIds.size > 0
      ? supabase.from("reservations").select("id, booking_group_id").in("booking_group_id", Array.from(groupIds)).neq("status", "cancelled")
      : Promise.resolve({ data: [] as { id: string; booking_group_id: string | null }[], error: null }),
  ]);

  const tW2End = performance.now();

  if (groupsResult.error) return NextResponse.json({ error: groupsResult.error.message }, { status: 500 });
  if (plannedReservationsResult.error) return NextResponse.json({ error: plannedReservationsResult.error.message }, { status: 500 });
  if (checkedInLogsResult.error) return NextResponse.json({ error: checkedInLogsResult.error.message }, { status: 500 });
  if (groupReservationsResult.error) return NextResponse.json({ error: groupReservationsResult.error.message }, { status: 500 });

  const groupMetaById = new Map<string, { group_code: string | null; group_name: string | null }>();
  (groupsResult.data ?? []).forEach((g: any) => {
    groupMetaById.set(String(g.id), { group_code: g.group_code ?? null, group_name: g.group_name ?? null });
  });

  const effectivePlanReservationsRaw: any[] = plannedReservationsResult.data ?? [];
  // Check for extra group IDs from planned reservations (rarely needed)
  effectivePlanReservationsRaw.forEach((reservation: any) => {
    if (reservation?.booking_group_id) groupIds.add(String(reservation.booking_group_id));
  });
  const missingGroupIds = Array.from(groupIds).filter((id) => !groupMetaById.has(id));
  if (missingGroupIds.length > 0) {
    const { data: extraGroups, error: extraGroupError } = await supabase
      .from("booking_groups").select("id, group_code, group_name").in("id", missingGroupIds);
    if (extraGroupError) return NextResponse.json({ error: extraGroupError.message }, { status: 500 });
    (extraGroups ?? []).forEach((g: any) => {
      groupMetaById.set(String(g.id), { group_code: g.group_code ?? null, group_name: g.group_name ?? null });
    });
  }

  const checkedInReservationSet = new Set<string>();
  (checkedInLogsResult.data ?? []).forEach((log: any) => {
    checkedInReservationSet.add(String(log.entity_id));
  });
  const groupReservationIdsByGroupId = new Map<string, Set<string>>();
  (groupReservationsResult.data ?? []).forEach((row: any) => {
    const groupId = row?.booking_group_id ? String(row.booking_group_id) : "";
    const reservationId = row?.id ? String(row.id) : "";
    if (!groupId || !reservationId) return;
    const current = groupReservationIdsByGroupId.get(groupId) ?? new Set<string>();
    current.add(reservationId);
    groupReservationIdsByGroupId.set(groupId, current);
  });
  const linkedRootReservationIds = new Set<string>();
  (reservationNights ?? []).forEach((night: any) => {
    const reservationRef = Array.isArray(night?.reservations) ? night.reservations[0] : night?.reservations;
    const reservationStatus = String(reservationRef?.status ?? "");
    if (reservationRef?.parent_reservation_id && (reservationStatus === "active" || (isHistoricalPastDate && reservationStatus === "checked_out"))) {
      linkedRootReservationIds.add(String(reservationRef.parent_reservation_id));
    }
  });
  (departuresToday ?? []).forEach((reservation: any) => {
    if (reservation?.parent_reservation_id) {
      linkedRootReservationIds.add(String(reservation.parent_reservation_id));
    }
  });
  effectivePlanReservationsRaw.forEach((reservation: any) => {
    if (reservation?.parent_reservation_id) {
      linkedRootReservationIds.add(String(reservation.parent_reservation_id));
    }
  });

  const effectivePlanReservationsById = new Map<string, GuestSummary>();
  effectivePlanReservationsRaw.forEach((reservation: any) => {
    const reservationId = reservation?.id ? String(reservation.id) : null;
    const parentReservationId = reservation?.parent_reservation_id ? String(reservation.parent_reservation_id) : null;
    const linkedRootId = parentReservationId ?? (reservationId && linkedRootReservationIds.has(reservationId) ? reservationId : null);
    const groupId = reservation.booking_group_id ? String(reservation.booking_group_id) : null;
    const groupMeta = groupId ? groupMetaById.get(groupId) : null;
    if (reservationId) {
      effectivePlanReservationsById.set(reservationId, {
        reservation_id: reservationId,
        reservation_status: "active",
        parent_reservation_id: parentReservationId,
        linked_root_id: linkedRootId,
        linked_full_checkin: null,
        linked_full_checkout: null,
        linked_full_nights: null,
        linked_combined_total: null,
        linked_active_segment_id: null,
        is_checked_in: checkedInReservationSet.has(reservationId),
        guest_profile_id: reservation.guest_profile_id ? String(reservation.guest_profile_id) : null,
        guest_name: reservation.guest_name ?? null,
        booking_code: reservation.booking_code ?? null,
        specials: reservation.specials ?? null,
        note: reservation.note ?? null,
        checkin_date: reservation.checkin_date ?? null,
        checkout_date: reservation.checkout_date ?? null,
        source: reservation.source ?? null,
        booking_group_id: groupId,
        group_code: groupMeta?.group_code ?? null,
        group_name: groupMeta?.group_name ?? null,
      });
    }
  });

  const plannedMoveSourceGuestByRoomId = new Map<string, GuestSummary>();
  const plannedMoveTargetGuestByRoomId = new Map<string, GuestSummary>();
  effectivePlannedMoveRows.forEach((move: any) => {
    const reservationId = move?.reservation_id ? String(move.reservation_id) : null;
    if (!reservationId) return;
    const guest = effectivePlanReservationsById.get(reservationId);
    if (!guest) return;
    if (move?.from_room_id_snapshot) {
      plannedMoveSourceGuestByRoomId.set(String(move.from_room_id_snapshot), guest);
    }
    if (move?.to_room_id) {
      plannedMoveTargetGuestByRoomId.set(String(move.to_room_id), guest);
    }
  });


  const occupiedGuestByRoomId = new Map<string, GuestSummary>();
  const arrivalGuestByRoomId = new Map<string, GuestSummary>();
  const pendingDraftGuestByRoomId = new Map<string, GuestSummary>();

  (reservationNights ?? []).forEach((night: any) => {
    const roomId = night?.room_id ? String(night.room_id) : "";
    if (!roomId) return;

    const reservationRef = Array.isArray(night.reservations)
      ? night.reservations[0]
      : night.reservations;
    if (!reservationRef) return;
    const reservationStatus = String(reservationRef.status ?? "");
    const isPendingDraftCheckin = reservationStatus === "draft_checkin";
    const canAppearOnBoard =
      reservationStatus === "active" ||
      isPendingDraftCheckin ||
      (isHistoricalPastDate && reservationStatus === "checked_out");
    if (!canAppearOnBoard) return;
    const countsAsOccupiedStay =
      reservationStatus === "active" || (isHistoricalPastDate && reservationStatus === "checked_out");
    const reservationId = reservationRef.id ? String(reservationRef.id) : null;
    const parentReservationId = reservationRef.parent_reservation_id ? String(reservationRef.parent_reservation_id) : null;
    const linkedRootId = parentReservationId ?? (reservationId && linkedRootReservationIds.has(reservationId) ? reservationId : null);
    const groupId = reservationRef.booking_group_id ? String(reservationRef.booking_group_id) : null;
    const groupMeta = groupId ? groupMetaById.get(groupId) : null;

    const guest: GuestSummary = {
      reservation_id: reservationId,
      reservation_status: reservationStatus || null,
      parent_reservation_id: parentReservationId,
      linked_root_id: linkedRootId,
      linked_full_checkin: null,
      linked_full_checkout: null,
      linked_full_nights: null,
      linked_combined_total: null,
      linked_active_segment_id: null,
      is_checked_in: reservationId ? checkedInReservationSet.has(reservationId) : false,
      guest_profile_id: reservationRef.guest_profile_id ? String(reservationRef.guest_profile_id) : null,
      guest_name: reservationRef.guest_name ?? null,
      booking_code: reservationRef.booking_code ?? null,
      specials: reservationRef.specials ?? null,
      note: reservationRef.note ?? null,
      checkin_date: reservationRef.checkin_date ?? null,
      checkout_date: reservationRef.checkout_date ?? null,
      source: reservationRef.source ?? null,
      booking_group_id: groupId,
      group_code: groupMeta?.group_code ?? null,
      group_name: groupMeta?.group_name ?? null,
    };

    if (countsAsOccupiedStay) {
      const existingGuest = occupiedGuestByRoomId.get(roomId);
      if (!isHistoricalPastDate || shouldReplaceHistoricalOccupant(existingGuest, guest)) {
        occupiedGuestByRoomId.set(roomId, guest);
      }
    }
    if (guest.checkin_date === date) {
      arrivalGuestByRoomId.set(roomId, guest);
    }
    if (isPendingDraftCheckin && !guest.is_checked_in) {
      pendingDraftGuestByRoomId.set(roomId, guest);
    }
  });

  const departureGuestByRoomId = new Map<string, GuestSummary>();
  (departuresToday ?? []).forEach((reservation: any) => {
    const nights = Array.isArray(reservation?.reservation_nights)
      ? reservation.reservation_nights
      : reservation?.reservation_nights
        ? [reservation.reservation_nights]
        : [];

    const activeNights = nights.filter((n: any) => !n?.cancelled_at && n?.room_id);
    if (activeNights.length === 0) return;

    activeNights.sort((a: any, b: any) => String(b?.stay_date ?? "").localeCompare(String(a?.stay_date ?? "")));
    const latestNight = activeNights[0];
    const roomId = latestNight?.room_id ? String(latestNight.room_id) : "";
    if (!roomId) return;
    const reservationId = reservation.id ? String(reservation.id) : null;
    const parentReservationId = reservation.parent_reservation_id ? String(reservation.parent_reservation_id) : null;
    const linkedRootId = parentReservationId ?? (reservationId && linkedRootReservationIds.has(reservationId) ? reservationId : null);
    const groupId = reservation.booking_group_id ? String(reservation.booking_group_id) : null;
    const groupMeta = groupId ? groupMetaById.get(groupId) : null;

    departureGuestByRoomId.set(roomId, {
      reservation_id: reservationId,
      reservation_status: String(reservation.status ?? "active"),
      parent_reservation_id: parentReservationId,
      linked_root_id: linkedRootId,
      linked_full_checkin: null,
      linked_full_checkout: null,
      linked_full_nights: null,
      linked_combined_total: null,
      linked_active_segment_id: null,
      is_checked_in: reservationId ? checkedInReservationSet.has(reservationId) : false,
      guest_profile_id: reservation.guest_profile_id ? String(reservation.guest_profile_id) : null,
      guest_name: reservation.guest_name ?? null,
      booking_code: reservation.booking_code ?? null,
      specials: reservation.specials ?? null,
      note: reservation.note ?? null,
      checkin_date: reservation.checkin_date ?? null,
      checkout_date: reservation.checkout_date ?? null,
      source: reservation.source ?? null,
      booking_group_id: groupId,
      group_code: groupMeta?.group_code ?? null,
      group_name: groupMeta?.group_name ?? null,
    });
  });

  const sameRoomContinuationIds = collectSameRoomLinkedContinuationReservationIds({
    departures: (departuresToday ?? []) as any[],
    occupiedStays: (reservationNights ?? [])
      .map((night: any) => {
        const reservationRef = Array.isArray(night?.reservations)
          ? night.reservations[0]
          : night?.reservations;
        if (!reservationRef || reservationRef.status !== "active") return null;
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
  for (const [roomId, guest] of departureGuestByRoomId.entries()) {
    if (guest?.reservation_id && sameRoomContinuationIds.has(String(guest.reservation_id))) {
      departureGuestByRoomId.delete(roomId);
    }
  }

  const reservationIdSet = new Set<string>();
  const reservationProfileSeed = new Map<string, string | null>();
  const pushGuestLoyaltySeed = (guest: GuestSummary | null) => {
    if (!guest?.reservation_id) return;
    reservationIdSet.add(guest.reservation_id);
    if (!reservationProfileSeed.has(guest.reservation_id)) {
      reservationProfileSeed.set(guest.reservation_id, guest.guest_profile_id ?? null);
    }
  };
  occupiedGuestByRoomId.forEach((guest) => pushGuestLoyaltySeed(guest));
  departureGuestByRoomId.forEach((guest) => pushGuestLoyaltySeed(guest));
  arrivalGuestByRoomId.forEach((guest) => pushGuestLoyaltySeed(guest));
  plannedMoveSourceGuestByRoomId.forEach((guest) => pushGuestLoyaltySeed(guest));
  plannedMoveTargetGuestByRoomId.forEach((guest) => pushGuestLoyaltySeed(guest));
  const reservationIdsArr = Array.from(reservationIdSet);
  const reservationGuestByReservationId = new Map<string, GuestSummary>();
  const registerReservationGuest = (guest: GuestSummary | null) => {
    if (!guest?.reservation_id) return;
    if (!reservationGuestByReservationId.has(guest.reservation_id)) {
      reservationGuestByReservationId.set(guest.reservation_id, guest);
    }
  };
  occupiedGuestByRoomId.forEach(registerReservationGuest);
  departureGuestByRoomId.forEach(registerReservationGuest);
  arrivalGuestByRoomId.forEach(registerReservationGuest);
  plannedMoveSourceGuestByRoomId.forEach(registerReservationGuest);
  plannedMoveTargetGuestByRoomId.forEach(registerReservationGuest);

  // Roots can still be linked even when today's row is the parent OTA segment.
  // Detect guest reservations that own at least one child reservation.
  const rootReservationsWithChildren = new Set<string>();
  if (reservationIdsArr.length > 0) {
    const { data: childLinkRows } = await supabase
      .from("reservations")
      .select("parent_reservation_id")
      .in("parent_reservation_id", reservationIdsArr);

    (childLinkRows ?? []).forEach((row: any) => {
      if (row?.parent_reservation_id) {
        rootReservationsWithChildren.add(String(row.parent_reservation_id));
      }
    });
  }

  const linkedStayReservationIds = new Set<string>();
  const collectLinkedReservationIds = (guest: GuestSummary | null | undefined) => {
    if (!guest?.reservation_id) return;
    const reservationId = String(guest.reservation_id);
    const isLinkedRoot = linkedRootReservationIds.has(reservationId);
    const hasKnownChild = rootReservationsWithChildren.has(reservationId);
    if (!guest.parent_reservation_id && !guest.linked_root_id && !isLinkedRoot && !hasKnownChild) return;
    linkedStayReservationIds.add(guest.reservation_id);
  };
  occupiedGuestByRoomId.forEach((guest) => collectLinkedReservationIds(guest));
  departureGuestByRoomId.forEach((guest) => collectLinkedReservationIds(guest));
  arrivalGuestByRoomId.forEach((guest) => collectLinkedReservationIds(guest));
  plannedMoveSourceGuestByRoomId.forEach((guest) => collectLinkedReservationIds(guest));
  plannedMoveTargetGuestByRoomId.forEach((guest) => collectLinkedReservationIds(guest));

  const linkedStayByReservationId = new Map<string, {
    full_checkin: string;
    full_checkout: string;
    full_nights: number;
    combined_total: number;
    active_segment_id: string;
  }>();
  if (linkedStayReservationIds.size > 0) {
    const { data: linkedStayRows, error: linkedStayRowsError } = await supabase
      .from("reservations")
      .select("id, parent_reservation_id, booking_code, source, checkin_date, checkout_date, checked_in_at, status, total_price")
      .in("id", Array.from(linkedStayReservationIds));
    if (linkedStayRowsError) {
      return NextResponse.json({ error: linkedStayRowsError.message }, { status: 500 });
    }
    const linkedStayResults = await resolveLinkedStayBatch(
      supabase,
      (linkedStayRows ?? []).map((row: any) => ({
        id: String(row.id),
        parent_reservation_id: row.parent_reservation_id ?? null,
        booking_code: row.booking_code ?? null,
        source: row.source ?? null,
        checkin_date: row.checkin_date ?? null,
        checkout_date: row.checkout_date ?? null,
        checked_in_at: row.checked_in_at ?? null,
        status: row.status ?? null,
        total_price: row.total_price ?? null,
      })),
      hotelCheckOutTime,
      { activeDate: date }
    );
    for (const [reservationId, linkedStay] of linkedStayResults.entries()) {
      if (!linkedStay) continue;
      linkedStayByReservationId.set(reservationId, linkedStay);
    }
  }

  // ── Wave 3: loyalty + alerts + roomMoveLogs in parallel ────────────────
  const tW3Start = performance.now();
  const [loyaltyByReservationId, alertsResult, roomMoveLogsResult, possibleReturnByReservationId] = await Promise.all([
    buildReservationLoyaltyMap(supabase, reservationIdsArr, reservationProfileSeed),
    reservationIdSet.size > 0
      ? supabase
          .from("reservation_alerts")
          .select("id, reservation_id, alert_code, alert_template_id, note, custom_message, display_surfaces, severity, is_dismissed, created_at, created_by, alert_codes(code, description, dept, auto_on_co, icon), alert_templates(id, code, name, description, category, display_surfaces, severity, icon)")
          .in("reservation_id", reservationIdsArr)
      : Promise.resolve({ data: [] as any[], error: null }),
    reservationIdSet.size > 0
      ? supabase
          .from("audit_logs")
          .select("entity_id, created_at, before_json, after_json")
          .eq("entity_type", "reservation")
          .eq("action", "room_moved")
          .in("entity_id", reservationIdsArr)
      : Promise.resolve({ data: [] as any[], error: null }),
    reservationIdSet.size > 0
      ? findPossibleReturnCandidatesByBookingNames(
          supabase as any,
          reservationIdsArr.map((reservationId) => ({
            reservation_id: reservationId,
            booking_name: reservationGuestByReservationId.get(reservationId)?.guest_name ?? null,
            exclude_guest_profile_id: reservationProfileSeed.get(reservationId) ?? null,
          }))
        )
      : Promise.resolve(new Map<string, any[]>()),
  ]);

  const tW3End = performance.now();

  if (alertsResult.error) return NextResponse.json({ error: alertsResult.error.message }, { status: 500 });
  if (roomMoveLogsResult.error) return NextResponse.json({ error: roomMoveLogsResult.error.message }, { status: 500 });

  // Process alerts
  const alertSummaryByReservationId = new Map<string, {
    count: number;
    firstMessage: string | null;
    highestSeverity: "info" | "warning" | "critical" | null;
  }>();
  if ((alertsResult.data ?? []).length > 0) {
    const reservationAlerts = alertsResult.data ?? [];
    const legacyCodes = Array.from(
      new Set(reservationAlerts.filter((row: any) => !row?.alert_template_id && row?.alert_code).map((row: any) => normalizeAlertCodeKey(row.alert_code)).filter(Boolean))
    );
    let templateMap = new Map<string, any>();
    if (legacyCodes.length > 0) {
      const { data: templates, error: templateError } = await supabase
        .from("alert_templates")
        .select("id, code, name, description, category, display_surfaces, severity, icon");
      if (templateError) return NextResponse.json({ error: templateError.message }, { status: 500 });
      templateMap = new Map((templates ?? []).map((template: any) => [normalizeAlertCodeKey(template.code), template]));
    }
    const resolvedRows = attachTemplateFallback(reservationAlerts, templateMap);
    const grouped = new Map<string, any[]>();
    for (const row of resolvedRows) {
      const reservationId = String((row as any)?.reservation_id ?? "");
      if (!reservationId) continue;
      if (!grouped.has(reservationId)) grouped.set(reservationId, []);
      grouped.get(reservationId)?.push(row);
    }
    grouped.forEach((rows, reservationId) => {
      const alerts = rows.map((row) => mapEffectiveReservationAlert(row)).filter((alert) => !alert.is_dismissed);
      const visibleAlerts = filterAlertsForSurface(alerts, "room_diary");
      const summary = summarizeAlerts(visibleAlerts);
      if (summary.count > 0) alertSummaryByReservationId.set(reservationId, summary);
    });
  }

  // Process room move logs
  const roomMoveByReservation = new Map<string, {
    move_date: string;
    moved_at: string;
    from_room_number: string;
    to_room_number: string;
    reason: string;
  }>();
  for (const log of roomMoveLogsResult.data ?? []) {
    const reservationId = String(log.entity_id);
    const movedAt = String(log.created_at ?? "");
    const before = parseJsonRecord(log.before_json);
    const after = parseJsonRecord(log.after_json);
    const moveDate = String(after.move_date ?? (movedAt ? movedAt.slice(0, 10) : ""));
    if (!moveDate || moveDate > date) continue;
    const incoming = {
      move_date: moveDate,
      moved_at: movedAt,
      from_room_number: String(before.room_number ?? "unknown"),
      to_room_number: String(after.room_number ?? "unknown"),
      reason: typeof after.reason === "string" ? after.reason : ""
    };
    const existing = roomMoveByReservation.get(reservationId);
    if (!existing || incoming.move_date > existing.move_date || (incoming.move_date === existing.move_date && incoming.moved_at > existing.moved_at)) {
      roomMoveByReservation.set(reservationId, incoming);
    }
  }

  const reservedRoomIds = new Set<string>();
  occupiedGuestByRoomId.forEach((_v, roomId) => reservedRoomIds.add(roomId));
  departureGuestByRoomId.forEach((_v, roomId) => reservedRoomIds.add(roomId));
  pendingDraftGuestByRoomId.forEach((_v, roomId) => reservedRoomIds.add(roomId));
  plannedMoveSourceGuestByRoomId.forEach((_v, roomId) => reservedRoomIds.add(roomId));

  const housekeepingByRoomId = new Map<string, HousekeepingTaskSummary>();
  housekeepingTasks.forEach((task) => {
    housekeepingByRoomId.set(task.room_id, {
      status: task.status as HousekeepingStatus,
      task_seq: Number(task.task_seq ?? 1),
      assigned_maid_name: task.assigned_maid_name ?? null,
      started_at: task.started_at ?? null,
      finished_at: task.finished_at ?? null,
      approved_at: task.approved_at ?? null,
      is_no_service: task.is_no_service ?? false,
      no_service_note: task.no_service_note ?? null
    });
  });
  // ── Transfer Data (Phase 11) ──────────────────────
  const transferByRoomId = new Map<string, {
    transfer_id: string;
    pickup_datetime: string;
    transfer_type: string;
    status: string;
    guest_note: string | null;
    alert_enabled: boolean;
  }>();

  try {
    const runTransferQuery = async (selectClause: string) =>
      supabase
        .from("transfers")
        .select(selectClause)
        .gte("pickup_datetime", `${date}T00:00:00+07:00`)
        .lt("pickup_datetime", `${date}T24:00:00+07:00`)
        .in("status", ["pending", "confirmed", "driver_assigned"])
        .order("pickup_datetime", { ascending: true });

    let { data: todayTransfers, error: transferQueryError } = await runTransferQuery(
      "id, reservation_id, pickup_datetime, transfer_type, status, guest_note, alert_enabled"
    );

    if (transferQueryError) {
      const message = String(transferQueryError.message ?? "").toLowerCase();
      // Backward-compatible fallback for DBs that have not applied alert_enabled migration yet.
      if (!message.includes("alert_enabled")) {
        throw transferQueryError;
      }
      const fallbackResult = await runTransferQuery(
        "id, reservation_id, pickup_datetime, transfer_type, status, guest_note"
      );
      todayTransfers = fallbackResult.data;
      transferQueryError = fallbackResult.error;
      if (transferQueryError) throw transferQueryError;
    }

    if (todayTransfers && todayTransfers.length > 0) {
      // Map transfer -> room using reservation_nights with due-out fallback:
      // exact stay_date first, otherwise latest stay_date <= board date.
      const transferResIds = [...new Set(todayTransfers.map((t: any) => t.reservation_id))];
      const { data: transferNights } = await supabase
        .from("reservation_nights")
        .select("reservation_id, stay_date, room_id")
        .in("reservation_id", transferResIds)
        .lte("stay_date", date)
        .is("cancelled_at", null);

      const resIdToRoomId = new Map<string, string>();
      if (transferNights) {
        const grouped = new Map<string, any[]>();
        for (const n of transferNights as any[]) {
          const reservationId = String(n.reservation_id);
          const existing = grouped.get(reservationId);
          if (existing) existing.push(n);
          else grouped.set(reservationId, [n]);
        }
        for (const [reservationId, rows] of grouped.entries()) {
          const exact = rows.find((row) => String(row.stay_date) === date);
          if (exact?.room_id) {
            resIdToRoomId.set(reservationId, String(exact.room_id));
            continue;
          }
          const latest = rows.sort((a, b) => String(b.stay_date).localeCompare(String(a.stay_date)))[0];
          if (latest?.room_id) {
            resIdToRoomId.set(reservationId, String(latest.room_id));
          }
        }
      }

      // Attach earliest unfinished transfer per room
      for (const t of todayTransfers as any[]) {
        const roomId = resIdToRoomId.get(t.reservation_id);
        if (roomId && !transferByRoomId.has(roomId)) {
          transferByRoomId.set(roomId, {
            transfer_id: t.id,
            pickup_datetime: t.pickup_datetime,
            transfer_type: t.transfer_type,
            status: t.status,
            guest_note: t.guest_note,
            alert_enabled: t.alert_enabled !== false,
          });
        }
      }
    }
  } catch (transferErr) {
    // Non-blocking: if transfers table doesn't exist yet, skip gracefully
    console.warn("[Board API] Transfer query skipped:", transferErr);
  }

  const counts: Record<BoardRoomStatus, number> = {
    available: 0,
    reserved: 0,
    dirty: 0,
    cleaning: 0,
    approved: 0,
    closed: 0
  };

  const rooms = (roomsData ?? []).map((room) => {
    let status: any;
    let closure_reason = room.closure_reason;
    const block = blocksByRoomId.get(room.id);
    const arrivalGuest = arrivalGuestByRoomId.get(room.id) ?? null;
    const plannedSourceGuest = plannedMoveSourceGuestByRoomId.get(room.id) ?? null;
    const plannedTargetGuest = plannedMoveTargetGuestByRoomId.get(room.id) ?? null;
    const pendingDraftGuest = pendingDraftGuestByRoomId.get(room.id) ?? null;
    const hasArrivalTodayPending = Boolean(arrivalGuest && !arrivalGuest.is_checked_in);
    const hasDraftCheckinPending = Boolean(pendingDraftGuest);
    const hasPlannedSourceToday = Boolean(plannedSourceGuest);
    const hasPlannedTargetToday = Boolean(plannedTargetGuest);
    const hasDepartureToday = departureGuestByRoomId.has(room.id);
    const hasOccupiedStay = occupiedGuestByRoomId.has(room.id);
    const hasHistoricalOccupiedStay = isHistoricalPastDate && hasOccupiedStay;
    const isDueOut = hasDepartureToday || hasPlannedSourceToday;
    const isDueIn = hasArrivalTodayPending || hasPlannedTargetToday || hasDraftCheckinPending;

    if (block) {
      status = block.type.toLowerCase(); // 'ooo' or 'oos'
      closure_reason = block.reason;
    } else if (!room.is_sellable) {
      status = "closed";
    } else if (hasHistoricalOccupiedStay) {
      status = "reserved";
    } else if (reservedRoomIds.has(room.id)) {
      status = "reserved";
    } else {
      const housekeepingTask = housekeepingByRoomId.get(room.id);
      status = housekeepingTask ? mapHousekeepingToBoardStatus(housekeepingTask.status) : "available";
    }

    let diary_state: "available" | "due_in" | "inhouse" | "back_to_back" | "due_out" | null = null;
    if (!block && room.is_sellable) {
      if (hasHistoricalOccupiedStay) diary_state = "inhouse";
      else if (isDueOut && isDueIn) diary_state = "back_to_back";
      else if (isDueOut) diary_state = "due_out";
      else if (isDueIn) diary_state = "due_in";
      else if (hasOccupiedStay) diary_state = "inhouse";
      else diary_state = "available";
    }

    if (!counts[status as BoardRoomStatus]) counts[status as BoardRoomStatus] = 0;
    counts[status as BoardRoomStatus] += 1;

    const roomTypeRef = room.room_types as { name_en?: string } | null;
    const housekeepingTask = housekeepingByRoomId.get(room.id) ?? null;
    const departureGuest = plannedSourceGuest ?? departureGuestByRoomId.get(room.id) ?? null;
    const occupiedGuest = occupiedGuestByRoomId.get(room.id) ?? null;
    const dueInGuest =
      pendingDraftGuest ??
      (arrivalGuest && !arrivalGuest.is_checked_in ? arrivalGuest : null) ??
      (hasPlannedTargetToday ? plannedTargetGuest : null);
    const guest =
      isHistoricalPastDate
        ? occupiedGuest
        : diary_state === "back_to_back" || diary_state === "due_out"
        ? departureGuest
        : diary_state === "due_in"
          ? dueInGuest
          : occupiedGuest;
    const loyalty = guest?.reservation_id
      ? loyaltyByReservationId.get(guest.reservation_id)
      : null;
    const roomMove = guest?.reservation_id
      ? roomMoveByReservation.get(guest.reservation_id)
      : null;
    const movedIntoCurrentRoom =
      Boolean(roomMove) && roomMove?.to_room_number === room.room_number;
    const alertSummary = guest?.reservation_id
      ? alertSummaryByReservationId.get(guest.reservation_id)
      : null;
    const linkedStay = guest?.reservation_id
      ? linkedStayByReservationId.get(guest.reservation_id)
      : null;
    const possibleReturnMatches = guest?.reservation_id
      ? possibleReturnByReservationId.get(guest.reservation_id) ?? []
      : [];
    return {
      room_id: room.id,
      room_number: room.room_number,
      room_type: roomTypeRef?.name_en ?? "Unknown",
      sellable: room.is_sellable,
      closure_reason,
      status,
      wing: (room as any).wing ?? null,
      guest_name: guest?.guest_name ?? null,
      booking_code: guest?.booking_code ?? null,
      specials: guest?.specials ?? null,
      special_request: typeof guest?.specials === "string" && guest.specials.trim().length > 0
        ? guest.specials.trim()
        : null,
      guest_checkin_date: linkedStay?.full_checkin ?? guest?.checkin_date ?? null,
      guest_checkout_date: linkedStay?.full_checkout ?? guest?.checkout_date ?? null,
      linked_full_checkin: linkedStay?.full_checkin ?? null,
      linked_full_checkout: linkedStay?.full_checkout ?? null,
      linked_full_nights: linkedStay?.full_nights ?? null,
      linked_combined_total: linkedStay?.combined_total ?? null,
      linked_active_segment_id: linkedStay?.active_segment_id ?? null,
      source: guest?.source ?? null,
      reservation_id: guest?.reservation_id ?? null,
      reservation_status: guest?.reservation_status ?? null,
      guest_profile_id: guest?.guest_profile_id ?? null,
      vip_tier: loyalty?.vip_tier ?? null,
      stay_count: loyalty?.stay_count ?? 0,
      night_count: loyalty?.night_count ?? 0,
      main_stay_count: loyalty?.main_stay_count ?? 0,
      main_night_count: loyalty?.main_night_count ?? 0,
      accompanying_stay_count: loyalty?.accompanying_stay_count ?? 0,
      accompanying_night_count: loyalty?.accompanying_night_count ?? 0,
      possible_return_count: guest?.guest_profile_id ? 0 : possibleReturnMatches.length,
      possible_return_profile_id: guest?.guest_profile_id ? null : possibleReturnMatches[0]?.profile?.id ?? null,
      possible_return_name: guest?.guest_profile_id
        ? null
        : [possibleReturnMatches[0]?.profile?.first_name, possibleReturnMatches[0]?.profile?.last_name]
            .filter(Boolean)
            .join(" ") || null,
      due_in_guest_name: isHistoricalPastDate ? null : dueInGuest?.guest_name ?? null,
      due_in_booking_code: isHistoricalPastDate ? null : dueInGuest?.booking_code ?? null,
      due_in_checkin_date: isHistoricalPastDate ? null : dueInGuest?.checkin_date ?? null,
      due_in_checkout_date: isHistoricalPastDate ? null : dueInGuest?.checkout_date ?? null,
      due_in_source: isHistoricalPastDate ? null : dueInGuest?.source ?? null,
      due_in_reservation_id: isHistoricalPastDate ? null : dueInGuest?.reservation_id ?? null,
      booking_group_id: guest?.booking_group_id ?? null,
      parent_reservation_id: guest?.parent_reservation_id ?? null,
      linked_root_id: guest?.linked_root_id ?? null,
      group_code: guest?.group_code ?? null,
      group_name: guest?.group_name ?? null,
      room_move_from: movedIntoCurrentRoom ? roomMove?.from_room_number ?? null : null,
      room_move_reason: movedIntoCurrentRoom ? roomMove?.reason ?? null : null,
      room_move_date: movedIntoCurrentRoom ? roomMove?.move_date ?? null : null,
      alert_count: alertSummary?.count ?? 0,
      first_alert_message: alertSummary?.firstMessage ?? null,
      alert_severity: alertSummary?.highestSeverity ?? null,
      diary_state,
      hk_status: housekeepingTask?.status ?? null,
      hk_task_seq: housekeepingTask?.task_seq ?? null,
      hk_assigned_maid: housekeepingTask?.assigned_maid_name ?? null,
      hk_started_at: housekeepingTask?.started_at ?? null,
      hk_finished_at: housekeepingTask?.finished_at ?? null,
      hk_approved_at: housekeepingTask?.approved_at ?? null,
      hk_is_no_service: housekeepingTask?.is_no_service ?? false,
      hk_no_service_note: housekeepingTask?.no_service_note ?? null,
      // Phase 11: Transfer overlay
      transfer_pickup_at: transferByRoomId.get(room.id)?.pickup_datetime ?? null,
      transfer_type_icon: transferByRoomId.has(room.id)
        ? (["bus_ferry_pickup", "ticket_only"].includes(transferByRoomId.get(room.id)!.transfer_type) ? "⛵" : "🚗")
        : null,
      transfer_status: transferByRoomId.get(room.id)?.status ?? null,
      transfer_id: transferByRoomId.get(room.id)?.transfer_id ?? null,
      transfer_guest_note: transferByRoomId.get(room.id)?.guest_note ?? null,
      transfer_alert_enabled: transferByRoomId.get(room.id)?.alert_enabled ?? true,
      transfer_alert_lead_min: transportAlertLeadMin,
    };
  });

  const tTotal = performance.now();
  const timing = {
    businessDate: Math.round(tDate - t0),
    wave1: Math.round(tW1End - tW1Start),
    wave2: Math.round(tW2End - tW2Start),
    wave3: Math.round(tW3End - tW3Start),
    total: Math.round(tTotal - t0),
  };
  console.log(`[Board API] timing ms | date:${timing.businessDate} w1:${timing.wave1} w2:${timing.wave2} w3:${timing.wave3} total:${timing.total}`);

  return NextResponse.json(
    {
      success: true,
      date,
      counts,
      rooms,
      _timing: timing,
    },
    { status: 200 }
  );
}
