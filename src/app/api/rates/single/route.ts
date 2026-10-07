import type { RateSingleEditRequest, RateSingleEditResponse } from "@/lib/rates/types";
import { requireStaffAuth } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { verifyRateOverrideToken } from "@/lib/admin/pin";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function jsonError(payload: RateSingleEditResponse, status: number) {
  return NextResponse.json(payload, { status });
}

async function loadRoomContext(supabase: ReturnType<typeof createServerSupabaseClient>, roomId: string) {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, room_type_id, is_sellable, is_dayuse")
    .eq("id", roomId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    room_id: String((data as any).id),
    room_type_id: String((data as any).room_type_id),
    is_sellable: Boolean((data as any).is_sellable ?? true),
    is_dayuse: Boolean((data as any).is_dayuse ?? false),
  };
}

async function loadTypeRooms(supabase: ReturnType<typeof createServerSupabaseClient>, roomTypeId: string) {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, is_sellable, is_dayuse")
    .eq("room_type_id", roomTypeId)
    .eq("is_sellable", true)
    .eq("is_dayuse", false)
    .order("room_number", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: any) => String(row.id));
}

async function loadMinRateFloor(supabase: ReturnType<typeof createServerSupabaseClient>, roomTypeId: string) {
  const { data, error } = await supabase
    .from("room_types")
    .select("min_rate_floor")
    .eq("id", roomTypeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const floor = (data as any).min_rate_floor;
  return floor == null ? null : Number(floor);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
    if (auth.error) return auth.error;
    const body = (await request.json().catch(() => null)) as RateSingleEditRequest | null;

    const mode = body?.mode === "type" ? "type" : "room";
    const roomId = body?.room_id ? String(body.room_id) : "";
    const roomTypeId = body?.room_type_id ? String(body.room_type_id) : "";
    const date = String(body?.date ?? "").trim();
    const price = Number(body?.price);

    if (!date || !Number.isFinite(price)) {
      return jsonError({ success: false, error: "Missing room/date/price." }, 400);
    }
    if (price < 0) {
      return jsonError({ success: false, error: "Price cannot be negative." }, 400);
    }

    let resolvedRoomTypeId = roomTypeId;
    let roomIds: string[] = [];

    if (mode === "room") {
      if (!roomId) {
        return jsonError({ success: false, error: "room_id is required when mode='room'." }, 400);
      }
      const room = await loadRoomContext(supabase, roomId);
      if (!room) {
        return jsonError({ success: false, error: "Room not found." }, 404);
      }
      resolvedRoomTypeId = room.room_type_id;
      roomIds = [room.room_id];
    } else {
      if (!resolvedRoomTypeId) {
        return jsonError({ success: false, error: "room_type_id is required when mode='type'." }, 400);
      }
      roomIds = await loadTypeRooms(supabase, resolvedRoomTypeId);
      if (roomIds.length === 0) {
        return jsonError({ success: false, error: "No sellable rooms found for this room type." }, 404);
      }
    }

    const floor = await loadMinRateFloor(supabase, resolvedRoomTypeId);
    const hasOverride = verifyRateOverrideToken(body?.override_token, auth.user.id);
    if (floor != null && price < floor && !hasOverride) {
      return jsonError(
        {
          success: false,
          error: "Price is below the configured floor.",
          floor_violation: true,
          floor,
        },
        409
      );
    }

    const nowIso = new Date().toISOString();
    const rows = roomIds.map((id) => ({
      room_id: id,
      stay_date: date,
      price,
      updated_by: auth.user.id,
      updated_at: nowIso,
    }));

    const { error } = await supabase
      .from("rate_templates")
      .upsert(rows, { onConflict: "stay_date,room_id" });

    if (error) {
      return jsonError({ success: false, error: error.message }, 500);
    }

    return NextResponse.json({
      success: true,
      updated_room_ids: roomIds,
    } satisfies RateSingleEditResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return jsonError({ success: false, error: message }, 500);
  }
}
