import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const idSchema = z.string().uuid("Invalid product id");

const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    name_th: z.string().trim().max(120).nullable().optional(),
    sku: z.string().trim().max(80).nullable().optional(),
    category: z.enum(["amenity", "pos", "both"]).optional(),
    fulfillment_mode: z.enum(["standard", "daily_prepare"]).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    sale_price: z.number().min(0).max(9999999).nullable().optional(),
    display_order: z.coerce.number().int().min(0).optional(),
    pos_abbreviated_enabled: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const parsedId = idSchema.safeParse(params.id);
    if (!parsedId.success) {
      return NextResponse.json({ success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" }, { status: 400 });
    }

    const json = await request.json().catch(() => null);
    const parsed = productUpdateSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    const payload = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.name_th !== undefined ? { name_th: parsed.data.name_th?.trim() || null } : {}),
      ...(parsed.data.sku !== undefined ? { sku: parsed.data.sku?.trim() || null } : {}),
      ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
      ...(parsed.data.fulfillment_mode !== undefined ? { fulfillment_mode: parsed.data.fulfillment_mode } : {}),
      ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit } : {}),
      ...(parsed.data.sale_price !== undefined ? { sale_price: parsed.data.sale_price } : {}),
      ...(parsed.data.display_order !== undefined ? { display_order: parsed.data.display_order } : {}),
      ...(parsed.data.pos_abbreviated_enabled !== undefined
        ? { pos_abbreviated_enabled: parsed.data.pos_abbreviated_enabled }
        : {}),
      ...(parsed.data.is_active !== undefined ? { is_active: parsed.data.is_active } : {}),
    };

    const result = await supabase
      .from("products")
      .update(payload)
      .eq("id", parsedId.data)
      .select(
        "id, name, name_th, sku, category, fulfillment_mode, unit, sale_price, display_order, is_active, pos_abbreviated_enabled, created_at, updated_at"
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
              "DB migration required: apply 20260302_phase10_fo_prepare_flow.sql before updating products.",
          },
          { status: 500 }
        );
      }
      if (message.includes("display_order")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260329000299_inventory_display_order.sql before updating products.",
          },
          { status: 500 }
        );
      }
      if (error.code === "PGRST116") {
        return NextResponse.json({ success: false, error: "Product not found." }, { status: 404 });
      }
      if (error.code === "23505") {
        return NextResponse.json(
          { success: false, error: "Product name or SKU already exists." },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      product: { ...(data as any), fulfillment_mode: (data as any)?.fulfillment_mode ?? "standard" },
    });
  } catch (err) {
    console.error("products/:id PUT failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const parsedId = idSchema.safeParse(params.id);
    if (!parsedId.success) {
      return NextResponse.json({ success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" }, { status: 400 });
    }

    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    const result = await supabase
      .from("products")
      .update({ is_active: false })
      .eq("id", parsedId.data)
      .select(
        "id, name, name_th, sku, category, fulfillment_mode, unit, sale_price, display_order, is_active, pos_abbreviated_enabled, created_at, updated_at"
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
              "DB migration required: apply 20260302_phase10_fo_prepare_flow.sql before updating products.",
          },
          { status: 500 }
        );
      }
      if (message.includes("display_order")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260329000299_inventory_display_order.sql before updating products.",
          },
          { status: 500 }
        );
      }
      if (error.code === "PGRST116") {
        return NextResponse.json({ success: false, error: "Product not found." }, { status: 404 });
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      product: { ...(data as any), fulfillment_mode: (data as any)?.fulfillment_mode ?? "standard" },
    });
  } catch (err) {
    console.error("products/:id DELETE failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
