import {
  getDynamicSuggestionStaleMinutes,
  getOtaAlarmMinutes,
  notifyRateSystemAlerts,
} from "@/lib/telegram/alerts";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function isMissingRelationError(message?: string | null) {
  const text = String(message ?? "");
  return /relation .* does not exist|column .* does not exist/i.test(text);
}

function isAuthorizedCronRequest(request: NextRequest): boolean {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const cronSecret = String(process.env.OTA_ALARM_CRON_SECRET ?? process.env.CRON_SECRET ?? "").trim();
  if (!cronSecret) return false;
  if (bearer === cronSecret) return true;

  const queryToken = String(request.nextUrl.searchParams.get("token") ?? "").trim();
  return queryToken === cronSecret;
}

export async function GET(request: NextRequest) {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createServerSupabaseClient();
    const [alarmMinutes, suggestionAlarmMinutes] = await Promise.all([
      getOtaAlarmMinutes(supabase),
      getDynamicSuggestionStaleMinutes(supabase),
    ]);
    const otaCutoffIso = new Date(Date.now() - alarmMinutes * 60_000).toISOString();
    const suggestionCutoffIso = new Date(Date.now() - suggestionAlarmMinutes * 60_000).toISOString();

    const { data, error } = await supabase
      .from("ota_rate_sync_tasks")
      .select("id, created_at")
      .eq("status", "pending")
      .lt("created_at", otaCutoffIso)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    let suggestionRows: Array<{ id?: string; created_at?: string | null }> = [];
    const { data: suggestionData, error: suggestionError } = await supabase
      .from("rate_dynamic_preview")
      .select("id, created_at")
      .eq("status", "suggested")
      .lt("created_at", suggestionCutoffIso)
      .order("created_at", { ascending: true })
      .limit(500);

    if (suggestionError) {
      if (!isMissingRelationError(suggestionError.message)) {
        return NextResponse.json({ success: false, error: suggestionError.message }, { status: 500 });
      }
    } else {
      suggestionRows = suggestionData ?? [];
    }

    const staleRows = data ?? [];
    const otaOldestMinutes =
      staleRows.length > 0
        ? Math.max(0, Math.floor((Date.now() - new Date(String((staleRows[0] as any).created_at ?? "")).getTime()) / 60000))
        : 0;
    const suggestionOldestMinutes =
      suggestionRows.length > 0
        ? Math.max(0, Math.floor((Date.now() - new Date(String((suggestionRows[0] as any).created_at ?? "")).getTime()) / 60000))
        : 0;

    if (staleRows.length === 0 && suggestionRows.length === 0) {
      return NextResponse.json({
        success: true,
        ota_alarm_minutes: alarmMinutes,
        dynamic_suggestion_stale_minutes: suggestionAlarmMinutes,
        overdue_count: 0,
        suggestion_overdue_count: 0,
        notified: false,
      });
    }

    const notifyResult = await notifyRateSystemAlerts({
      supabase,
      ota:
        staleRows.length > 0
          ? {
              count: staleRows.length,
              oldestMinutes: otaOldestMinutes,
            }
          : undefined,
      suggestions:
        suggestionRows.length > 0
          ? {
              count: suggestionRows.length,
              oldestMinutes: suggestionOldestMinutes,
            }
          : undefined,
    });

    return NextResponse.json({
      success: notifyResult.success,
      ota_alarm_minutes: alarmMinutes,
      dynamic_suggestion_stale_minutes: suggestionAlarmMinutes,
      overdue_count: staleRows.length,
      oldest_pending_minutes: otaOldestMinutes || null,
      suggestion_overdue_count: suggestionRows.length,
      oldest_suggestion_minutes: suggestionOldestMinutes || null,
      notified: notifyResult.success,
      message_id: notifyResult.message_id,
      error: notifyResult.error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
