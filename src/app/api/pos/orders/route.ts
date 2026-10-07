import { resolveBusinessDate, toLocalDate } from "@/lib/folio-fees";
import { buildQuotedIlikeOrFilter } from "@/lib/postgrest-escape";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const createOrderSchema = z.object({
  order_type: z.enum(["walkin", "guest_charge"]),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(9999),
      })
    )
    .min(1),
  payment_method: z.enum(["cash", "transfer", "credit_card"]).optional(),
  reservation_id: z.string().uuid().optional(),
  deposit_amount: z.number().min(0).optional(),
  created_by: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

const listQuerySchema = z.object({
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["pending", "completed", "voided"]).optional(),
  order_type: z.enum(["walkin", "guest_charge"]).optional(),
  reservation_id: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 50))
    .refine((v) => Number.isInteger(v) && v > 0 && v <= 200, "limit must be 1-200"),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0))
    .refine((v) => Number.isInteger(v) && v >= 0, "offset must be >= 0"),
});

type CreateOrderInput = z.infer<typeof createOrderSchema>;

function isRpcMissing(error: { code?: string | null; message?: string | null } | null): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.code === "42883" || message.includes("could not find the function") || message.includes("schema cache");
}

async function createOrderFallback(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  input: CreateOrderInput,
  businessDate: string
) {
  if (input.order_type === "walkin" && !input.payment_method) {
    throw new Error("payment_method is required for walkin order");
  }
  if (input.order_type === "guest_charge" && !input.reservation_id) {
    throw new Error("reservation_id is required for guest_charge order");
  }
  if (input.order_type === "guest_charge") {
    throw new Error(
      "Run migration 20260313_phase29_pos_deposit_settlement.sql before using room deposit settlement."
    );
  }

  const productIds = Array.from(new Set(input.items.map((item) => item.product_id)));
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, category, sale_price, is_active")
    .in("id", productIds);
  if (productsError) throw new Error(productsError.message);

  const productMap = new Map((products ?? []).map((row) => [row.id, row]));

  let subtotal = 0;
  const lineItems = input.items.map((item) => {
    const product = productMap.get(item.product_id);
    if (!product) throw new Error(`Product not found: ${item.product_id}`);
    if (!product.is_active) throw new Error(`Product inactive: ${product.name}`);
    if (!["pos", "both"].includes(product.category)) {
      throw new Error(`Product is not saleable in POS: ${product.name}`);
    }
    if (product.sale_price === null) {
      throw new Error(`Product sale_price is missing: ${product.name}`);
    }

    const lineTotal = Number(product.sale_price) * item.quantity;
    subtotal += lineTotal;

    return {
      product_id: item.product_id,
      product_name: product.name,
      quantity: item.quantity,
      unit_price: Number(product.sale_price),
      line_total: Number(lineTotal.toFixed(2)),
    };
  });

  subtotal = Number(subtotal.toFixed(2));
  const total = subtotal;

  const { data: orderNumber, error: orderNumberError } = await supabase.rpc("generate_pos_order_number");
  if (orderNumberError || !orderNumber) {
    throw new Error(orderNumberError?.message || "Failed to generate POS order number");
  }

  const nowIso = new Date().toISOString();
  const { data: order, error: orderError } = await supabase
    .from("pos_orders")
    .insert({
      order_number: String(orderNumber),
      order_type: input.order_type,
      reservation_id: null,
      guest_name: null,
      status: "completed",
      subtotal,
      total,
      payment_method: input.payment_method ?? null,
      note: input.note?.trim() || null,
      created_by: input.created_by?.trim() || null,
      order_date: businessDate,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id, order_number")
    .single();
  if (orderError || !order) {
    throw new Error(orderError?.message || "Failed to create order");
  }

  const { error: itemInsertError } = await supabase.from("pos_order_items").insert(
    lineItems.map((line) => ({
      order_id: order.id,
      product_id: line.product_id,
      product_name: line.product_name,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_total: line.line_total,
    }))
  );
  if (itemInsertError) throw new Error(itemInsertError.message);

  for (const line of lineItems) {
    const { error: ensureMainError } = await supabase
      .from("main_stock")
      .upsert({ product_id: line.product_id, quantity: 0, reorder_level: 10, updated_at: nowIso }, { onConflict: "product_id" });
    if (ensureMainError) throw new Error(ensureMainError.message);

    const { data: currentRow, error: currentError } = await supabase
      .from("main_stock")
      .select("quantity")
      .eq("product_id", line.product_id)
      .single();
    if (currentError || !currentRow) {
      throw new Error(currentError?.message || "Main stock row not found");
    }

    const currentQty = Number(currentRow.quantity ?? 0);
    const deductQty = Math.min(currentQty, line.quantity);
    const oversell = Math.max(line.quantity - currentQty, 0);
    const newQty = Math.max(currentQty - line.quantity, 0);

    const { error: updateMainError } = await supabase
      .from("main_stock")
      .update({ quantity: newQty, updated_at: nowIso })
      .eq("product_id", line.product_id);
    if (updateMainError) throw new Error(updateMainError.message);

    const { error: txError } = await supabase.from("stock_transactions_v2").insert({
      transaction_date: businessDate,
      product_id: line.product_id,
      action: "sale",
      quantity_change: -deductQty,
      from_location: "main",
      to_location: null,
      reference_type: "pos_order",
      reference_id: order.id,
      performed_by: input.created_by?.trim() || null,
      note:
        oversell > 0
          ? `[OVERSELL] requested=${line.quantity}, available=${currentQty}, shortfall=${oversell}`
          : `sold ${line.quantity}`,
    });
    if (txError) throw new Error(txError.message);
  }

  return {
    order_id: order.id,
    order_number: order.order_number,
    subtotal,
    total,
  };
}

export async function GET(request: NextRequest) {
  try {
    const parsed = listQuerySchema.safeParse({
      date_from: request.nextUrl.searchParams.get("date_from") ?? undefined,
      date_to: request.nextUrl.searchParams.get("date_to") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      order_type: request.nextUrl.searchParams.get("order_type") ?? undefined,
      reservation_id: request.nextUrl.searchParams.get("reservation_id") ?? undefined,
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      offset: request.nextUrl.searchParams.get("offset") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const businessDate = await resolveBusinessDate(supabase, toLocalDate(new Date()));
    const { date_from, date_to, status, order_type, reservation_id, q, limit, offset } = parsed.data;
    const effectiveDateFrom = date_from ?? businessDate;
    const effectiveDateTo = date_to ?? businessDate;

    let query = supabase
      .from("pos_orders")
      .select(
        "id, order_number, order_type, reservation_id, guest_name, status, subtotal, total, payment_method, note, created_by, order_date, created_at, updated_at",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (effectiveDateFrom) query = query.gte("order_date", effectiveDateFrom);
    if (effectiveDateTo) query = query.lte("order_date", effectiveDateTo);
    if (status) query = query.eq("status", status);
    if (order_type) query = query.eq("order_type", order_type);
    if (reservation_id) query = query.eq("reservation_id", reservation_id);
    if (q && q.length > 0) {
      query = query.or(buildQuotedIlikeOrFilter(["order_number", "guest_name", "note"], q));
    }

    const { data, error, count } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      orders: data ?? [],
      pagination: {
        total: count ?? 0,
        limit,
        offset,
        has_more: (count ?? 0) > offset + (data?.length ?? 0),
      },
      range: {
        date_from: effectiveDateFrom,
        date_to: effectiveDateTo,
        business_date: businessDate,
      },
    });
  } catch (err) {
    console.error("pos/orders GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = createOrderSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const input = parsed.data;
    if (input.order_type === "walkin" && !input.payment_method) {
      return NextResponse.json(
        { success: false, error: "payment_method is required for walkin order" },
        { status: 400 }
      );
    }
    if (input.order_type === "guest_charge" && !input.reservation_id) {
      return NextResponse.json(
        { success: false, error: "reservation_id is required for guest_charge order" },
        { status: 400 }
      );
    }
    if (input.order_type === "guest_charge" && (!input.deposit_amount || input.deposit_amount <= 0)) {
      return NextResponse.json(
        { success: false, error: "deposit_amount must be greater than 0 for room deposit settlement" },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const businessDate = await resolveBusinessDate(supabase, toLocalDate(new Date()));

    const { data: rpcData, error: rpcError } = await supabase.rpc("pos_create_order_v2", {
      p_order_type: input.order_type,
      p_items: input.items,
      p_payment_method: input.payment_method ?? null,
      p_reservation_id: input.reservation_id ?? null,
      p_created_by: input.created_by?.trim() || null,
      p_note: input.note?.trim() || null,
      p_deposit_amount: input.deposit_amount ?? 0,
    });

    if (!rpcError) {
      return NextResponse.json({ success: true, mode: "atomic_rpc", result: rpcData }, { status: 201 });
    }

    if (!isRpcMissing(rpcError)) {
      return NextResponse.json(
        { success: false, error: rpcError.message || "Failed to create POS order." },
        { status: 500 }
      );
    }

    const fallbackResult = await createOrderFallback(supabase, input, businessDate);
    return NextResponse.json({ success: true, mode: "legacy_fallback", result: fallbackResult }, { status: 201 });
  } catch (err) {
    console.error("pos/orders POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
