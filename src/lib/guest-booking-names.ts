import { classifyGuestNameMatch, normalizeGuestName } from "@/lib/guest-name-match";

type SupabaseLike = {
  from: (table: string) => any;
};

function isGuestBookingNamesTableMissing(message?: string | null): boolean {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes("guest_profile_booking_names") && (
    normalized.includes("does not exist")
    || normalized.includes("could not find")
    || normalized.includes("relation")
    || normalized.includes("schema cache")
  );
}

export type GuestBookingNameAlias = {
  id: string;
  guest_profile_id: string;
  booking_name: string;
  normalized_booking_name: string;
  source_reservation_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  seen_count: number | null;
};

export type PossibleReturnCandidate = {
  profile: {
    id: string;
    member_no: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    nationality_code: string | null;
    stay_count: number;
    vip_tier: string | null;
    last_stay_date: string | null;
  };
  score: number;
  match_level: "strong" | "possible" | "new";
  matched_booking_name: string | null;
};

export function normalizeBookingName(value: unknown): string {
  return normalizeGuestName(value);
}

export function normalizeBookingNameDisplay(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function shouldStoreBookingNameAlias(params: {
  bookingName: unknown;
  actualName: unknown;
}): boolean {
  const normalizedBooking = normalizeBookingName(params.bookingName);
  const normalizedActual = normalizeBookingName(params.actualName);
  if (!normalizedBooking) return false;
  if (!normalizedActual) return true;
  return normalizedBooking !== normalizedActual;
}

export async function upsertGuestProfileBookingName(params: {
  supabase: SupabaseLike;
  guestProfileId: string;
  bookingName: unknown;
  sourceReservationId?: string | null;
  seenAt?: string | null;
}): Promise<GuestBookingNameAlias | null> {
  const { supabase, guestProfileId } = params;
  const profileId = String(guestProfileId ?? "").trim();
  const bookingName = normalizeBookingNameDisplay(params.bookingName);
  const normalizedBookingName = normalizeBookingName(bookingName);
  if (!profileId || !bookingName || !normalizedBookingName) return null;

  const seenAt = params.seenAt ? String(params.seenAt) : new Date().toISOString();
  const sourceReservationId = params.sourceReservationId ? String(params.sourceReservationId) : null;

  const { data: existing, error: existingError } = await supabase
    .from("guest_profile_booking_names")
    .select("id, guest_profile_id, booking_name, normalized_booking_name, source_reservation_id, first_seen_at, last_seen_at, seen_count")
    .eq("guest_profile_id", profileId)
    .eq("normalized_booking_name", normalizedBookingName)
    .maybeSingle();

  if (existingError) {
    if (isGuestBookingNamesTableMissing(existingError.message)) return null;
    throw new Error(existingError.message ?? "Failed to lookup guest booking names.");
  }

  if (existing?.id) {
    const nextSeenCount = Math.max(1, Number(existing.seen_count ?? 0)) + 1;
    const { data: updated, error: updateError } = await supabase
      .from("guest_profile_booking_names")
      .update({
        booking_name: bookingName,
        source_reservation_id: sourceReservationId ?? existing.source_reservation_id ?? null,
        last_seen_at: seenAt,
        seen_count: nextSeenCount,
      })
      .eq("id", String(existing.id))
      .select("id, guest_profile_id, booking_name, normalized_booking_name, source_reservation_id, first_seen_at, last_seen_at, seen_count")
      .maybeSingle();

    if (updateError) {
      if (isGuestBookingNamesTableMissing(updateError.message)) return null;
      throw new Error(updateError.message ?? "Failed to update guest booking name.");
    }
    return (updated as GuestBookingNameAlias | null) ?? null;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("guest_profile_booking_names")
    .insert({
      guest_profile_id: profileId,
      booking_name: bookingName,
      normalized_booking_name: normalizedBookingName,
      source_reservation_id: sourceReservationId,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
      seen_count: 1,
    })
    .select("id, guest_profile_id, booking_name, normalized_booking_name, source_reservation_id, first_seen_at, last_seen_at, seen_count")
    .maybeSingle();

  if (insertError) {
    if (isGuestBookingNamesTableMissing(insertError.message)) return null;
    throw new Error(insertError.message ?? "Failed to insert guest booking name.");
  }

  return (inserted as GuestBookingNameAlias | null) ?? null;
}

export async function syncReservationBookingNameAlias(params: {
  supabase: SupabaseLike;
  guestProfileId: string;
  bookingName: unknown;
  actualName: unknown;
  sourceReservationId?: string | null;
  seenAt?: string | null;
}): Promise<void> {
  if (!shouldStoreBookingNameAlias({
    bookingName: params.bookingName,
    actualName: params.actualName,
  })) {
    return;
  }

  await upsertGuestProfileBookingName({
    supabase: params.supabase,
    guestProfileId: params.guestProfileId,
    bookingName: params.bookingName,
    sourceReservationId: params.sourceReservationId ?? null,
    seenAt: params.seenAt ?? null,
  });
}

export async function listGuestProfileBookingNames(
  supabase: SupabaseLike,
  guestProfileId: string
): Promise<string[]> {
  const profileId = String(guestProfileId ?? "").trim();
  if (!profileId) return [];

  const { data, error } = await supabase
    .from("guest_profile_booking_names")
    .select("booking_name, last_seen_at")
    .eq("guest_profile_id", profileId)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .order("booking_name", { ascending: true });

  if (error) {
    if (isGuestBookingNamesTableMissing(error.message)) return [];
    throw new Error(error.message ?? "Failed to list guest booking names.");
  }

  return Array.from(
    new Set(
      (data ?? [])
        .map((row: any) => normalizeBookingNameDisplay(row?.booking_name))
        .filter(Boolean)
    )
  );
}

export async function replaceGuestProfileBookingNames(params: {
  supabase: SupabaseLike;
  guestProfileId: string;
  bookingNames: unknown[];
}): Promise<void> {
  const { supabase } = params;
  const profileId = String(params.guestProfileId ?? "").trim();
  if (!profileId) return;

  const normalizedRows = Array.from(
    new Map(
      (Array.isArray(params.bookingNames) ? params.bookingNames : [])
        .map((value) => {
          const bookingName = normalizeBookingNameDisplay(value);
          const normalizedBookingName = normalizeBookingName(bookingName);
          if (!bookingName || !normalizedBookingName) return null;
          return [normalizedBookingName, bookingName] as const;
        })
        .filter((row): row is readonly [string, string] => Boolean(row))
    ).entries()
  ).map(([normalized_booking_name, booking_name]) => ({
    normalized_booking_name,
    booking_name,
  }));

  const { data: existingRows, error: existingError } = await supabase
    .from("guest_profile_booking_names")
    .select("id, normalized_booking_name")
    .eq("guest_profile_id", profileId);

  if (existingError) {
    if (isGuestBookingNamesTableMissing(existingError.message)) return;
    throw new Error(existingError.message ?? "Failed to load guest booking names.");
  }

  const keepNames = new Set(normalizedRows.map((row) => row.normalized_booking_name));
  const deleteIds = (existingRows ?? [])
    .filter((row: any) => !keepNames.has(String(row?.normalized_booking_name ?? "").trim()))
    .map((row: any) => String(row?.id ?? "").trim())
    .filter(Boolean);

  if (deleteIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("guest_profile_booking_names")
      .delete()
      .in("id", deleteIds);

    if (deleteError) {
      if (isGuestBookingNamesTableMissing(deleteError.message)) return;
      throw new Error(deleteError.message ?? "Failed to delete guest booking names.");
    }
  }

  const seenAt = new Date().toISOString();
  for (const row of normalizedRows) {
    await upsertGuestProfileBookingName({
      supabase,
      guestProfileId: profileId,
      bookingName: row.booking_name,
      seenAt,
    });
  }
}

export async function mergeGuestProfileBookingNames(params: {
  supabase: SupabaseLike;
  masterProfileId: string;
  sourceProfileId: string;
}): Promise<void> {
  const { supabase } = params;
  const masterProfileId = String(params.masterProfileId ?? "").trim();
  const sourceProfileId = String(params.sourceProfileId ?? "").trim();
  if (!masterProfileId || !sourceProfileId || masterProfileId === sourceProfileId) return;

  const { data: sourceRows, error: sourceError } = await supabase
    .from("guest_profile_booking_names")
    .select("id, booking_name, normalized_booking_name, source_reservation_id, first_seen_at, last_seen_at, seen_count")
    .eq("guest_profile_id", sourceProfileId);

  if (sourceError) {
    if (isGuestBookingNamesTableMissing(sourceError.message)) return;
    throw new Error(sourceError.message ?? "Failed to load source guest booking names.");
  }

  for (const row of sourceRows ?? []) {
    const bookingName = normalizeBookingNameDisplay((row as any)?.booking_name);
    const normalizedBookingName = normalizeBookingName(bookingName);
    if (!bookingName || !normalizedBookingName) continue;

    const { data: existing, error: existingError } = await supabase
      .from("guest_profile_booking_names")
      .select("id, seen_count, first_seen_at, last_seen_at, source_reservation_id")
      .eq("guest_profile_id", masterProfileId)
      .eq("normalized_booking_name", normalizedBookingName)
      .maybeSingle();

    if (existingError) {
      if (isGuestBookingNamesTableMissing(existingError.message)) return;
      throw new Error(existingError.message ?? "Failed to load master guest booking name.");
    }

    if (existing?.id) {
      const nextSeenCount = Math.max(1, Number(existing.seen_count ?? 0)) + Math.max(1, Number((row as any)?.seen_count ?? 0));
      const firstSeenAt = [existing.first_seen_at, (row as any)?.first_seen_at]
        .filter(Boolean)
        .sort()[0] ?? null;
      const lastSeenAt = [existing.last_seen_at, (row as any)?.last_seen_at]
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ?? null;

      const { error: updateError } = await supabase
        .from("guest_profile_booking_names")
        .update({
          booking_name: bookingName,
          first_seen_at: firstSeenAt,
          last_seen_at: lastSeenAt,
          source_reservation_id: existing.source_reservation_id ?? (row as any)?.source_reservation_id ?? null,
          seen_count: nextSeenCount,
        })
        .eq("id", String(existing.id));

      if (updateError) {
        if (isGuestBookingNamesTableMissing(updateError.message)) return;
        throw new Error(updateError.message ?? "Failed to merge guest booking name.");
      }
    } else {
      const { error: insertError } = await supabase
        .from("guest_profile_booking_names")
        .insert({
          guest_profile_id: masterProfileId,
          booking_name: bookingName,
          normalized_booking_name: normalizedBookingName,
          source_reservation_id: (row as any)?.source_reservation_id ?? null,
          first_seen_at: (row as any)?.first_seen_at ?? null,
          last_seen_at: (row as any)?.last_seen_at ?? null,
          seen_count: Math.max(1, Number((row as any)?.seen_count ?? 0)),
        });

      if (insertError) {
        if (isGuestBookingNamesTableMissing(insertError.message)) return;
        throw new Error(insertError.message ?? "Failed to insert merged guest booking name.");
      }
    }
  }

  const { error: deleteError } = await supabase
    .from("guest_profile_booking_names")
    .delete()
    .eq("guest_profile_id", sourceProfileId);

  if (deleteError) {
    if (isGuestBookingNamesTableMissing(deleteError.message)) return;
    throw new Error(deleteError.message ?? "Failed to cleanup source guest booking names.");
  }
}

export async function findPossibleReturnCandidatesByBookingNames(
  supabase: SupabaseLike,
  rows: Array<{
    reservation_id: string;
    booking_name: unknown;
    exclude_guest_profile_id?: string | null;
  }>
): Promise<Map<string, PossibleReturnCandidate[]>> {
  const normalizedToReservationIds = new Map<string, string[]>();
  const excludeByReservationId = new Map<string, string | null>();

  for (const row of rows) {
    const reservationId = String(row.reservation_id ?? "").trim();
    const normalizedBookingName = normalizeBookingName(row.booking_name);
    if (!reservationId || !normalizedBookingName) continue;
    const current = normalizedToReservationIds.get(normalizedBookingName);
    if (current) current.push(reservationId);
    else normalizedToReservationIds.set(normalizedBookingName, [reservationId]);
    excludeByReservationId.set(
      reservationId,
      row.exclude_guest_profile_id ? String(row.exclude_guest_profile_id) : null
    );
  }

  if (normalizedToReservationIds.size === 0) {
    return new Map<string, PossibleReturnCandidate[]>();
  }

  const { data, error } = await supabase
    .from("guest_profile_booking_names")
    .select(`
      guest_profile_id,
      booking_name,
      normalized_booking_name,
      guest_profiles(
        id,
        member_no,
        first_name,
        last_name,
        phone,
        email,
        nationality_code,
        vip_tier,
        stay_count,
        last_stay_date,
        profile_status
      )
    `)
    .in("normalized_booking_name", Array.from(normalizedToReservationIds.keys()));

  if (error) {
    if (isGuestBookingNamesTableMissing(error.message)) {
      return new Map<string, PossibleReturnCandidate[]>();
    }
    throw new Error(error.message ?? "Failed to load possible return candidates.");
  }

  const result = new Map<string, PossibleReturnCandidate[]>();
  const dedupe = new Set<string>();

  for (const row of data ?? []) {
    const normalizedBookingName = String((row as any)?.normalized_booking_name ?? "").trim();
    if (!normalizedBookingName) continue;
    const reservationIds = normalizedToReservationIds.get(normalizedBookingName) ?? [];
    const profile = Array.isArray((row as any)?.guest_profiles)
      ? (row as any).guest_profiles[0]
      : (row as any)?.guest_profiles;
    const profileId = String(profile?.id ?? "").trim();
    if (!profileId) continue;
    if (String(profile?.profile_status ?? "").trim() === "merged") continue;

    const stayCount = Number(profile?.stay_count ?? 0);
    const lastStayDate = profile?.last_stay_date ? String(profile.last_stay_date) : null;
    if (stayCount <= 0 && !lastStayDate) continue;

    for (const reservationId of reservationIds) {
      const excludeGuestProfileId = excludeByReservationId.get(reservationId);
      if (excludeGuestProfileId && excludeGuestProfileId === profileId) continue;

      const dedupeKey = `${reservationId}:${profileId}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      const current = result.get(reservationId) ?? [];
      current.push({
        profile: {
          id: profileId,
          member_no: profile?.member_no ? String(profile.member_no) : null,
          first_name: profile?.first_name ? String(profile.first_name) : null,
          last_name: profile?.last_name ? String(profile.last_name) : null,
          phone: profile?.phone ? String(profile.phone) : null,
          email: profile?.email ? String(profile.email) : null,
          nationality_code: profile?.nationality_code ? String(profile.nationality_code) : null,
          stay_count: stayCount,
          vip_tier: profile?.vip_tier ? String(profile.vip_tier) : null,
          last_stay_date: lastStayDate,
        },
        score: 92,
        match_level: "strong",
        matched_booking_name: normalizeBookingNameDisplay((row as any)?.booking_name),
      });
      result.set(reservationId, current);
    }
  }

  result.forEach((matches, reservationId) => {
    result.set(
      reservationId,
      matches.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if ((right.profile.stay_count ?? 0) !== (left.profile.stay_count ?? 0)) {
          return (right.profile.stay_count ?? 0) - (left.profile.stay_count ?? 0);
        }
        return String(right.profile.last_stay_date ?? "").localeCompare(String(left.profile.last_stay_date ?? ""));
      })
    );
  });

  return result;
}

export function shouldForkSharedProfile(params: {
  profileId: string | null;
  reservationId: string | null | undefined;
  activeReservationCount: number;
  linkedProfileName: string;
  guestName: string;
  profileBookingNames: readonly string[];
}): boolean {
  if (!params.profileId || !params.reservationId) return false;
  if (params.activeReservationCount <= 1) return false;
  const guestNorm = normalizeGuestName(params.guestName);
  if (params.profileBookingNames.some((name) => normalizeGuestName(name) === guestNorm && guestNorm.length > 0)) {
    return false;
  }
  return classifyGuestNameMatch(params.linkedProfileName, params.guestName) === "mismatch";
}
