import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const paramsSchema = z.object({
  id: z.string().uuid("Invalid reservation id"),
});

const addSchema = z.object({
  guest_profile_id: z.string().uuid("guest_profile_id must be uuid"),
  display_order: z.coerce.number().int().min(2).max(4).optional(),
});

const deleteQuerySchema = z.object({
  guest_profile_id: z.string().uuid("guest_profile_id must be uuid"),
});

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsedParams = paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      return NextResponse.json({ success: false, error: parsedParams.error.issues[0]?.message ?? "Invalid reservation id." }, { status: 400 });
    }

    const reservationId = parsedParams.data.id;
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { denyRoles: [] });
    if (auth.error) return auth.error;

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, guest_profile_id")
      .eq("id", reservationId)
      .maybeSingle();
    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }
    if (!reservation) {
      return NextResponse.json({ success: false, error: "Reservation not found." }, { status: 404 });
    }

    const { data: reservationGuests, error: reservationGuestsError } = await supabase
      .from("reservation_guests")
      .select("id, reservation_id, guest_profile_id, role, display_order, created_at")
      .eq("reservation_id", reservationId)
      .order("role", { ascending: true })
      .order("display_order", { ascending: true });
    if (reservationGuestsError) {
      return NextResponse.json({ success: false, error: reservationGuestsError.message }, { status: 500 });
    }

    const rows = [...(reservationGuests ?? [])] as Array<{
      id: string;
      reservation_id: string;
      guest_profile_id: string;
      role: "primary" | "accompanying";
      display_order: number;
      created_at: string;
    }>;

    const uniqueGuestIds = Array.from(new Set(rows.map((row) => String(row.guest_profile_id)).filter(Boolean)));
    let guestMap = new Map<string, Record<string, unknown>>();
    if (uniqueGuestIds.length > 0) {
      const { data: guests, error: guestsError } = await supabase
        .from("guest_profiles")
        .select("id, first_name, last_name, phone, nationality_code, country, profile_status")
        .in("id", uniqueGuestIds);
      if (guestsError) {
        return NextResponse.json({ success: false, error: guestsError.message }, { status: 500 });
      }
      guestMap = new Map((guests ?? []).map((row: any) => [String(row.id), row]));
    }

    return NextResponse.json({
      success: true,
      reservation_id: reservationId,
      guests: rows
        .map((row) => ({
          ...row,
          guest_profile: guestMap.get(String(row.guest_profile_id)) ?? null,
        }))
        .sort((a, b) => {
          if (a.role === b.role) return a.display_order - b.display_order;
          return a.role === "primary" ? -1 : 1;
        }),
    });
  } catch (err) {
    console.error("api/bookings/[id]/guests GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsedParams = paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      return NextResponse.json({ success: false, error: parsedParams.error.issues[0]?.message ?? "Invalid reservation id." }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const parsedBody = addSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const reservationId = parsedParams.data.id;
    const guestProfileId = parsedBody.data.guest_profile_id;
    const supabase = createServerSupabaseClient();

    const [{ data: reservation, error: reservationError }, { data: profile, error: profileError }] = await Promise.all([
      supabase
        .from("reservations")
        .select("id, guest_profile_id")
        .eq("id", reservationId)
        .maybeSingle(),
      supabase
        .from("guest_profiles")
        .select("id, profile_status, merged_into")
        .eq("id", guestProfileId)
        .maybeSingle(),
    ]);

    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }
    if (!reservation) {
      return NextResponse.json({ success: false, error: "Reservation not found." }, { status: 404 });
    }
    if (profileError) {
      return NextResponse.json({ success: false, error: profileError.message }, { status: 500 });
    }
    if (!profile) {
      return NextResponse.json({ success: false, error: "Guest profile not found." }, { status: 404 });
    }
    if (profile.profile_status === "merged") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot link merged guest profile.",
          merged_into: profile.merged_into ?? null,
        },
        { status: 409 }
      );
    }

    const { data: existingGuests, error: existingGuestsError } = await supabase
      .from("reservation_guests")
      .select("id, guest_profile_id, role, display_order")
      .eq("reservation_id", reservationId);
    if (existingGuestsError) {
      return NextResponse.json({ success: false, error: existingGuestsError.message }, { status: 500 });
    }

    const rows = existingGuests ?? [];
    const hasPersistedPrimary = rows.some((row: any) => row.role === "primary");
    const currentPrimaryGuestId = hasPersistedPrimary
      ? String(rows.find((row: any) => row.role === "primary")?.guest_profile_id ?? "")
      : reservation.guest_profile_id
        ? String(reservation.guest_profile_id)
        : null;

    if (currentPrimaryGuestId && currentPrimaryGuestId === guestProfileId) {
      return NextResponse.json(
        { success: false, error: "Primary guest cannot be added as accompanying." },
        { status: 409 }
      );
    }

    if (rows.some((row: any) => String(row.guest_profile_id) === guestProfileId)) {
      return NextResponse.json(
        { success: false, error: "Guest already linked in this reservation." },
        { status: 409 }
      );
    }

    const effectiveTotal = rows.length + (!hasPersistedPrimary && currentPrimaryGuestId ? 1 : 0);
    if (effectiveTotal >= 4) {
      return NextResponse.json({ success: false, error: "Maximum 4 total guests per reservation." }, { status: 409 });
    }

    const occupied = new Set(
      rows
        .filter((row: any) => row.role === "accompanying")
        .map((row: any) => Number(row.display_order))
    );
    let displayOrder = parsedBody.data.display_order ?? null;
    if (displayOrder != null) {
      if (occupied.has(displayOrder)) {
        return NextResponse.json({ success: false, error: `display_order ${displayOrder} is already used.` }, { status: 409 });
      }
    } else {
      for (const slot of [2, 3, 4]) {
        if (!occupied.has(slot)) {
          displayOrder = slot;
          break;
        }
      }
    }
    if (displayOrder == null) {
      return NextResponse.json({ success: false, error: "No available display_order slots." }, { status: 409 });
    }

    const { data: inserted, error: insertError } = await supabase
      .from("reservation_guests")
      .insert({
        reservation_id: reservationId,
        guest_profile_id: guestProfileId,
        role: "accompanying",
        display_order: displayOrder,
      })
      .select("*")
      .maybeSingle();

    if (insertError) {
      if (insertError.code === "23505") {
        return NextResponse.json({ success: false, error: "Guest already linked or display order is not available." }, { status: 409 });
      }
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, guest: inserted });
  } catch (err) {
    console.error("api/bookings/[id]/guests POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsedParams = paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      return NextResponse.json({ success: false, error: parsedParams.error.issues[0]?.message ?? "Invalid reservation id." }, { status: 400 });
    }
    const parsedQuery = deleteQuerySchema.safeParse({
      guest_profile_id: request.nextUrl.searchParams.get("guest_profile_id") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { success: false, error: parsedQuery.error.issues[0]?.message ?? "Invalid query." },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const { data: removal, error } = await supabase.rpc("remove_accompanying_guest", {
      p_reservation_id: parsedParams.data.id,
      p_guest_profile_id: parsedQuery.data.guest_profile_id,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!removal || Number(removal.removed) === 0) {
      return NextResponse.json({ success: false, error: "Accompanying guest link not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, removed: Number(removal.removed) });
  } catch (err) {
    console.error("api/bookings/[id]/guests DELETE failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
