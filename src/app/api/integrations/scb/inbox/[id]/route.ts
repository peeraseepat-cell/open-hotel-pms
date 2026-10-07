import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { reconcileScbRequestStatuses } from "@/lib/scb/inquiry-runner";
import { loadPosMetaMap, loadReservationMetaMap } from "@/lib/scb/targets";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  kind: z.enum(["transaction", "request", "recheck"]).default("transaction"),
});

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    const parsed = querySchema.safeParse({
      kind: request.nextUrl.searchParams.get("kind") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Invalid query.", details: parsed.error.flatten() }, { status: 400 });
    }

    if (parsed.data.kind === "recheck") {
      const { data, error } = await supabase
        .from("scb_recheck_logs")
        .select("*")
        .eq("id", params.id)
        .maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ success: false, error: "Recheck log not found." }, { status: 404 });
      return NextResponse.json({ success: true, detail: data });
    }

    if (parsed.data.kind === "request") {
      await reconcileScbRequestStatuses(supabase as any, [params.id]);
      const { data: requestRow, error } = await supabase
        .from("scb_payment_requests")
        .select("*")
        .eq("id", params.id)
        .maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      if (!requestRow) return NextResponse.json({ success: false, error: "SCB request not found." }, { status: 404 });

      const [reservationMap, posMap, rechecks] = await Promise.all([
        loadReservationMetaMap(supabase as any, requestRow.target_type === "reservation" ? [String(requestRow.target_id)] : []),
        loadPosMetaMap(supabase as any, requestRow.target_type === "pos_order" ? [String(requestRow.target_id)] : []),
        supabase
          .from("scb_recheck_logs")
          .select("*")
          .eq("request_id", requestRow.id)
          .order("created_at", { ascending: false }),
      ]);

      const targetMeta = requestRow.target_type === "reservation"
        ? reservationMap.get(String(requestRow.target_id))
        : posMap.get(String(requestRow.target_id));

      return NextResponse.json({
        success: true,
        detail: {
          kind: "request",
          request: requestRow,
          target: {
            code: targetMeta?.code ?? String(requestRow.target_id),
            guest_name: targetMeta?.guestName ?? null,
          },
          posting: {
            room_amount: Number(requestRow.room_amount ?? 0),
            deposit_amount: Number(requestRow.deposit_amount ?? 0),
            total_amount: Number(requestRow.request_amount_total ?? 0),
          },
          callback_history: [
            {
              created_at: requestRow.created_at,
              status: requestRow.status,
              source: "request",
            },
            ...((rechecks.data ?? []).map((row: any) => ({
              created_at: row.created_at,
              status: row.result_status,
              source: row.source,
            }))),
          ],
          raw_payload: requestRow.provider_raw_response ?? requestRow.request_payload ?? {},
        },
      });
    }

    const { data: transactionRow, error } = await supabase
      .from("scb_payment_transactions")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!transactionRow) return NextResponse.json({ success: false, error: "Transaction not found." }, { status: 404 });

    if (transactionRow.request_id) {
      await reconcileScbRequestStatuses(supabase as any, [String(transactionRow.request_id)]);
    }

    const { data: requestRow } = transactionRow.request_id
      ? await supabase.from("scb_payment_requests").select("*").eq("id", transactionRow.request_id).maybeSingle()
      : { data: null as any };
    const [reservationMap, posMap, rechecks] = await Promise.all([
      loadReservationMetaMap(
        supabase as any,
        requestRow?.target_type === "reservation" ? [String(requestRow.target_id)] : []
      ),
      loadPosMetaMap(
        supabase as any,
        requestRow?.target_type === "pos_order" ? [String(requestRow.target_id)] : []
      ),
      supabase
        .from("scb_recheck_logs")
        .select("*")
        .or(`transaction_id.eq.${transactionRow.transaction_id}${requestRow?.id ? `,request_id.eq.${requestRow.id}` : ""}`)
        .order("created_at", { ascending: false }),
    ]);

    const targetMeta = requestRow
      ? (requestRow.target_type === "reservation"
        ? reservationMap.get(String(requestRow.target_id))
        : posMap.get(String(requestRow.target_id)))
      : null;

    return NextResponse.json({
      success: true,
      detail: {
        kind: "transaction",
        transaction: transactionRow,
        request: requestRow,
        target: requestRow ? {
          code: targetMeta?.code ?? String(requestRow.target_id),
          guest_name: targetMeta?.guestName ?? null,
        } : null,
        posting: {
          room_amount: Number(requestRow?.room_amount ?? 0),
          deposit_amount: Number(requestRow?.deposit_amount ?? 0),
          total_amount: Number(requestRow?.request_amount_total ?? transactionRow.amount ?? 0),
        },
        callback_history: [
          {
            created_at: transactionRow.created_at,
            status: transactionRow.status,
            source: "callback",
          },
          ...((rechecks.data ?? []).map((row: any) => ({
            created_at: row.created_at,
            status: row.result_status,
            source: row.source,
          }))),
        ],
        raw_payload: transactionRow.raw_payload ?? {},
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
