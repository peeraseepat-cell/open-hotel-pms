import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runScbInquiryForRequest } from "@/lib/scb/inquiry-runner";

export const dynamic = "force-dynamic";

function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isAuthorizedCronRequest(request: NextRequest): boolean {
  // Middleware treats /api/cron as public, so this is the only wall. Authorize solely on the
  // shared secret (bearer or ?token=), constant-time, fail-closed when unset. The former
  // x-vercel-cron header / vercel-cron User-Agent fallbacks were client-spoofable — removed.
  const cronSecret = String(process.env.SCB_AUTO_INQUIRY_CRON_SECRET ?? process.env.CRON_SECRET ?? "").trim();
  if (!cronSecret) return false;

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (bearer && timingSafeEqualStr(bearer, cronSecret)) return true;

  const queryToken = String(request.nextUrl.searchParams.get("token") ?? "").trim();
  if (queryToken && timingSafeEqualStr(queryToken, cronSecret)) return true;

  return false;
}

export async function GET(request: NextRequest) {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createServerSupabaseClient();
    const nowIso = new Date().toISOString();
    const twoMinutesAgoIso = new Date(Date.now() - 2 * 60_000).toISOString();
    const thirtyMinutesAgoIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const cooldownAgoIso = new Date(Date.now() - 2 * 60_000).toISOString();

    const { data: expiredRows, error: expiredError } = await supabase
      .from("scb_payment_requests")
      .select("id")
      .eq("status", "pending")
      .lt("expires_at", nowIso)
      .limit(200);
    if (expiredError) throw new Error(expiredError.message);

    if ((expiredRows ?? []).length > 0) {
      const { error: expireUpdateError } = await supabase
        .from("scb_payment_requests")
        .update({
          status: "expired",
          error_message: "SCB request expired before payment confirmation.",
          updated_at: nowIso,
        })
        .in("id", expiredRows!.map((row: any) => row.id))
        .eq("status", "pending");
      if (expireUpdateError) throw new Error(expireUpdateError.message);
    }

    const { data: dueRows, error: dueError } = await supabase
      .from("scb_payment_requests")
      .select("*")
      .eq("status", "pending")
      .gte("created_at", thirtyMinutesAgoIso)
      .lte("created_at", twoMinutesAgoIso)
      .gte("expires_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(100);
    if (dueError) throw new Error(dueError.message);

    const dueRequestIds = (dueRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
    const { data: latestScheduledLogs, error: latestScheduledLogsError } = dueRequestIds.length
      ? await supabase
          .from("scb_recheck_logs")
          .select("request_id, created_at")
          .in("request_id", dueRequestIds)
          .eq("source", "scheduled")
          .order("created_at", { ascending: false })
      : { data: [], error: null as any };
    if (latestScheduledLogsError) throw new Error(latestScheduledLogsError.message);

    const latestScheduledMap = new Map<string, string>();
    for (const row of latestScheduledLogs ?? []) {
      const key = String((row as any).request_id ?? "");
      if (!key || latestScheduledMap.has(key)) continue;
      latestScheduledMap.set(key, String((row as any).created_at ?? ""));
    }

    const dueWithCooldown = (dueRows ?? []).filter((row: any) => {
      const latestScheduled = latestScheduledMap.get(String(row.id));
      if (!latestScheduled) return true;
      return latestScheduled < cooldownAgoIso;
    }).slice(0, 10);

    const results: Array<{ request_id: string; status: string; found: boolean }> = [];
    for (const row of dueWithCooldown) {
      try {
        const result = await runScbInquiryForRequest({
          supabase: supabase as any,
          scbRequest: row as any,
          source: "scheduled",
          triggeredBy: null,
        });
        results.push({
          request_id: String(row.id),
          status: String(result.inquiry.status),
          found: Boolean(result.inquiry.found),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[SCB auto-inquiry cron:error]", {
          requestId: row.id,
          message,
        });
        await supabase.from("scb_recheck_logs").insert({
          request_id: row.id,
          transaction_id: null,
          triggered_by: null,
          source: "scheduled",
          result_status: "failed",
          raw_payload: { error: message },
        });
        results.push({
          request_id: String(row.id),
          status: "failed",
          found: false,
        });
      }
    }

    return NextResponse.json({
      success: true,
      expired_count: (expiredRows ?? []).length,
      processed_count: results.length,
      eligible_count: dueRequestIds.length,
      cooled_down_count: dueWithCooldown.length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[SCB auto-inquiry cron:fatal]", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
