import type { OccupancyTier, RateGridResponseV2 } from "@/lib/rates/types";
import { requireStaffAuth } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BULK_RATE_DAYS = 365;
const MAX_BULK_RATE_ROWS = 150_000;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateRange(start: string, end: string): string[] {
  const days: string[] = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

function parseDateOnly(value: string): Date | null {
  if (!DATE_RE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function getInclusiveDateSpanDays(startDate: string, endDate: string): number | null {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (!start || !end) return null;
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function isMissingColumnError(error: { message?: string } | null | undefined, column: string): boolean {
  const message = String(error?.message ?? "");
  const pattern = new RegExp(`column\\s+.*${column}.*does not exist`, "i");
  return pattern.test(message);
}

async function fetchOvernightRoomsByType(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  roomTypeId: string
) {
  let roomsRes = await supabase
    .from("rooms")
    .select("id, room_number")
    .eq("room_type_id", roomTypeId)
    .eq("is_sellable", true)
    .eq("is_dayuse", false)
    .order("room_number", { ascending: true });

  if (roomsRes.error && isMissingColumnError(roomsRes.error, "is_dayuse")) {
    roomsRes = await supabase
      .from("rooms")
      .select("id, room_number")
      .eq("room_type_id", roomTypeId)
      .eq("is_sellable", true)
      .order("room_number", { ascending: true });
  }

  if (roomsRes.error) throw new Error(roomsRes.error.message);

  return (roomsRes.data ?? []).map((room: any) => String(room.id));
}

async function loadMinRateFloor(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  roomTypeId: string
) {
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

function normalizeRateGridResponse(raw: any): RateGridResponseV2 {
  const occupancy = raw?.occupancy ?? {};
  const normalizeTier = (value: unknown): OccupancyTier => {
    const tier = String(value ?? "low");
    if (tier === "normal" || tier === "high" || tier === "peak") return tier;
    return "low";
  };
  const perRoomType = Object.fromEntries(
    Object.entries(occupancy?.per_room_type ?? {}).map(([typeId, days]) => [
      String(typeId),
      Object.fromEntries(
        Object.entries(days as Record<string, any>).map(([date, occ]) => [
          String(date),
          {
            booked: Number((occ as any)?.booked ?? 0),
            total: Number((occ as any)?.total ?? 0),
            pct: Number((occ as any)?.pct ?? 0),
            tier: normalizeTier((occ as any)?.tier),
          },
        ])
      ),
    ])
  );

  const hotelWide = Object.fromEntries(
    Object.entries(occupancy?.hotel_wide ?? {}).map(([date, occ]) => [
      String(date),
      {
        booked: Number((occ as any)?.booked ?? 0),
        total: Number((occ as any)?.total ?? 0),
        pct: Number((occ as any)?.pct ?? 0),
        tier: normalizeTier((occ as any)?.tier),
      },
    ])
  );

  return {
    success: Boolean(raw?.success),
    start_date: String(raw?.start_date ?? ""),
    end_date: String(raw?.end_date ?? ""),
    days: Array.isArray(raw?.days) ? raw.days.map((day: unknown) => String(day)) : [],
    room_types: Array.isArray(raw?.room_types)
      ? raw.room_types.map((group: any) => ({
          type_id: String(group?.type_id ?? ""),
          type_name: String(group?.type_name ?? ""),
          type_code: String(group?.type_code ?? ""),
          rooms: Array.isArray(group?.rooms)
            ? group.rooms.map((room: any) => ({
                room_id: String(room?.room_id ?? ""),
                room_number: String(room?.room_number ?? ""),
                rates: Object.fromEntries(
                  Object.entries(room?.rates ?? {}).map(([date, value]) => [
                    String(date),
                    value == null ? null : Number(value),
                  ])
                ),
              }))
            : [],
        }))
      : [],
    occupancy: {
      per_room_type: perRoomType,
      hotel_wide: hotelWide,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const sp = request.nextUrl.searchParams;

    const today = new Date().toISOString().slice(0, 10);
    const startDate = sp.get("start") ?? today;
    const endDate = sp.get("end") ?? addDays(startDate, 29);

    const { data, error } = await supabase.rpc("get_rate_grid_with_occ", {
      p_start: startDate,
      p_end: endDate,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json(normalizeRateGridResponse(data));
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
    if (auth.error) return auth.error;
    const body = await request.json();

    const {
      room_type_id,
      start_date,
      end_date,
      weekdays,
      price,
    } = body as {
      room_type_id: string;
      start_date: string;
      end_date: string;
      weekdays: number[];
      price: number;
    };

    if (!room_type_id || !start_date || !end_date || price === undefined) {
      return NextResponse.json({ success: false, error: "Missing required fields." }, { status: 400 });
    }
    if (price < 0) {
      return NextResponse.json({ success: false, error: "Price cannot be negative." }, { status: 400 });
    }

    const spanDays = getInclusiveDateSpanDays(String(start_date), String(end_date));
    if (spanDays == null) {
      return NextResponse.json({ success: false, error: "start_date and end_date must be valid YYYY-MM-DD dates." }, { status: 400 });
    }
    if (spanDays < 1) {
      return NextResponse.json({ success: false, error: "start_date must be before or equal to end_date." }, { status: 400 });
    }
    if (spanDays > MAX_BULK_RATE_DAYS) {
      return NextResponse.json({ success: false, error: `Date range is limited to ${MAX_BULK_RATE_DAYS} days.` }, { status: 400 });
    }

    const floor = await loadMinRateFloor(supabase, String(room_type_id));
    if (floor != null && Number(price) < floor) {
      return NextResponse.json(
        {
          success: false,
          error: "Price is below the configured floor.",
          floor_violation: true,
          floor,
        },
        { status: 409 }
      );
    }

    const rooms = await fetchOvernightRoomsByType(supabase, String(room_type_id));
    if (rooms.length === 0) {
      return NextResponse.json({ success: false, error: "No sellable rooms found for this room type." }, { status: 404 });
    }

    const days = dateRange(start_date, end_date).filter((d) => {
      if (!weekdays || weekdays.length === 0) return true;
      const dow = new Date(`${d}T00:00:00`).getDay();
      return weekdays.includes(dow);
    });

    if (days.length === 0) {
      return NextResponse.json({ success: false, error: "No dates match the weekday filter." }, { status: 400 });
    }

    const totalRows = rooms.length * days.length;
    if (totalRows > MAX_BULK_RATE_ROWS) {
      return NextResponse.json({ success: false, error: `Bulk rate update is limited to ${MAX_BULK_RATE_ROWS} rows.` }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const rows = rooms.flatMap((roomId) =>
      days.map((day) => ({
        room_id: roomId,
        stay_date: day,
        price,
        updated_by: auth.user.id,
        updated_at: nowIso,
      }))
    );

    const { error: upsertErr } = await supabase
      .from("rate_templates")
      .upsert(rows, { onConflict: "stay_date,room_id" });

    if (upsertErr) {
      return NextResponse.json({ success: false, error: upsertErr.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      total_rows: rows.length,
      updated_rooms: rooms.length,
      updated_dates: days.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
