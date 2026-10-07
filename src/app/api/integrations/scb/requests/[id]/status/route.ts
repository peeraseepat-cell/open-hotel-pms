import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { reconcileScbRequestStatuses } from "@/lib/scb/inquiry-runner";
import { serializeScbRequest } from "@/lib/scb/presenters";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const requestId = params.id;
    const now = new Date().toISOString();
    await supabase
      .from("scb_payment_requests")
      .update({ status: "expired", updated_at: now })
      .eq("id", requestId)
      .eq("status", "pending")
      .lt("expires_at", now);

    await reconcileScbRequestStatuses(supabase as any, [requestId]);

    const { data, error } = await supabase
      .from("scb_payment_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ success: false, error: "SCB request not found." }, { status: 404 });
    }

    const serialized = serializeScbRequest(data as any);
    return NextResponse.json({ success: true, data: serialized, request: serialized });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
