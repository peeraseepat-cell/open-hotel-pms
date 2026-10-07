export type BookingGroupStatus = "active" | "completed" | "cancelled";

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function deriveBookingGroupStatus(
  currentStatus: unknown,
  reservationStatuses: Array<unknown>
): BookingGroupStatus {
  const current = normalizeStatus(currentStatus);
  if (current === "cancelled") return "cancelled";

  const hasActive = reservationStatuses.some((status) => normalizeStatus(status) === "active");
  if (hasActive) return "active";

  if (reservationStatuses.length === 0) {
    return current === "completed" ? "completed" : "active";
  }

  return reservationStatuses.some((status) => normalizeStatus(status) === "checked_out") ? "completed" : "active";
}

export async function syncBookingGroupStatusById(
  supabase: any,
  groupId: string | null | undefined
): Promise<BookingGroupStatus | null> {
  if (!groupId) return null;

  const normalizedGroupId = String(groupId);
  const { data: group, error: groupError } = await supabase
    .from("booking_groups")
    .select("id, status")
    .eq("id", normalizedGroupId)
    .maybeSingle();

  if (groupError || !group) return null;

  const { data: reservations, error: reservationsError } = await supabase
    .from("reservations")
    .select("status")
    .eq("booking_group_id", normalizedGroupId);

  if (reservationsError) return null;

  const statuses = (reservations ?? []).map((row: any) => row?.status);
  const nextStatus = deriveBookingGroupStatus(group.status, statuses);
  const current = normalizeStatus(group.status);

  if (current !== nextStatus) {
    const { error: updateError } = await supabase
      .from("booking_groups")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", normalizedGroupId);
    if (updateError) return null;
  }

  return nextStatus;
}

export async function refreshBookingGroupTotalRooms(
  supabase: any,
  groupId: string | null | undefined
): Promise<number | null> {
  if (!groupId) return null;

  const normalizedGroupId = String(groupId);
  const { count, error: countError } = await supabase
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("booking_group_id", normalizedGroupId);

  if (countError) return null;

  const nextTotal = count ?? 0;
  const { error: updateError } = await supabase
    .from("booking_groups")
    .update({ total_rooms: nextTotal, updated_at: new Date().toISOString() })
    .eq("id", normalizedGroupId);

  if (updateError) return null;

  return nextTotal;
}
