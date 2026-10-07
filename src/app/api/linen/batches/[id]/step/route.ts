import { advanceLaundryBatchStep } from "@/lib/linen/batch-service";
import { linenApiError, requireLinenAccess } from "@/lib/linen/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const schema = z.object({
  step: z.enum(["fo_return_counted", "vendor_signed", "fo_return_signed"]),
  vendor_name: z.string().trim().optional().nullable(),
  return_items: z.array(z.object({
    source_batch_id: z.string().uuid(),
    linen_item_id: z.coerce.number().int().positive(),
    received_qty: z.coerce.number().int().min(0),
    is_dayuse: z.boolean().optional(),
  })).optional(),
  pending_resolved: z.array(z.object({ pending_item_id: z.string().uuid() })).optional(),
  rewash_resolved: z.array(z.object({
    rewash_event_id: z.coerce.number().int().positive(),
    resolved_qty: z.coerce.number().int().positive(),
  })).optional(),
});

async function handleStepRequest(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { supabase, actor } = await requireLinenAccess(request);
    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Invalid payload.", details: parsed.error.flatten() }, { status: 400 });
    }

    const data = await advanceLaundryBatchStep(supabase, params.id, { ...parsed.data, actor_name: actor.name });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("api/linen/batches/[id]/step POST failed", error);
    const { status, message } = linenApiError(error, "Failed to advance linen batch.");
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  return handleStepRequest(request, context);
}

export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  return handleStepRequest(request, context);
}
