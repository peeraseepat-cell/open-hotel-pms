import { checkProfileCompleteness } from "@/lib/guest-profile-completeness";
import { checkGroupWizardPrimaryCompleteness } from "@/lib/group-checkin-profile-completeness";
import { toRoundedMoney } from "@/lib/group-checkin-wizard";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type SupabaseClientLike = ReturnType<typeof createServerSupabaseClient>;

export type WizardGuestSummary = {
  guest_profile_id: string;
  display_name: string;
  profile_status: string | null;
  nationality_code: string | null;
  id_number: string | null;
  passport_no: string | null;
  completeness: {
    is_complete: boolean;
    missing_fields: string[];
    is_thai: boolean;
  };
};

export type WizardReservationLine = {
  reservation_id: string;
  booking_code: string;
  guest_name: string | null;
  primary_guest_profile_id: string | null;
  accompanying_guest_profile_ids: string[];
  party: {
    primary: WizardGuestSummary | null;
    accompanying: WizardGuestSummary[];
  };
  checkin_date: string;
  checkout_date: string;
  status: string;
  is_checked_in: boolean;
  checked_in_at: string | null;
  room_id: string | null;
  room_number: string | null;
  room_type: string | null;
  room_type_max_guests: number;
  hk_status: string | null;
  has_assigned_room: boolean;
  total_price: number;
  deposit_amount: number;
  payment_received: number;
  deposit_received: number;
  remaining_balance: number;
  profile_completeness: {
    is_complete: boolean;
    missing_fields: string[];
    is_thai: boolean;
  };
};

export async function getBusinessDate(supabase: SupabaseClientLike, override?: string | null): Promise<string> {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const { data, error } = await supabase
    .from("hotel_settings")
    .select("business_date")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const value = String(data?.business_date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid hotel business date.");
  }
  return value;
}

export async function getGroupById(supabase: SupabaseClientLike, groupId: string): Promise<any> {
  const { data, error } = await supabase
    .from("booking_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function assertReservationInGroup(supabase: SupabaseClientLike, groupId: string, reservationId: string): Promise<any> {
  const { data, error } = await supabase
    .from("reservations")
    .select("id, booking_code, booking_group_id, guest_name, guest_profile_id, status, checkin_date, checkout_date, total_price, deposit_amount")
    .eq("id", reservationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (String(data.booking_group_id ?? "") !== groupId) return null;
  return data;
}

export async function getWizardDraft(supabase: SupabaseClientLike, groupId: string, businessDate: string): Promise<any | null> {
  const { data, error } = await supabase
    .from("group_checkin_wizard_drafts")
    .select("id, booking_group_id, business_date, status, current_step, draft_json, last_committed_at, created_at, updated_at")
    .eq("booking_group_id", groupId)
    .eq("business_date", businessDate)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw new Error(error.message);
  return data ?? null;
}

export class WizardDraftRevisionConflictError extends Error {
  readonly code = "DRAFT_REVISION_CONFLICT";
  constructor() { super("This draft changed in another tab. Reload and try again."); }
}

export async function upsertWizardDraft(params: {
  supabase: SupabaseClientLike;
  groupId: string;
  businessDate: string;
  status?: "draft" | "completed" | "cancelled";
  currentStep?: number;
  draftJson?: Record<string, unknown>;
  touchCommittedAt?: boolean;
  expectedRevision?: string;
}): Promise<any> {
  const payload: Record<string, unknown> = {
    booking_group_id: params.groupId,
    business_date: params.businessDate,
  };
  if (params.status) payload.status = params.status;
  if (typeof params.currentStep === "number") payload.current_step = params.currentStep;
  if (params.draftJson) payload.draft_json = params.draftJson;
  if (params.touchCommittedAt) payload.last_committed_at = new Date().toISOString();

  const query = params.expectedRevision !== undefined
    ? params.supabase.from("group_checkin_wizard_drafts").update(payload)
        .eq("booking_group_id", params.groupId).eq("business_date", params.businessDate)
        .eq("updated_at", params.expectedRevision)
    : params.supabase.from("group_checkin_wizard_drafts").upsert(payload, { onConflict: "booking_group_id,business_date" });
  const { data, error } = await query
    .select("id, booking_group_id, business_date, status, current_step, draft_json, last_committed_at, created_at, updated_at")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data && params.expectedRevision !== undefined) throw new WizardDraftRevisionConflictError();
  return data;
}

export async function updateWizardDraftAtRevision(
  params: Parameters<typeof upsertWizardDraft>[0] & { expectedRevision: string }
): Promise<any> {
  return upsertWizardDraft(params);
}

export async function getSelectedReservationIdsFromDraft(
  supabase: SupabaseClientLike,
  groupId: string,
  businessDate: string
): Promise<string[]> {
  const draft = await getWizardDraft(supabase, groupId, businessDate);
  const raw = Array.isArray((draft?.draft_json as any)?.step1?.selected_reservation_ids)
    ? (draft?.draft_json as any).step1.selected_reservation_ids
    : [];
  return raw.map((value: unknown) => String(value ?? "").trim()).filter(Boolean);
}

function guestDisplayName(profile: Record<string, unknown> | null | undefined, fallback: string | null = null): string {
  const first = String(profile?.first_name ?? "").trim();
  const last = String(profile?.last_name ?? "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const fb = String(fallback ?? "").trim();
  return fb || "Unknown Guest";
}

export async function getGroupReservationLines(
  supabase: SupabaseClientLike,
  groupId: string,
  businessDate: string
): Promise<WizardReservationLine[]> {
  const { data: groupRow, error: groupError } = await supabase
    .from("booking_groups")
    .select("contact_phone")
    .eq("id", groupId)
    .maybeSingle();
  if (groupError) throw new Error(groupError.message);
  const groupContactPhone = String(groupRow?.contact_phone ?? "").trim() || null;

  const { data: rawReservations, error: resError } = await supabase
    .from("reservations")
    .select(`
      id,
      booking_code,
      guest_name,
      phone,
      guest_profile_id,
      checkin_date,
      checkout_date,
      status,
      total_price,
      deposit_amount,
      reservation_nights(
        stay_date,
        cancelled_at,
        room_id,
        nightly_price,
        rooms(
          room_number,
          room_types(name_en, max_guests)
        ),
        room_types(name_en, max_guests)
      )
    `)
    .eq("booking_group_id", groupId)
    .order("booking_code", { ascending: true });

  if (resError) throw new Error(resError.message);

  const reservations = rawReservations ?? [];
  const reservationIds = reservations.map((row: any) => String(row.id));
  const roomIds = new Set<string>();

  const roomByReservation = new Map<string, {
    room_id: string | null;
    room_number: string | null;
    room_type: string | null;
    room_type_max_guests: number;
  }>();
  for (const row of reservations) {
    const nights = Array.isArray(row.reservation_nights) ? row.reservation_nights : [];
    const activeNight = nights.find((night: any) => !night?.cancelled_at && String(night?.stay_date ?? "") === businessDate)
      ?? nights.find((night: any) => !night?.cancelled_at)
      ?? null;

    const roomRef = Array.isArray(activeNight?.rooms) ? activeNight.rooms[0] : activeNight?.rooms;
    const roomTypeFromRoom = Array.isArray(roomRef?.room_types) ? roomRef.room_types[0] : roomRef?.room_types;
    const roomTypeFromNight = Array.isArray(activeNight?.room_types) ? activeNight.room_types[0] : activeNight?.room_types;
    const roomId = activeNight?.room_id ? String(activeNight.room_id) : null;
    if (roomId) roomIds.add(roomId);

    roomByReservation.set(String(row.id), {
      room_id: roomId,
      room_number: roomRef?.room_number ? String(roomRef.room_number) : null,
      room_type: roomTypeFromRoom?.name_en ? String(roomTypeFromRoom.name_en) : (roomTypeFromNight?.name_en ? String(roomTypeFromNight.name_en) : null),
      room_type_max_guests: Math.max(
        1,
        Number(
          roomTypeFromRoom?.max_guests
          ?? roomTypeFromNight?.max_guests
          ?? 2
        ) || 2
      ),
    });
  }

  const checkedInAtByReservation = new Map<string, string>();
  if (reservationIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from("audit_logs")
      .select("entity_id, created_at")
      .eq("entity_type", "reservation")
      .eq("action", "checked_in")
      .in("entity_id", reservationIds);
    if (logsError) throw new Error(logsError.message);

    (logs ?? []).forEach((log: any) => {
      const reservationId = String(log.entity_id ?? "");
      const createdAt = String(log.created_at ?? "");
      if (!reservationId || !createdAt) return;
      const current = checkedInAtByReservation.get(reservationId);
      if (!current || createdAt > current) checkedInAtByReservation.set(reservationId, createdAt);
    });
  }

  const hkStatusByRoomId = new Map<string, string>();
  if (roomIds.size > 0) {
    const { data: hkRows, error: hkError } = await supabase
      .from("housekeeping_tasks")
      .select("room_id, status")
      .eq("stay_date", businessDate)
      .in("room_id", Array.from(roomIds));
    if (hkError) throw new Error(hkError.message);

    (hkRows ?? []).forEach((row: any) => {
      const roomId = String(row.room_id ?? "");
      if (!roomId) return;
      hkStatusByRoomId.set(roomId, String(row.status ?? ""));
    });
  }

  const paymentByReservation = new Map<string, { payment: number; deposit: number }>();
  if (reservationIds.length > 0) {
    const { data: paymentRows, error: paymentError } = await supabase
      .from("folio_payments")
      .select("reservation_id, tx_type, amount")
      .in("reservation_id", reservationIds);
    if (paymentError) throw new Error(paymentError.message);

    (paymentRows ?? []).forEach((row: any) => {
      const reservationId = String(row.reservation_id ?? "");
      if (!reservationId) return;
      const current = paymentByReservation.get(reservationId) ?? { payment: 0, deposit: 0 };
      const amount = toRoundedMoney(row.amount);
      if (row.tx_type === "payment") current.payment += amount;
      if (row.tx_type === "deposit") current.deposit += amount;
      paymentByReservation.set(reservationId, current);
    });
  }

  const { data: reservationGuests, error: reservationGuestsError } = reservationIds.length > 0
    ? await supabase
      .from("reservation_guests")
      .select("reservation_id, guest_profile_id, role, display_order")
      .in("reservation_id", reservationIds)
    : { data: [], error: null as any };
  if (reservationGuestsError) throw new Error(reservationGuestsError.message);

  const guestProfileIds = new Set<string>();
  reservations.forEach((row: any) => {
    const id = String(row.guest_profile_id ?? "").trim();
    if (id) guestProfileIds.add(id);
  });
  (reservationGuests ?? []).forEach((row: any) => {
    const id = String(row.guest_profile_id ?? "").trim();
    if (id) guestProfileIds.add(id);
  });

  const profileById = new Map<string, Record<string, unknown>>();
  if (guestProfileIds.size > 0) {
    const { data: profiles, error: profileError } = await supabase
      .from("guest_profiles")
      .select("id, first_name, last_name, gender, nationality_code, id_type, id_number, country, province, phone, profile_status, passport_no")
      .in("id", Array.from(guestProfileIds));
    if (profileError) throw new Error(profileError.message);
    (profiles ?? []).forEach((profile: any) => profileById.set(String(profile.id), profile));
  }

  const reservationGuestRowsByReservation = new Map<string, Array<{
    reservation_id: string;
    guest_profile_id: string;
    role: "primary" | "accompanying";
    display_order: number;
  }>>();

  (reservationGuests ?? []).forEach((row: any) => {
    const reservationId = String(row.reservation_id ?? "").trim();
    const guestProfileId = String(row.guest_profile_id ?? "").trim();
    const role = String(row.role ?? "").trim() as "primary" | "accompanying";
    if (!reservationId || !guestProfileId || (role !== "primary" && role !== "accompanying")) return;
    const bucket = reservationGuestRowsByReservation.get(reservationId) ?? [];
    bucket.push({
      reservation_id: reservationId,
      guest_profile_id: guestProfileId,
      role,
      display_order: Number(row.display_order ?? 0) || 0,
    });
    reservationGuestRowsByReservation.set(reservationId, bucket);
  });

  return reservations.map((row: any) => {
    const reservationId = String(row.id);
    const room = roomByReservation.get(reservationId) ?? {
      room_id: null,
      room_number: null,
      room_type: null,
      room_type_max_guests: 2,
    };
    const checkedInAt = checkedInAtByReservation.get(reservationId) ?? null;
    const payment = paymentByReservation.get(reservationId) ?? { payment: 0, deposit: 0 };
    const total = toRoundedMoney(row.total_price ?? 0);
    const remaining = Math.max(0, toRoundedMoney(total - payment.payment));
    const reservationGuestRows = [...(reservationGuestRowsByReservation.get(reservationId) ?? [])];
    const persistedPrimary = reservationGuestRows.find((guest) => guest.role === "primary");
    const fallbackPrimaryGuestProfileId = String(row.guest_profile_id ?? "").trim() || null;
    const primaryGuestProfileId = persistedPrimary?.guest_profile_id ?? fallbackPrimaryGuestProfileId;
    const primaryProfile = primaryGuestProfileId ? profileById.get(primaryGuestProfileId) ?? null : null;

    const accompanyingRows = reservationGuestRows
      .filter((guest) => guest.role === "accompanying")
      .sort((a, b) => a.display_order - b.display_order);

    const accompanyingGuestProfileIds = accompanyingRows.map((guest) => guest.guest_profile_id);
    const completeness = checkGroupWizardPrimaryCompleteness(primaryProfile ?? null, {
      reservationPhone: row.phone,
      groupContactPhone,
    });

    const primarySummary = primaryGuestProfileId
      ? {
        guest_profile_id: primaryGuestProfileId,
        display_name: guestDisplayName(primaryProfile, row.guest_name ? String(row.guest_name) : null),
        profile_status: primaryProfile?.profile_status ? String(primaryProfile.profile_status) : null,
        nationality_code: primaryProfile?.nationality_code ? String(primaryProfile.nationality_code) : null,
        id_number: primaryProfile?.id_number ? String(primaryProfile.id_number) : null,
        passport_no: primaryProfile?.passport_no ? String(primaryProfile.passport_no) : null,
        completeness: {
          is_complete: completeness.is_complete,
          missing_fields: completeness.missing_fields,
          is_thai: completeness.is_thai,
        },
      }
      : null;

    const accompanyingSummary = accompanyingRows.map((guest) => {
      const profile = profileById.get(guest.guest_profile_id) ?? null;
      const guestCompleteness = checkProfileCompleteness(profile ?? null);
      return {
        guest_profile_id: guest.guest_profile_id,
        display_name: guestDisplayName(profile, null),
        profile_status: profile?.profile_status ? String(profile.profile_status) : null,
        nationality_code: profile?.nationality_code ? String(profile.nationality_code) : null,
        id_number: profile?.id_number ? String(profile.id_number) : null,
        passport_no: profile?.passport_no ? String(profile.passport_no) : null,
        completeness: {
          is_complete: guestCompleteness.is_complete,
          missing_fields: guestCompleteness.missing_fields,
          is_thai: guestCompleteness.is_thai,
        },
      };
    });

    return {
      reservation_id: reservationId,
      booking_code: String(row.booking_code ?? ""),
      guest_name: row.guest_name ? String(row.guest_name) : null,
      primary_guest_profile_id: primaryGuestProfileId,
      accompanying_guest_profile_ids: accompanyingGuestProfileIds,
      party: {
        primary: primarySummary,
        accompanying: accompanyingSummary,
      },
      checkin_date: String(row.checkin_date ?? ""),
      checkout_date: String(row.checkout_date ?? ""),
      status: String(row.status ?? ""),
      is_checked_in: Boolean(checkedInAt),
      checked_in_at: checkedInAt,
      room_id: room.room_id,
      room_number: room.room_number,
      room_type: room.room_type,
      room_type_max_guests: room.room_type_max_guests,
      hk_status: room.room_id ? (hkStatusByRoomId.get(room.room_id) ?? null) : null,
      has_assigned_room: Boolean(room.room_id),
      total_price: total,
      deposit_amount: toRoundedMoney(row.deposit_amount ?? 0),
      payment_received: toRoundedMoney(payment.payment),
      deposit_received: toRoundedMoney(payment.deposit),
      remaining_balance: remaining,
      profile_completeness: {
        is_complete: completeness.is_complete,
        missing_fields: completeness.missing_fields,
        is_thai: completeness.is_thai,
      },
    };
  });
}
