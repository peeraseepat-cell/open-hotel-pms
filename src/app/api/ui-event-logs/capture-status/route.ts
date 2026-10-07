import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { isUiEventLogEmailAllowed } from "@/lib/ui-event-log-settings";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest) {
  const strictMode = process.env.NEXT_PUBLIC_EGRESS_STRICT_MODE !== "false";
  if (!strictMode) {
    return NextResponse.json({ success: true, capture_enabled: true, strict_mode: false });
  }

  const supabase = createServerSupabaseClient();
  const user = await getAuthenticatedUser(supabase, request);
  if (!user) {
    return NextResponse.json({ success: true, capture_enabled: false, strict_mode: true });
  }

  const { data, error } = await supabase
    .from("hotel_settings")
    .select("ui_event_log_capture_emails")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ success: false, capture_enabled: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    capture_enabled: isUiEventLogEmailAllowed(user.email ?? null, data?.ui_event_log_capture_emails),
    strict_mode: true,
  });
}
