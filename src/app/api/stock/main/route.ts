import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function isDashboardVisibilityColumnMissing(error: { message?: string | null } | null): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("show_on_inventory_dashboard");
}

function isDisplayOrderColumnMissing(error: { message?: string | null } | null): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("display_order");
}

function toBooleanLike(value: unknown, fallback = true): boolean {
  if (value === true || value === "true" || value === "t" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === "f" || value === 0 || value === "0") return false;
  return fallback;
}

async function ensureMainStockCoverage(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  includeInactive: boolean
): Promise<string | null> {
  let productQuery = supabase
    .from("products")
    .select("id, is_active");

  if (!includeInactive) {
    productQuery = productQuery.eq("is_active", true);
  }

  const { data: products, error: productsError } = await productQuery;
  if (productsError) {
    return productsError.message;
  }

  const productIds = Array.from(
    new Set((products ?? []).map((row: any) => String(row.id ?? "")).filter(Boolean))
  );
  if (productIds.length === 0) return null;

  const nowIso = new Date().toISOString();
  const seedRows = productIds.map((productId) => ({
    product_id: productId,
    quantity: 0,
    reorder_level: 10,
    updated_at: nowIso,
  }));

  const { error: ensureError } = await supabase
    .from("main_stock")
    .upsert(seedRows, { onConflict: "product_id", ignoreDuplicates: true });

  if (ensureError) {
    return ensureError.message;
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const includeInactive = request.nextUrl.searchParams.get("include_inactive") === "true";

    const coverageError = await ensureMainStockCoverage(supabase, includeInactive);
    if (coverageError) {
      return NextResponse.json({ success: false, error: coverageError }, { status: 500 });
    }

    let query = supabase
      .from("main_stock")
      .select(`
        id,
        product_id,
        quantity,
        reorder_level,
        updated_at,
        products!inner(id, name, sku, category, unit, sale_price, display_order, is_active, show_on_inventory_dashboard)
      `)
      .order("display_order", { ascending: true, foreignTable: "products" })
      .order("name", { ascending: true, foreignTable: "products" })
      .order("updated_at", { ascending: false });

    if (!includeInactive) {
      query = query.eq("products.is_active", true);
    }

    const initial = await query;
    let data = (initial.data as any[] | null) ?? null;
    let error = initial.error;
    let visibilityColumnAvailable = true;
    if (error && isDashboardVisibilityColumnMissing(error)) {
      visibilityColumnAvailable = false;
      let fallbackQuery = supabase
        .from("main_stock")
        .select(`
          id,
          product_id,
          quantity,
          reorder_level,
          updated_at,
          products!inner(id, name, sku, category, unit, sale_price, display_order, is_active)
        `)
        .order("display_order", { ascending: true, foreignTable: "products" })
        .order("name", { ascending: true, foreignTable: "products" })
        .order("updated_at", { ascending: false });
      if (!includeInactive) {
        fallbackQuery = fallbackQuery.eq("products.is_active", true);
      }
      const fallback = await fallbackQuery;
      data = (fallback.data as any[] | null) ?? null;
      error = fallback.error;
    }
    if (error) {
      const message = String(error.message ?? "").toLowerCase();
      if (message.includes("show_on_inventory_dashboard")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260303_phase11_inventory_dashboard_visibility.sql before using stock main API.",
          },
          { status: 500 }
        );
      }
      if (isDisplayOrderColumnMissing(error)) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260329000299_inventory_display_order.sql before using stock main API.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const rows = (data ?? []).map((row: any) => {
      const product = Array.isArray(row.products) ? row.products[0] ?? null : row.products ?? null;
      return {
        id: row.id,
        product_id: row.product_id,
        product_name: product?.name ?? null,
        sku: product?.sku ?? null,
        category: product?.category ?? null,
        unit: product?.unit ?? null,
        sale_price: product?.sale_price ?? null,
        display_order: Number(product?.display_order ?? 9999),
        quantity: Number(row.quantity ?? 0),
        reorder_level: Number(row.reorder_level ?? 0),
        updated_at: row.updated_at,
        is_active: toBooleanLike(product?.is_active, false),
        show_on_inventory_dashboard: visibilityColumnAvailable
          ? toBooleanLike(product?.show_on_inventory_dashboard, true)
          : true,
        is_low_stock: Number(row.quantity ?? 0) <= Number(row.reorder_level ?? 0),
      };
    });

    return NextResponse.json({ success: true, stocks: rows });
  } catch (err) {
    console.error("stock/main GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
