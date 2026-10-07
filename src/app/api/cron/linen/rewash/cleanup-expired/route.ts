import { expireOldRewashEvents } from "@/lib/linen/rewash";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServerSupabaseClient();
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const data = await expireOldRewashEvents(supabase, cutoff);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("api/cron/linen/rewash/cleanup-expired GET failed", error);
    const message = error instanceof Error ? error.message : "Failed to cleanup expired rewash events.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
