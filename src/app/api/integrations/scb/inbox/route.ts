import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getUserRole } from "@/lib/server-auth";
import { reconcileScbRequestStatuses } from "@/lib/scb/inquiry-runner";
import { loadPosMetaMap, loadReservationMetaMap } from "@/lib/scb/targets";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  tab: z.enum(["pending", "matched", "unmatched", "expired_failed", "recheck_history"]).default("pending"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(30),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  amount_min: z.coerce.number().min(0).optional(),
  amount_max: z.coerce.number().min(0).optional(),
  channel: z.enum(["all", "booking_folio", "mobile_checkin", "pos"]).default("all"),
});

type RequestRow = {
  id: string;
  target_type: "reservation" | "pos_order";
  target_id: string;
  channel: string;
  status: string;
  request_amount_total: number;
  room_amount: number;
  deposit_amount: number;
  partner_reference_no: string | null;
  paid_transaction_id: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
  error_message: string | null;
};

type TransactionRow = {
  id: string;
  request_id: string | null;
  transaction_id: string;
  amount: number;
  payer_name: string | null;
  payer_account: string | null;
  payment_channel: string | null;
  paid_at: string | null;
  status: string;
  match_status: string;
  partner_reference_no: string | null;
  order_id: string | null;
  created_at: string;
};

type PendingLinkedTransaction = {
  id: string;
  request_id: string | null;
  status: string;
  match_status: string | null;
  created_at: string;
};

function getBangkokDayRange(date = new Date()) {
  const local = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  return {
    start: `${yyyy}-${mm}-${dd}T00:00:00+07:00`,
    end: `${yyyy}-${mm}-${dd}T23:59:59.999+07:00`,
  };
}

function applyDateFilter<T extends { gte: Function; lte: Function }>(query: T, column: string, from?: string, to?: string): T {
  let next = query;
  if (from) next = next.gte(column, `${from}T00:00:00+07:00`);
  if (to) next = next.lte(column, `${to}T23:59:59.999+07:00`);
  return next;
}

async function buildTargetMeta(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  requestRows: RequestRow[]
) {
  const reservationIds = Array.from(
    new Set(requestRows.filter((row) => row.target_type === "reservation").map((row) => String(row.target_id)))
  );
  const posIds = Array.from(
    new Set(requestRows.filter((row) => row.target_type === "pos_order").map((row) => String(row.target_id)))
  );

  const [reservationMap, posMap] = await Promise.all([
    loadReservationMetaMap(supabase as any, reservationIds),
    loadPosMetaMap(supabase as any, posIds),
  ]);
  return { reservationMap, posMap };
}

function resolveTargetLabel(
  requestRow: RequestRow | null | undefined,
  meta: {
    reservationMap: Map<string, { code: string | null; guestName: string | null }>;
    posMap: Map<string, { code: string | null; guestName: string | null }>;
  }
) {
  if (!requestRow) {
    return { target_code: null, guest_name: null };
  }
  if (requestRow.target_type === "reservation") {
    const found = meta.reservationMap.get(String(requestRow.target_id));
    return {
      target_code: found?.code ?? String(requestRow.target_id),
      guest_name: found?.guestName ?? null,
    };
  }
  const found = meta.posMap.get(String(requestRow.target_id));
  return {
    target_code: found?.code ?? String(requestRow.target_id),
    guest_name: found?.guestName ?? null,
  };
}

async function loadVisiblePendingRequestIds(
  supabase: ReturnType<typeof createServerSupabaseClient>
): Promise<Set<string>> {
  const { data: pendingRequests, error: pendingError } = await supabase
    .from("scb_payment_requests")
    .select("id")
    .eq("status", "pending");
  if (pendingError) throw new Error(pendingError.message);

  const requestIds = (pendingRequests ?? []).map((row: any) => String(row.id)).filter(Boolean);
  if (requestIds.length === 0) return new Set<string>();

  const { data: linkedTransactions, error: linkedTransactionsError } = await supabase
    .from("scb_payment_transactions")
    .select("request_id, status, match_status, created_at")
    .in("request_id", requestIds)
    .order("created_at", { ascending: false });
  if (linkedTransactionsError) throw new Error(linkedTransactionsError.message);

  const latestTxByRequest = new Map<string, PendingLinkedTransaction>();
  for (const transaction of (linkedTransactions ?? []) as PendingLinkedTransaction[]) {
    const requestId = String(transaction.request_id ?? "");
    if (!requestId || latestTxByRequest.has(requestId)) continue;
    latestTxByRequest.set(requestId, transaction);
  }

  const visibleIds = requestIds.filter((requestId) => {
    const linked = latestTxByRequest.get(requestId);
    if (!linked) return true;
    if (linked.match_status === "matched") return false;
    if (linked.match_status === "unmatched") return false;
    if (linked.match_status === "ignored") return false;
    if (linked.status === "success") return false;
    return true;
  });

  return new Set(visibleIds);
}

function applyRequestFilters<T extends { eq: Function; gte: Function; lte: Function }>(
  query: T,
  params: {
    from?: string;
    to?: string;
    channel: "all" | "booking_folio" | "mobile_checkin" | "pos";
    amount_min?: number;
    amount_max?: number;
  }
): T {
  let next = applyDateFilter(query, "created_at", params.from, params.to);
  if (params.channel !== "all") next = next.eq("channel", params.channel);
  if (typeof params.amount_min === "number") next = next.gte("request_amount_total", params.amount_min);
  if (typeof params.amount_max === "number") next = next.lte("request_amount_total", params.amount_max);
  return next;
}

function applyTransactionFilters<T extends { gte: Function; lte: Function; in: Function }>(
  query: T,
  params: {
    dateColumn: "created_at" | "paid_at";
    from?: string;
    to?: string;
    amount_min?: number;
    amount_max?: number;
    requestIdFilter: string[] | null;
  }
): T {
  let next = applyDateFilter(query, params.dateColumn, params.from, params.to);
  if (typeof params.amount_min === "number") next = next.gte("amount", params.amount_min);
  if (typeof params.amount_max === "number") next = next.lte("amount", params.amount_max);
  if (params.requestIdFilter) next = next.in("request_id", params.requestIdFilter);
  return next;
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const role = await getUserRole(supabase, user.id);
    if (role !== "admin" && role !== "supervisor") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    const parsed = querySchema.safeParse({
      tab: request.nextUrl.searchParams.get("tab") ?? undefined,
      page: request.nextUrl.searchParams.get("page") ?? undefined,
      page_size: request.nextUrl.searchParams.get("page_size") ?? undefined,
      from: request.nextUrl.searchParams.get("from") ?? undefined,
      to: request.nextUrl.searchParams.get("to") ?? undefined,
      amount_min: request.nextUrl.searchParams.get("amount_min") ?? undefined,
      amount_max: request.nextUrl.searchParams.get("amount_max") ?? undefined,
      channel: request.nextUrl.searchParams.get("channel") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Invalid query.", details: parsed.error.flatten() }, { status: 400 });
    }

    const { tab, page, page_size, from, to, amount_min, amount_max, channel } = parsed.data;
    const offset = (page - 1) * page_size;

    const visiblePendingIds = await loadVisiblePendingRequestIds(supabase);
    await reconcileScbRequestStatuses(supabase as any, Array.from(visiblePendingIds));

    let requestIdFilter: string[] | null = null;
    if (channel !== "all") {
      const { data: requestIdsByChannel, error: requestIdsError } = await supabase
        .from("scb_payment_requests")
        .select("id")
        .eq("channel", channel);
      if (requestIdsError) {
        return NextResponse.json({ success: false, error: requestIdsError.message }, { status: 500 });
      }
      requestIdFilter = (requestIdsByChannel ?? []).map((row: any) => String(row.id));
      if (requestIdFilter.length === 0) {
        return NextResponse.json({
          success: true,
          tab,
          role,
          counts: { pending: 0, matched: 0, unmatched: 0, expired_failed: 0 },
          summary: { matched_today_count: 0, unmatched_count: 0, matched_today_amount: 0 },
          rows: [],
          pagination: { page, page_size, total: 0 },
        });
      }
    }

    const todayRange = getBangkokDayRange();
    const [
      filteredPendingRowsResult,
      matchedCountResult,
      unmatchedCountResult,
      expiredFailedCountResult,
      matchedTodayRowsResult,
    ] = await Promise.all([
      applyRequestFilters(
        supabase
          .from("scb_payment_requests")
          .select("id, created_at")
          .eq("status", "pending")
          .order("created_at", { ascending: false }),
        { from, to, channel, amount_min, amount_max }
      ),
      applyTransactionFilters(
        supabase
          .from("scb_payment_transactions")
          .select("id", { count: "exact", head: true })
          .eq("match_status", "matched"),
        { dateColumn: "paid_at", from, to, amount_min, amount_max, requestIdFilter }
      ),
      applyTransactionFilters(
        supabase
          .from("scb_payment_transactions")
          .select("id", { count: "exact", head: true })
          .eq("match_status", "unmatched"),
        { dateColumn: "created_at", from, to, amount_min, amount_max, requestIdFilter }
      ),
      applyRequestFilters(
        supabase
          .from("scb_payment_requests")
          .select("id", { count: "exact", head: true })
          .in("status", ["expired", "failed", "cancelled"]),
        { from, to, channel, amount_min, amount_max }
      ),
      applyTransactionFilters(
        supabase
          .from("scb_payment_transactions")
          .select("id, amount, paid_at")
          .eq("match_status", "matched")
          .gte("paid_at", todayRange.start)
          .lte("paid_at", todayRange.end),
        { dateColumn: "paid_at", from, to, amount_min, amount_max, requestIdFilter }
      ),
    ]);

    if (filteredPendingRowsResult.error) {
      return NextResponse.json({ success: false, error: filteredPendingRowsResult.error.message }, { status: 500 });
    }

    const filteredPendingRows = (filteredPendingRowsResult.data ?? []) as Array<{ id: string; created_at: string }>;
    const visibleFilteredPendingRows = filteredPendingRows.filter((row) => visiblePendingIds.has(String(row.id)));

    const counts = {
      pending: visibleFilteredPendingRows.length,
      matched: matchedCountResult.count ?? 0,
      unmatched: unmatchedCountResult.count ?? 0,
      expired_failed: expiredFailedCountResult.count ?? 0,
    };

    const matchedTodayRows = matchedTodayRowsResult.data ?? [];
    const summary = {
      matched_today_count: matchedTodayRows.length,
      unmatched_count: counts.unmatched,
      matched_today_amount: matchedTodayRows.reduce((sum: number, row: any) => sum + Number(row.amount ?? 0), 0),
    };

    if (tab === "pending") {
      const pagedPendingIds = visibleFilteredPendingRows
        .slice(offset, offset + page_size)
        .map((row) => String(row.id));

      const { data, error } = pagedPendingIds.length
        ? await supabase
            .from("scb_payment_requests")
            .select("*")
            .in("id", pagedPendingIds)
        : { data: [], error: null as any };
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      const pageOrder = new Map(pagedPendingIds.map((id, index) => [id, index]));
      const requests = ((data ?? []) as RequestRow[]).sort((a, b) => {
        const aIndex = pageOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = pageOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });
      const requestIds = requests.map((row) => String(row.id));
      const { data: linkedTransactions, error: linkedTransactionsError } = requestIds.length
        ? await supabase
            .from("scb_payment_transactions")
            .select("id, request_id, status, match_status, created_at")
            .in("request_id", requestIds)
            .order("created_at", { ascending: false })
        : { data: [], error: null as any };
      if (linkedTransactionsError) {
        return NextResponse.json({ success: false, error: linkedTransactionsError.message }, { status: 500 });
      }

      const latestTxByRequest = new Map<string, PendingLinkedTransaction>();
      for (const transaction of (linkedTransactions ?? []) as PendingLinkedTransaction[]) {
        const requestId = String(transaction.request_id ?? "");
        if (!requestId) continue;
        if (latestTxByRequest.has(requestId)) continue;
        latestTxByRequest.set(requestId, transaction);
      }

      const requestRepairs = requests
        .map((requestRow) => {
          const linked = latestTxByRequest.get(String(requestRow.id));
          if (!linked) return null;
          if (requestRow.status !== "pending") return null;
          if (linked.match_status !== "matched") return null;
          return { requestId: String(requestRow.id), transactionId: String(linked.id) };
        })
        .filter(Boolean) as Array<{ requestId: string; transactionId: string }>;

      if (requestRepairs.length > 0) {
        await Promise.all(
          requestRepairs.map(({ requestId, transactionId }) =>
            supabase
              .from("scb_payment_requests")
              .update({
                status: "paid",
                paid_transaction_id: transactionId,
                updated_at: new Date().toISOString(),
                error_message: null,
              })
              .eq("id", requestId)
              .eq("status", "pending")
          )
        );
      }

      const pendingRequests = requests.filter((requestRow) => {
        const linked = latestTxByRequest.get(String(requestRow.id));
        if (!linked) return true;
        if (linked.match_status === "matched") return false;
        if (linked.match_status === "unmatched") return false;
        if (linked.match_status === "ignored") return false;
        if (linked.status === "success") return false;
        return true;
      });

      const meta = await buildTargetMeta(supabase, pendingRequests);
      const rows = pendingRequests.map((row) => {
        const target = resolveTargetLabel(row, meta);
        return {
          id: row.id,
          kind: "request",
          request_id: row.id,
          transaction_id: null,
          amount: Number(row.request_amount_total ?? 0),
          payer_name: null,
          payer_account: null,
          paid_at: null,
          created_at: row.created_at,
          channel: row.channel,
          target_type: row.target_type,
          target_id: row.target_id,
          target_code: target.target_code,
          guest_name: target.guest_name,
          status: row.status,
          match_status: null,
          room_amount: Number(row.room_amount ?? 0),
          deposit_amount: Number(row.deposit_amount ?? 0),
          partner_reference_no: row.partner_reference_no,
          error_message: row.error_message,
        };
      });

      const effectiveTotal = visibleFilteredPendingRows.length;

      return NextResponse.json({
        success: true,
        tab,
        role,
        counts,
        summary,
        rows,
        pagination: { page, page_size, total: effectiveTotal },
      });
    }

    if (tab === "recheck_history") {
      let logsQuery = supabase
        .from("scb_recheck_logs")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });
      logsQuery = applyDateFilter(logsQuery, "created_at", from, to);
      const { data, error, count } = await logsQuery.range(offset, offset + page_size - 1);
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      const rows = (data ?? []).map((row: any) => ({
        id: String(row.id),
        kind: "recheck",
        request_id: row.request_id ?? null,
        transaction_id: row.transaction_id ?? null,
        amount: 0,
        payer_name: null,
        payer_account: null,
        paid_at: null,
        created_at: row.created_at,
        channel: null,
        target_type: null,
        target_id: null,
        target_code: null,
        guest_name: null,
        status: row.result_status,
        match_status: null,
      }));
      return NextResponse.json({
        success: true,
        tab,
        role,
        counts,
        summary,
        rows,
        pagination: { page, page_size, total: count ?? (data ?? []).length },
      });
    }

    if (tab === "expired_failed") {
      let requestQuery = supabase
        .from("scb_payment_requests")
        .select("*", { count: "exact" })
        .in("status", ["expired", "failed", "cancelled"])
        .order("created_at", { ascending: false });
      requestQuery = applyDateFilter(requestQuery, "created_at", from, to);
      if (channel !== "all") requestQuery = requestQuery.eq("channel", channel);
      if (typeof amount_min === "number") requestQuery = requestQuery.gte("request_amount_total", amount_min);
      if (typeof amount_max === "number") requestQuery = requestQuery.lte("request_amount_total", amount_max);

      const { data, error, count } = await requestQuery.range(offset, offset + page_size - 1);
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      const requests = (data ?? []) as RequestRow[];
      const meta = await buildTargetMeta(supabase, requests);
      const rows = requests.map((row) => {
        const target = resolveTargetLabel(row, meta);
        return {
          id: row.id,
          kind: "request",
          request_id: row.id,
          transaction_id: null,
          amount: Number(row.request_amount_total ?? 0),
          payer_name: null,
          payer_account: null,
          paid_at: null,
          created_at: row.created_at,
          channel: row.channel,
          target_type: row.target_type,
          target_id: row.target_id,
          target_code: target.target_code,
          guest_name: target.guest_name,
          status: row.status,
          match_status: null,
          room_amount: Number(row.room_amount ?? 0),
          deposit_amount: Number(row.deposit_amount ?? 0),
          partner_reference_no: row.partner_reference_no,
          error_message: row.error_message,
        };
      });
      return NextResponse.json({
        success: true,
        tab,
        role,
        counts,
        summary,
        rows,
        pagination: { page, page_size, total: count ?? rows.length },
      });
    }

    let txQuery = supabase
      .from("scb_payment_transactions")
      .select("*", { count: "exact" })
      .eq("match_status", tab)
      .order(tab === "matched" ? "paid_at" : "created_at", { ascending: false });
    txQuery = applyTransactionFilters(txQuery, {
      dateColumn: tab === "matched" ? "paid_at" : "created_at",
      from,
      to,
      amount_min,
      amount_max,
      requestIdFilter,
    });

    const { data, error, count } = await txQuery.range(offset, offset + page_size - 1);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

    const transactions = (data ?? []) as TransactionRow[];
    const requestIds = Array.from(new Set(transactions.map((row) => row.request_id).filter(Boolean) as string[]));
    const { data: linkedRequests, error: requestError } = requestIds.length
      ? await supabase.from("scb_payment_requests").select("*").in("id", requestIds)
      : { data: [], error: null as any };
    if (requestError) return NextResponse.json({ success: false, error: requestError.message }, { status: 500 });
    const requestMap = new Map(
      ((linkedRequests ?? []) as RequestRow[]).map((row) => [String(row.id), row])
    );

    const filteredTransactions = transactions;
    const requestRows = filteredTransactions
      .map((row) => requestMap.get(String(row.request_id ?? "")))
      .filter(Boolean) as RequestRow[];
    const meta = await buildTargetMeta(supabase, requestRows);
    const rows = filteredTransactions.map((row) => {
      const requestRow = requestMap.get(String(row.request_id ?? "")) ?? null;
      const target = resolveTargetLabel(requestRow, meta);
      return {
        id: row.id,
        kind: "transaction",
        request_id: row.request_id,
        transaction_id: row.transaction_id,
        amount: Number(row.amount ?? 0),
        payer_name: row.payer_name,
        payer_account: row.payer_account,
        paid_at: row.paid_at,
        created_at: row.created_at,
        channel: requestRow?.channel ?? row.payment_channel ?? null,
        target_type: requestRow?.target_type ?? null,
        target_id: requestRow?.target_id ?? null,
        target_code: target.target_code,
        guest_name: target.guest_name ?? row.payer_name,
        status: row.status,
        match_status: row.match_status,
        room_amount: Number(requestRow?.room_amount ?? 0),
        deposit_amount: Number(requestRow?.deposit_amount ?? 0),
        partner_reference_no: row.partner_reference_no ?? requestRow?.partner_reference_no ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      tab,
      role,
      counts,
      summary,
      rows,
      pagination: { page, page_size, total: count ?? rows.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
