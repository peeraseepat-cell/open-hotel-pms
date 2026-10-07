import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const paramsSchema = z.object({
  id: z.string().uuid("Invalid commission id"),
});

const patchSchema = z.object({
  action: z.enum(["approve", "mark_paid", "reverse"]),
  approved_by: z.string().trim().max(120).optional().nullable(),
  reversal_reason: z.string().trim().max(1000).optional().nullable(),
});

function toBangkokDateStringFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return value.slice(0, 10);
  return `${year}-${month}-${day}`;
}

async function assertBusinessDayOpen(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  targetDate: string
) {
  const { data, error } = await supabase
    .from("daily_snapshots")
    .select("business_date")
    .gte("business_date", targetDate)
    .order("business_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data?.business_date) {
    throw new Error("Business day already closed. Use reversal.");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const parsedParams = paramsSchema.safeParse(params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: parsedParams.error.issues[0]?.message ?? "Invalid id." },
        { status: 400 }
      );
    }

    const json = await request.json().catch(() => null);
    const parsedBody = patchSchema.safeParse(json);
    if (!parsedBody.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
    if (auth.error) return auth.error;

    const { data: current, error: currentError } = await supabase
      .from("commission_ledger")
      .select("*")
      .eq("id", parsedParams.data.id)
      .maybeSingle();

    if (currentError) {
      return NextResponse.json({ success: false, error: currentError.message }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json({ success: false, error: "Commission not found." }, { status: 404 });
    }

    const targetDate = toBangkokDateStringFromIso(String(current.created_at));
    await assertBusinessDayOpen(supabase, targetDate);
    const currentBusinessDate = toBangkokDateStringFromIso(new Date().toISOString());

    const action = parsedBody.data.action;
    const updates: Record<string, unknown> = {};
    let reason: string | null = null;

    if (action === "approve") {
      if (current.status !== "pending") {
        return NextResponse.json(
          { success: false, error: `Cannot approve from status '${current.status}'.` },
          { status: 409 }
        );
      }
      updates.status = "approved";
      updates.approved_at = new Date().toISOString();
      updates.approved_by = parsedBody.data.approved_by?.trim() || "FO";
      reason = "approve";
    } else if (action === "mark_paid") {
      if (current.status !== "approved") {
        return NextResponse.json(
          { success: false, error: `Cannot mark paid from status '${current.status}'.` },
          { status: 409 }
        );
      }
      updates.status = "paid";
      updates.paid_at = new Date().toISOString();
      reason = "mark_paid";
    } else {
      if (current.status === "reversed") {
        return NextResponse.json({ success: false, error: "Commission already reversed." }, { status: 409 });
      }
      const reversalReason = parsedBody.data.reversal_reason?.trim() || "";
      if (!reversalReason) {
        return NextResponse.json(
          { success: false, error: "reversal_reason is required when action=reverse." },
          { status: 400 }
        );
      }
      updates.status = "reversed";
      updates.reversal_reason = reversalReason;
      updates.reversed_at = new Date().toISOString();
      reason = reversalReason;
    }

    const { data: updated, error: updateError } = await supabase
      .from("commission_ledger")
      .update(updates)
      .eq("id", parsedParams.data.id)
      .select("*")
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "commission_updated",
      entity_type: "commission_ledger",
      entity_id: parsedParams.data.id,
      before_json: current,
      after_json: updated,
      change_reason: reason,
      business_date: currentBusinessDate,
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("commission patch audit log insert failed", auditError);
    }

    return NextResponse.json({ success: true, commission: updated });
  } catch (err) {
    console.error("api/accounting/commissions/[id] PATCH failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const statusCode = message === "Business day already closed. Use reversal." ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status: statusCode });
  }
}
