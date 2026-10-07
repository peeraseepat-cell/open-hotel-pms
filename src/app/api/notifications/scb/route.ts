import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getUserRole } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  unread: z.coerce.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const role = await getUserRole(supabase, user.id);
    const parsed = querySchema.safeParse({
      unread: request.nextUrl.searchParams.get("unread") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Invalid query.", details: parsed.error.flatten() }, { status: 400 });
    }

    const notificationsLimit = parsed.data.unread ? 100 : 10;
    const { data: notifications, error: notificationsError } = await supabase
      .from("scb_payment_notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(notificationsLimit);
    if (notificationsError) {
      return NextResponse.json({ success: false, error: notificationsError.message }, { status: 500 });
    }

    const notificationIds = (notifications ?? []).map((item) => String(item.id));
    const { data: reads, error: readsError } = notificationIds.length
      ? await supabase
          .from("scb_notification_reads")
          .select("notification_id")
          .eq("user_id", user.id)
          .in("notification_id", notificationIds)
      : { data: [], error: null as any };
    if (readsError) {
      return NextResponse.json({ success: false, error: readsError.message }, { status: 500 });
    }
    const readIds = new Set((reads ?? []).map((row: any) => String(row.notification_id)));

    const [{ count: notificationsCount, error: notificationsCountError }, { count: readsCount, error: readsCountError }] = await Promise.all([
      supabase.from("scb_payment_notifications").select("id", { count: "exact", head: true }),
      supabase.from("scb_notification_reads").select("notification_id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);
    if (notificationsCountError || readsCountError) {
      return NextResponse.json({ success: false, error: notificationsCountError?.message || readsCountError?.message || "Failed to load notification counts." }, { status: 500 });
    }

    const items = (notifications ?? [])
      .map((item: any) => ({
        ...item,
        is_read: readIds.has(String(item.id)),
      }))
      .filter((item: any) => parsed.data.unread ? !item.is_read : true)
      .slice(0, 10);

    return NextResponse.json({
      success: true,
      role,
      unread_count: Math.max(0, Number(notificationsCount ?? 0) - Number(readsCount ?? 0)),
      items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
