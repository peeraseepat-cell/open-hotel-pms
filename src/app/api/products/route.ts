import { createServerSupabaseClient } from "@/lib/supabase/server";
import { buildQuotedIlikeOrFilter } from "@/lib/postgrest-escape";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
const STOCK_FLOORS = [1, 2, 3] as const;

const productCreateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  name_th: z.string().trim().max(120).optional().nullable(),
  sku: z.string().trim().max(80).optional().nullable(),
  category: z.enum(["amenity", "pos", "both"]).default("amenity"),
  fulfillment_mode: z.enum(["standard", "daily_prepare"]).default("standard"),
  stock_tracking_mode: z.enum(["pos_main_only", "amenity_prepare", "amenity_direct"]).default("amenity_direct"),
  unit: z.string().trim().min(1, "unit is required").max(30).default("pieces"),
  sale_price: z.number().min(0).max(9999999).nullable().optional(),
  display_order: z.coerce.number().int().min(0).optional(),
  pos_abbreviated_enabled: z.boolean().optional().default(false),
  is_active: z.boolean().optional().default(true),
});

const productQuerySchema = z.object({
  category: z.enum(["amenity", "pos", "both"]).optional(),
  fulfillment_mode: z.enum(["standard", "daily_prepare"]).optional(),
  stock_tracking_mode: z.enum(["pos_main_only", "amenity_prepare", "amenity_direct"]).optional(),
  pos_abbreviated_enabled: z.enum(["true", "false"]).optional(),
  is_active: z.enum(["true", "false"]).optional(),
  for_sale: z.enum(["true", "false"]).optional(),
  q: z.string().trim().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const parsedQuery = productQuerySchema.safeParse({
      category: request.nextUrl.searchParams.get("category") ?? undefined,
      fulfillment_mode: request.nextUrl.searchParams.get("fulfillment_mode") ?? undefined,
      stock_tracking_mode: request.nextUrl.searchParams.get("stock_tracking_mode") ?? undefined,
      pos_abbreviated_enabled: request.nextUrl.searchParams.get("pos_abbreviated_enabled") ?? undefined,
      is_active: request.nextUrl.searchParams.get("is_active") ?? undefined,
      for_sale: request.nextUrl.searchParams.get("for_sale") ?? undefined,
      q: request.nextUrl.searchParams.get("q") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const { category, fulfillment_mode, stock_tracking_mode, pos_abbreviated_enabled, is_active, for_sale, q } =
      parsedQuery.data;
    const supabase = createServerSupabaseClient();

    let query = supabase
      .from("products")
      .select(
        "id, name, name_th, sku, category, fulfillment_mode, stock_tracking_mode, unit, sale_price, display_order, is_active, pos_abbreviated_enabled, created_at, updated_at"
      )
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (category) query = query.eq("category", category);
    if (fulfillment_mode) query = query.eq("fulfillment_mode", fulfillment_mode);
    if (stock_tracking_mode) query = query.eq("stock_tracking_mode", stock_tracking_mode);
    if (pos_abbreviated_enabled) query = query.eq("pos_abbreviated_enabled", pos_abbreviated_enabled === "true");
    if (is_active) query = query.eq("is_active", is_active === "true");
    if (for_sale === "true") query = query.not("sale_price", "is", null);
    if (for_sale === "false") query = query.is("sale_price", null);
    if (q && q.length > 0) {
      query = query.or(buildQuotedIlikeOrFilter(["name", "sku"], q));
    }

    const initial = await query;
    const data: any[] | null = (initial.data as any[] | null) ?? null;
    const error: { message?: string | null } | null = initial.error;

    if (error) {
      const message = String(error.message ?? "").toLowerCase();
      if (message.includes("fulfillment_mode")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260302_phase10_fo_prepare_flow.sql before using products API.",
          },
          { status: 500 }
        );
      }
      if (message.includes("display_order")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260329000299_inventory_display_order.sql before using products API.",
          },
          { status: 500 }
        );
      }
      if (message.includes("stock_tracking_mode")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260415000199_phase65_stock_snapshot_amenity_audit.sql before using product tracking modes.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const rows = (data ?? []).map((row: any) => ({
      ...row,
      fulfillment_mode: row.fulfillment_mode ?? "standard",
      stock_tracking_mode: row.stock_tracking_mode ?? "amenity_direct",
    }));

    const filteredRows =
      fulfillment_mode != null
        ? rows.filter((row: any) => row.fulfillment_mode === fulfillment_mode)
        : rows;

    const productIds = filteredRows
      .map((row: any) => String(row.id ?? ""))
      .filter(Boolean);

    let stockMap = new Map<string, number>();
    if (productIds.length > 0) {
      const { data: stockRows, error: stockError } = await supabase
        .from("main_stock")
        .select("product_id, quantity")
        .in("product_id", productIds);

      if (stockError) {
        return NextResponse.json({ success: false, error: stockError.message }, { status: 500 });
      }

      stockMap = new Map(
        (stockRows ?? []).map((row: any) => [String(row.product_id), Number(row.quantity ?? 0)])
      );
    }

    return NextResponse.json({
      success: true,
      products: filteredRows.map((row: any) => ({
        ...row,
        main_stock_quantity: stockMap.get(String(row.id)) ?? 0,
      })),
    });
  } catch (err) {
    console.error("products GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = productCreateSchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const body = parsed.data;
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    let nextDisplayOrder = Number(body.display_order ?? 0);
    if (body.display_order === undefined) {
      const maxOrderResult = await supabase
        .from("products")
        .select("display_order")
        .eq("is_active", true)
        .order("display_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (maxOrderResult.error) {
        const message = String(maxOrderResult.error.message ?? "").toLowerCase();
        if (message.includes("display_order")) {
          return NextResponse.json(
            {
              success: false,
              error:
                "DB migration required: apply 20260329000299_inventory_display_order.sql before creating products.",
            },
            { status: 500 }
          );
        }
        return NextResponse.json({ success: false, error: maxOrderResult.error.message }, { status: 500 });
      }
      const currentMax = Number((maxOrderResult.data as any)?.display_order ?? 0);
      nextDisplayOrder = currentMax > 0 ? currentMax + 1 : 1;
    }

    const payload = {
      name: body.name,
      name_th: body.name_th?.trim() || null,
      sku: body.sku?.trim() || null,
      category: body.category,
      fulfillment_mode: body.fulfillment_mode ?? "standard",
      stock_tracking_mode: body.stock_tracking_mode ?? "amenity_direct",
      unit: body.unit,
      sale_price: body.sale_price ?? null,
      display_order: nextDisplayOrder,
      pos_abbreviated_enabled: body.pos_abbreviated_enabled ?? false,
      is_active: body.is_active ?? true,
    };

    const result = await supabase
      .from("products")
      .insert(payload)
      .select(
        "id, name, name_th, sku, category, fulfillment_mode, stock_tracking_mode, unit, sale_price, display_order, is_active, pos_abbreviated_enabled, created_at, updated_at"
      )
      .single();

    const { data, error } = result;

    if (error) {
      const message = String(error.message ?? "").toLowerCase();
      if (message.includes("fulfillment_mode")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260302_phase10_fo_prepare_flow.sql before creating products.",
          },
          { status: 500 }
        );
      }
      if (message.includes("display_order")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260329000299_inventory_display_order.sql before creating products.",
          },
          { status: 500 }
        );
      }
      if (message.includes("stock_tracking_mode")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260415000199_phase65_stock_snapshot_amenity_audit.sql before creating product tracking modes.",
          },
          { status: 500 }
        );
      }
      if (error.code === "23505") {
        return NextResponse.json(
          { success: false, error: "Product name or SKU already exists." },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Ensure new product is visible in Stock page immediately.
    const nowIso = new Date().toISOString();
    const { error: ensureMainStockError } = await supabase
      .from("main_stock")
      .upsert(
        {
          product_id: (data as any).id,
          quantity: 0,
          reorder_level: 10,
          updated_at: nowIso,
        },
        { onConflict: "product_id", ignoreDuplicates: true }
      );

    if (ensureMainStockError) {
      return NextResponse.json(
        { success: false, error: `Product created but failed to initialize stock row: ${ensureMainStockError.message}` },
        { status: 500 }
      );
    }

    const floorSeedRows = STOCK_FLOORS.map((floorNumber) => ({
      floor_number: floorNumber,
      product_id: (data as any).id,
      quantity: 0,
      updated_at: nowIso,
    }));

    const { error: ensureFloorStockError } = await supabase
      .from("floor_stock")
      .upsert(floorSeedRows, { onConflict: "floor_number,product_id", ignoreDuplicates: true });

    if (ensureFloorStockError) {
      return NextResponse.json(
        {
          success: false,
          error: `Product created but failed to initialize floor stock rows: ${ensureFloorStockError.message}`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        product: {
          ...(data as any),
          fulfillment_mode: (data as any)?.fulfillment_mode ?? "standard",
          stock_tracking_mode: (data as any)?.stock_tracking_mode ?? "amenity_direct",
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("products POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
