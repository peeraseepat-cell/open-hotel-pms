/**
 * Linked Stay Management — Link / Unlink reservations manually.
 *
 * Link: Connect two independent reservations into a linked stay group.
 * Unlink: Detach a child reservation from its linked stay group.
 *
 * Guards:
 * - Link: dates must be contiguous, same guest profile, no date overlap,
 *   neither cancelled/no_show, target must not already belong to another group.
 * - Unlink: must not have pending planned moves that cross booking boundary,
 *   child must exist and be linked to the specified parent.
 */

import { normalizeAuditSource } from "@/lib/audit-utils";
import { resolveBusinessDate, toLocalDate } from "@/lib/folio-fees";

type SupabaseLike = {
  from: (table: string) => any;
};

export class LinkedStayManagementError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "LinkedStayManagementError";
    this.status = status;
  }
}

type AuditSource = "manual" | "system" | "api" | "night_audit";

// ─── Link ───────────────────────────────────────────────────────────────

export type LinkStayPayload = {
  /** The reservation to become child (will get parent_reservation_id set) */
  child_reservation_id: string;
  /** Optional note for audit trail */
  note?: string | null;
};

export type LinkStayResult = {
  success: true;
  parent_reservation_id: string;
  child_reservation_id: string;
  linked_count: number;
};

type ReservationForLink = {
  id: string;
  parent_reservation_id: string | null;
  guest_profile_id: string | null;
  guest_name: string | null;
  checkin_date: string;
  checkout_date: string;
  status: string;
  checked_in_at: string | null;
  checkin_time: string | null;
};

/** Mirror A1 helper in linked-extension.ts — HH:mm Asia/Bangkok from ISO. */
function extractHHmmFromIso(iso: string | null): string | null {
  const value = String(iso ?? "").trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok",
  }).format(date);
}

export async function linkStay(params: {
  supabase: SupabaseLike;
  parentReservationId: string;
  payload: LinkStayPayload;
  auditSource?: AuditSource;
}): Promise<LinkStayResult> {
  const { supabase, parentReservationId } = params;
  const { child_reservation_id, note } = params.payload;
  const auditSource = normalizeAuditSource(params.auditSource ?? "manual");
  const businessDate = await resolveBusinessDate(supabase as any, toLocalDate(new Date(), "Asia/Bangkok"));

  if (parentReservationId === child_reservation_id) {
    throw new LinkedStayManagementError("Cannot link a reservation to itself.");
  }

  // Load both reservations
  const { data: rows, error: loadError } = await supabase
    .from("reservations")
    .select("id, parent_reservation_id, guest_profile_id, guest_name, checkin_date, checkout_date, status, checked_in_at, checkin_time")
    .in("id", [parentReservationId, child_reservation_id]);

  if (loadError) {
    throw new LinkedStayManagementError(loadError.message ?? "Failed to load reservations.", 500);
  }

  const parent = (rows ?? []).find((r: ReservationForLink) => String(r.id) === parentReservationId) as ReservationForLink | undefined;
  const child = (rows ?? []).find((r: ReservationForLink) => String(r.id) === child_reservation_id) as ReservationForLink | undefined;

  if (!parent) throw new LinkedStayManagementError("Parent reservation not found.", 404);
  if (!child) throw new LinkedStayManagementError("Child reservation not found.", 404);

  // Guard: both must be active
  const suppressedStatuses = ["cancelled", "no_show"];
  if (suppressedStatuses.includes(String(parent.status).toLowerCase())) {
    throw new LinkedStayManagementError("Parent reservation is cancelled or no-show. Cannot link.");
  }
  if (suppressedStatuses.includes(String(child.status).toLowerCase())) {
    throw new LinkedStayManagementError("Child reservation is cancelled or no-show. Cannot link.");
  }

  // Guard: child must not already be linked to a different parent
  if (child.parent_reservation_id && String(child.parent_reservation_id) !== parentReservationId) {
    throw new LinkedStayManagementError(
      "Child reservation is already linked to a different parent. Unlink it first."
    );
  }
  if (child.parent_reservation_id && String(child.parent_reservation_id) === parentReservationId) {
    throw new LinkedStayManagementError("Reservations are already linked.");
  }

  // Guard: same guest (by profile or name fallback)
  const sameGuest =
    (parent.guest_profile_id && child.guest_profile_id && parent.guest_profile_id === child.guest_profile_id) ||
    (!parent.guest_profile_id && !child.guest_profile_id &&
      String(parent.guest_name ?? "").toLowerCase().trim() === String(child.guest_name ?? "").toLowerCase().trim());

  if (!sameGuest) {
    throw new LinkedStayManagementError(
      "Reservations must belong to the same guest to be linked."
    );
  }

  // Guard: dates must be contiguous (parent checkout = child checkin, or child checkout = parent checkin)
  const parentCheckout = String(parent.checkout_date);
  const childCheckin = String(child.checkin_date);
  const childCheckout = String(child.checkout_date);
  const parentCheckin = String(parent.checkin_date);

  const isContiguous = parentCheckout === childCheckin || childCheckout === parentCheckin;
  if (!isContiguous) {
    throw new LinkedStayManagementError(
      `Reservations must have contiguous dates to be linked. Parent checkout (${parentCheckout}) must equal child check-in (${childCheckin}), or vice versa.`
    );
  }

  // Determine the root parent — if parent itself has a parent, chain to root
  const rootParentId = parent.parent_reservation_id
    ? String(parent.parent_reservation_id)
    : parentReservationId;

  // If dates are reversed (child is actually before parent), swap relationship:
  // the one with earlier checkin should be root/parent
  const reversedDates = childCheckout === parentCheckin;
  const earlier = reversedDates ? child : parent;
  const later = reversedDates ? parent : child;
  const autoCheckedIn = Boolean(
    earlier.checked_in_at && earlier.status === "active" &&
    !later.checked_in_at && later.status === "active"
  );
  const inheritedFields = autoCheckedIn ? {
    status: "active",
    checked_in_at: earlier.checked_in_at,
    checkin_time: String(earlier.checkin_time ?? "").trim() || extractHHmmFromIso(earlier.checked_in_at),
  } : {};

  let effectiveRootId = rootParentId;
  if (childCheckout === parentCheckin) {
    // Child is chronologically before parent — child should be root
    // Set parent's parent_reservation_id = child, and child stays root
    effectiveRootId = child_reservation_id;

    const { error: swapError } = await supabase
      .from("reservations")
      .update({ parent_reservation_id: child_reservation_id, ...inheritedFields })
      .eq("id", parentReservationId);

    if (swapError) {
      throw new LinkedStayManagementError(swapError.message ?? "Failed to update link.", 500);
    }
  } else {
    // Normal case: parent checkout = child checkin
    const { error: linkError } = await supabase
      .from("reservations")
      .update({ parent_reservation_id: effectiveRootId, ...inheritedFields })
      .eq("id", child_reservation_id);

    if (linkError) {
      throw new LinkedStayManagementError(linkError.message ?? "Failed to update link.", 500);
    }
  }

  // Count total linked segments
  const { count } = await supabase
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("parent_reservation_id", effectiveRootId);

  const linkedCount = (count ?? 0) + 1; // +1 for root itself

  if (autoCheckedIn) {
    try {
      for (const action of ["checked_in", "auto_checkin_linked_extension"]) {
        await supabase.from("audit_logs").insert({
          action, entity_type: "reservation", entity_id: later.id,
          before_json: { parent_reservation_id: effectiveRootId },
          after_json: { ...inheritedFields, reason: "Inherited check-in from linked stay" },
          business_date: businessDate, source: auditSource,
        });
      }
    } catch { /* The reservation update already succeeded. */ }
  }

  // Audit log
  await supabase.from("audit_logs").insert({
    action: "linked_stay_manual_link",
    entity_type: "reservation",
    entity_id: child_reservation_id,
    before_json: {
      child_parent_reservation_id: child.parent_reservation_id,
    },
    after_json: {
      parent_reservation_id: effectiveRootId,
      linked_count: linkedCount,
      note: note || null,
      auto_checked_in: autoCheckedIn,
    },
    business_date: businessDate,
    source: auditSource,
  });

  return {
    success: true,
    parent_reservation_id: effectiveRootId,
    child_reservation_id,
    linked_count: linkedCount,
  };
}

// ─── Unlink ─────────────────────────────────────────────────────────────

export type UnlinkStayPayload = {
  /** Optional note explaining why unlinking */
  note?: string | null;
};

export type UnlinkStayResult = {
  success: true;
  unlinked_reservation_id: string;
  previous_parent_id: string;
  remaining_linked_count: number;
  warnings: string[];
};

export async function unlinkStay(params: {
  supabase: SupabaseLike;
  reservationId: string;
  payload: UnlinkStayPayload;
  auditSource?: AuditSource;
}): Promise<UnlinkStayResult> {
  const { supabase, reservationId } = params;
  const { note } = params.payload;
  const auditSource = normalizeAuditSource(params.auditSource ?? "manual");
  const businessDate = await resolveBusinessDate(supabase as any, toLocalDate(new Date(), "Asia/Bangkok"));
  const warnings: string[] = [];

  // Load child reservation (the one being unlinked)
  const { data: reservation, error: loadError } = await supabase
    .from("reservations")
    .select("id, parent_reservation_id, status, checkin_date, checkout_date, checked_in_at, checkin_time")
    .eq("id", reservationId)
    .maybeSingle();

  if (loadError) {
    throw new LinkedStayManagementError(loadError.message ?? "Failed to load reservation.", 500);
  }
  if (!reservation) {
    throw new LinkedStayManagementError("Reservation not found.", 404);
  }

  const parentId = reservation.parent_reservation_id
    ? String(reservation.parent_reservation_id)
    : null;

  if (!parentId) {
    throw new LinkedStayManagementError(
      "This reservation is not linked to any parent. Nothing to unlink."
    );
  }

  // Guard: Transition already happened — parent checked out + child checked in
  // After checkout, the parent booking is closed and immutable.
  // The child is now the "active" booking — unlinking would orphan the history.
  // Example: Parent 20-22 Mar (OTA), Child 22-24 Mar (Walk-in)
  //   - 22 Mar before checkout: OK to unlink (parent still open)
  //   - 22 Mar after parent C/O + child C/I: BLOCKED (transition done, parent closed)
  const { data: parentReservation, error: parentLoadError } = await supabase
    .from("reservations")
    .select("id, status, checked_in_at, checkin_time, checkout_date")
    .eq("id", parentId)
    .maybeSingle();

  if (parentLoadError) {
    throw new LinkedStayManagementError(parentLoadError.message ?? "Failed to load parent reservation.", 500);
  }
  if (!parentReservation) {
    throw new LinkedStayManagementError("Parent reservation not found.", 404);
  }

  const parentIsCheckedOut = String(parentReservation.status ?? "").toLowerCase() === "checked_out";
  const childIsCheckedIn = Boolean(reservation.checked_in_at);

  if (parentIsCheckedOut && childIsCheckedIn) {
    throw new LinkedStayManagementError(
      "Cannot unlink: parent has already checked out and this booking has checked in. " +
      "The stay transition is complete — parent is closed. " +
      "All modifications should be made on this (child) booking directly."
    );
  }

  // Guard: check for pending planned moves that cross this booking's dates
  const { data: crossingPlans, error: plansError } = await supabase
    .from("reservation_room_plans")
    .select("id, reservation_id, start_date, end_date, status")
    .eq("status", "planned")
    .or(`reservation_id.eq.${reservationId},reservation_id.eq.${parentId}`);

  if (plansError) {
    warnings.push(`Could not verify planned moves: ${plansError.message}`);
  } else if ((crossingPlans ?? []).length > 0) {
    const pendingCount = (crossingPlans ?? []).length;
    throw new LinkedStayManagementError(
      `Cannot unlink: ${pendingCount} pending planned move(s) exist on this linked stay. Cancel or execute them first.`
    );
  }

  // Clear inherited check-in when parent is still in-house and stamps match (FO Unlink→Link smoke).
  // Independent check-ins (different timestamps) are left alone.
  let clearedInheritedCheckin = false;
  const parentCheckedInAt = parentReservation.checked_in_at
    ? String(parentReservation.checked_in_at)
    : null;
  const childCheckedInAt = reservation.checked_in_at ? String(reservation.checked_in_at) : null;
  const parentStillInHouse =
    Boolean(parentCheckedInAt) &&
    String(parentReservation.status ?? "").toLowerCase() !== "checked_out";
  const stampsMatch =
    Boolean(childCheckedInAt) &&
    Boolean(parentCheckedInAt) &&
    childCheckedInAt === parentCheckedInAt;

  clearedInheritedCheckin = parentStillInHouse && stampsMatch;

  // Perform unlink
  const { error: unlinkError } = await supabase
    .from("reservations")
    .update({
      parent_reservation_id: null,
      ...(clearedInheritedCheckin ? { checked_in_at: null, checkin_time: null } : {}),
    })
    .eq("id", reservationId);

  if (unlinkError) {
    throw new LinkedStayManagementError(unlinkError.message ?? "Failed to unlink reservation.", 500);
  }

  if (clearedInheritedCheckin) {
    try {
      await supabase.from("audit_logs").insert({
        action: "linked_stay_clear_inherited_checkin",
        entity_type: "reservation", entity_id: reservationId,
        before_json: { parent_reservation_id: parentId, checked_in_at: childCheckedInAt, checkin_time: reservation.checkin_time ?? null },
        after_json: { parent_reservation_id: null, checked_in_at: null, checkin_time: null },
        business_date: businessDate, source: auditSource,
      });
    } catch { /* The reservation update already succeeded. */ }
  }

  // Check if this was the root being unlinked (other children might reference this)
  // If the unlinked reservation IS the parent that children reference, re-parent children
  const { data: orphanedChildren, error: orphanError } = await supabase
    .from("reservations")
    .select("id")
    .eq("parent_reservation_id", reservationId);

  if (!orphanError && (orphanedChildren ?? []).length > 0) {
    // Re-parent orphaned children to the grandparent, or make the first child the new root
    // Since we're unlinking `reservationId` which was also a parent, we need to
    // reassign children to the original parent of `reservationId` (which is `parentId`)
    const orphanIds = (orphanedChildren ?? []).map((r: any) => String(r.id));
    const { error: reparentError } = await supabase
      .from("reservations")
      .update({ parent_reservation_id: parentId })
      .in("id", orphanIds);

    if (reparentError) {
      warnings.push(`Re-parenting ${orphanIds.length} child reservation(s) failed: ${reparentError.message}`);
    }
  }

  // Count remaining linked segments
  const { count } = await supabase
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("parent_reservation_id", parentId);

  const remainingCount = (count ?? 0) + 1; // +1 for root

  // Audit log
  await supabase.from("audit_logs").insert({
    action: "linked_stay_manual_unlink",
    entity_type: "reservation",
    entity_id: reservationId,
    before_json: {
      parent_reservation_id: parentId,
    },
    after_json: {
      parent_reservation_id: null,
      remaining_linked_count: remainingCount,
      note: note || null,
      cleared_inherited_checkin: clearedInheritedCheckin,
    },
    business_date: businessDate,
    source: auditSource,
  });

  return {
    success: true,
    unlinked_reservation_id: reservationId,
    previous_parent_id: parentId,
    remaining_linked_count: remainingCount,
    warnings,
  };
}
