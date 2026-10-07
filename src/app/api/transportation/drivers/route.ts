import { createServerSupabaseClient } from "@/lib/supabase/server";
import { buildQuotedIlikeOrFilter } from "@/lib/postgrest-escape";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  search: z.string().trim().max(200).optional(),
  is_active: z.enum(["true", "false", "all"]).optional(),
  sort: z.enum(["rating", "name", "trips"]).optional(),
});

const driverCreateSchema = z.object({
  name: z.string().trim().min(1, "Driver name is required").max(200),
  phone: z.string().trim().max(50).optional().nullable(),
  license_type: z.string().trim().max(50).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  photo_url: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

export async function GET(request: NextRequest) {
  try {
    const parsedQuery = querySchema.safeParse({
      search: request.nextUrl.searchParams.get("search") ?? undefined,
      is_active: request.nextUrl.searchParams.get("is_active") ?? undefined,
      sort: request.nextUrl.searchParams.get("sort") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query params.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const { search, is_active, sort } = parsedQuery.data;
    const supabase = createServerSupabaseClient();

    let query = supabase
      .from("drivers")
      .select(`
        id,
        name,
        phone,
        license_type,
        company,
        photo_url,
        rating_avg,
        total_trips,
        is_active,
        notes,
        created_at,
        updated_at
      `);

    if (is_active === "false") {
      query = query.eq("is_active", false);
    } else if (is_active !== "all") {
      query = query.eq("is_active", true);
    }

    if (search && search.length > 0) {
      query = query.or(buildQuotedIlikeOrFilter(["name", "phone"], search));
    }

    if (sort === "name") {
      query = query.order("name", { ascending: true });
    } else if (sort === "trips") {
      query = query.order("total_trips", { ascending: false }).order("rating_avg", { ascending: false });
    } else {
      query = query.order("rating_avg", { ascending: false }).order("total_trips", { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, drivers: data ?? [] });
  } catch (err) {
    console.error("transportation/drivers GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = driverCreateSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const body = parsed.data;
    const supabase = createServerSupabaseClient();

    const { data: driver, error } = await supabase
      .from("drivers")
      .insert({
        name: body.name,
        phone: body.phone?.trim() || null,
        license_type: body.license_type?.trim() || null,
        company: body.company?.trim() || null,
        photo_url: body.photo_url?.trim() || null,
        notes: body.notes?.trim() || null,
        is_active: body.is_active ?? true,
      })
      .select(`
        id,
        name,
        phone,
        license_type,
        company,
        photo_url,
        rating_avg,
        total_trips,
        is_active,
        notes,
        created_at,
        updated_at
      `)
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, driver }, { status: 201 });
  } catch (err) {
    console.error("transportation/drivers POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
