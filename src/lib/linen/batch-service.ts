import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaundryBatchStatus } from "@/lib/types";
import { deleteR2Objects } from "@/lib/r2";
import { applyLaundryReturnStepAtomic } from "@/lib/linen/atomic-return";
import { listLaundryReturnPartition } from "@/lib/linen/return-partition";
import {
  listPendingItems,
  rebuildOpenPendingItemsForSourceBatches,
  type PendingResolveInput,
  type ReturnItemInput,
} from "@/lib/linen/pending-service";
import { replaceLaundryBatchDirtyItemsAtomic } from "@/lib/linen/atomic-dirty-update";

export class LinenBatchError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type CreateBatchItemInput = {
  linen_item_id: number;
  is_dayuse?: boolean;
  estimated_qty: number;
  sent_by_hotel: number;
};

export type CreateBatchRewashItemInput = {
  linen_item_id: number;
  is_dayuse?: boolean;
  qty: number;
  photo_keys: string[];
  note?: string | null;
};

export type CreateBatchInput = {
  business_date: string;
  pickup_round: number;
  vendor_name?: string | null;
  created_by?: string | null;
  notes?: string | null;
  items: CreateBatchItemInput[];
  rewash_items?: CreateBatchRewashItemInput[];
};

export type StepInput = {
  step: "fo_return_counted" | "vendor_signed" | "fo_return_signed";
  actor_name?: string | null;
  vendor_name?: string | null;
  return_items?: ReturnItemInput[];
  pending_resolved?: PendingResolveInput[];
  rewash_resolved?: Array<{ rewash_event_id: number; resolved_qty: number }>;
};

const VALID_TRANSITIONS: Record<LaundryBatchStatus, LaundryBatchStatus[]> = {
  draft: ["fo_dirty_counted"],
  fo_dirty_counted: ["fo_return_counted"],
  fo_return_counted: ["vendor_signed"],
  vendor_signed: ["fo_return_signed"],
  fo_return_signed: ["closed", "partial", "disputed"],
  closed: [],
  partial: ["disputed"],
  disputed: ["fo_dirty_counted"],
};

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new LinenBatchError("Invalid business_date.", 400);
}

function assertCanTransition(from: LaundryBatchStatus, to: LaundryBatchStatus) {
  if (!VALID_TRANSITIONS[from]?.includes(to)) {
    throw new LinenBatchError(`Invalid status transition: ${from} -> ${to}.`, 409);
  }
}

async function logEvent(
  supabase: SupabaseClient,
  batchId: string,
  eventType: string,
  options: { actorName?: string | null; actorRole?: "fo" | "vendor" | "admin"; data?: Record<string, unknown> | null } = {}
) {
  const { error } = await supabase.from("laundry_batch_events").insert({
    batch_id: batchId,
    event_type: eventType,
    actor_name: options.actorName ?? null,
    actor_role: options.actorRole ?? null,
    data: options.data ?? null,
  });
  if (error) throw new Error(error.message);
}

async function rollbackReturnEffects(supabase: SupabaseClient, detail: Awaited<ReturnType<typeof getLaundryBatchDetail>>) {
  const batchId = String((detail.batch as any).id);
  const returnEvents = getActiveBatchEvents(detail, "fo_return_counted");
  const affectedSourceBatchIds = new Set<string>();
  for (const event of returnEvents) {
    const returns = Array.isArray(event.data?.returns) ? event.data.returns : [];
    for (const item of returns) {
      const sourceBatchId = String(item.source_batch_id ?? "");
      if (sourceBatchId) affectedSourceBatchIds.add(sourceBatchId);
      const { data: sourceItem, error: sourceError } = await supabase
        .from("laundry_batch_items")
        .select("id, received_back")
        .eq("batch_id", sourceBatchId)
        .eq("linen_item_id", item.linen_item_id)
        .eq("is_dayuse", Boolean(item.is_dayuse))
        .maybeSingle();
      if (sourceError) throw new Error(sourceError.message);
      if (!sourceItem) continue;

      const nextReceived = Math.max(0, Number((sourceItem as any).received_back ?? 0) - Number(item.received_qty ?? 0));
      const { error: rollbackError } = await supabase
        .from("laundry_batch_items")
        .update({ received_back: nextReceived })
        .eq("id", (sourceItem as any).id);
      if (rollbackError) throw new Error(rollbackError.message);
    }

    const resolved = Array.isArray(event.data?.resolved) ? event.data.resolved : [];
    for (const item of resolved) {
      const sourceBatchId = String(item.source_batch_id ?? "");
      if (sourceBatchId) affectedSourceBatchIds.add(sourceBatchId);
      const { data: sourceItem, error: sourceError } = await supabase
        .from("laundry_batch_items")
        .select("id, received_back")
        .eq("batch_id", sourceBatchId)
        .eq("linen_item_id", item.linen_item_id)
        .eq("is_dayuse", Boolean(item.is_dayuse))
        .maybeSingle();
      if (sourceError) throw new Error(sourceError.message);
      if (sourceItem) {
        const nextReceived = Math.max(0, Number((sourceItem as any).received_back ?? 0) - Number(item.qty ?? 0));
        const { error: rollbackError } = await supabase
          .from("laundry_batch_items")
          .update({ received_back: nextReceived })
          .eq("id", (sourceItem as any).id);
        if (rollbackError) throw new Error(rollbackError.message);
      }

      const { error: unresolveError } = await supabase
        .from("laundry_pending_items")
        .update({ resolved_batch_id: null, resolved_at: null })
        .eq("id", item.pending_item_id);
      if (unresolveError) throw new Error(unresolveError.message);
    }
  }

  const { error: pendingError } = await supabase
    .from("laundry_pending_items")
    .delete()
    .eq("created_by_batch_id", batchId)
    .is("resolved_at", null);
  if (pendingError) throw new Error(pendingError.message);

  await rebuildOpenPendingItemsForSourceBatches(supabase, [...affectedSourceBatchIds]);
}

async function rollbackRewashEffects(supabase: SupabaseClient, detail: Awaited<ReturnType<typeof getLaundryBatchDetail>>) {
  const rewashEvents = getActiveBatchEvents(detail, "rewash_resolved");
  for (const event of rewashEvents) {
    const rewashEventId = Number(event.data?.rewash_event_id ?? 0);
    const appliedQty = Number(event.data?.resolved_qty ?? 0);
    if (!rewashEventId || appliedQty <= 0) continue;

    const { data: existing, error: readError } = await supabase
      .from("laundry_rewash_events")
      .select("id, qty, resolved_qty, status, resolved_batch_id, resolved_at, photo_keys")
      .eq("id", rewashEventId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) continue;

    const totalQty = Math.max(0, Number((existing as any).qty ?? 0));
    const currentResolvedQty = Math.max(0, Number((existing as any).resolved_qty ?? 0));
    const nextResolvedQty = Math.max(0, currentResolvedQty - appliedQty);
    const nextStatus = nextResolvedQty >= totalQty ? "resolved" : "pending";
    const nextResolvedBatchId = nextStatus === "resolved" ? (existing as any).resolved_batch_id : null;

    const { error: updateError } = await supabase
      .from("laundry_rewash_events")
      .update({
        status: nextStatus,
        resolved_qty: nextResolvedQty === 0 ? null : nextResolvedQty,
        resolved_at: nextResolvedQty === 0 ? null : ((existing as any).resolved_at ?? new Date().toISOString()),
        resolved_batch_id: nextResolvedBatchId,
      })
      .eq("id", rewashEventId);
    if (updateError) throw new Error(updateError.message);
  }
}

function getActiveBatchEvents(detail: Awaited<ReturnType<typeof getLaundryBatchDetail>>, eventType: string) {
  const events = detail.events as any[];
  const latestReopenIndex = events.reduce(
    (latest, event, index) => event.event_type === "reopened" ? index : latest,
    -1
  );
  return events
    .slice(latestReopenIndex + 1)
    .filter((event) => event.event_type === eventType);
}

async function restoreDayuseAccumulator(supabase: SupabaseClient, detail: Awaited<ReturnType<typeof getLaundryBatchDetail>>) {
  const dayuseItems = (detail.items as any[]).filter((item) => Boolean(item.is_dayuse) && Number(item.sent_by_hotel ?? 0) > 0);
  for (const item of dayuseItems) {
    const itemId = Number(item.linen_item_id);
    const qty = Number(item.sent_by_hotel ?? 0);
    const { data: existing, error: existingError } = await supabase
      .from("linen_dayuse_pending")
      .select("id, qty_accumulated")
      .eq("linen_item_id", itemId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    if (existing) {
      const { error } = await supabase
        .from("linen_dayuse_pending")
        .update({
          qty_accumulated: Number((existing as any).qty_accumulated ?? 0) + qty,
          sent_in_batch_id: null,
          sent_at: null,
        })
        .eq("id", (existing as any).id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("linen_dayuse_pending").insert({
        linen_item_id: itemId,
        qty_accumulated: qty,
        sent_in_batch_id: null,
        sent_at: null,
      });
      if (error) throw new Error(error.message);
    }
  }
}

export async function listLaundryBatches(
  supabase: SupabaseClient,
  options: {
    dateFrom?: string;
    dateTo?: string;
    status?: string | null;
    linenItemId?: number | null;
    hasExtras?: boolean | null;
    hasRewash?: boolean | null;
    hasEdits?: boolean | null;
    search?: string | null;
  } = {}
) {
  let query = supabase
    .from("laundry_batches")
    .select("*")
    .order("business_date", { ascending: false })
    .order("pickup_round", { ascending: false });

  if (options.dateFrom) query = query.gte("business_date", options.dateFrom);
  if (options.dateTo) query = query.lte("business_date", options.dateTo);
  if (options.status) {
    const statuses = options.status.split(",").map((status) => status.trim()).filter(Boolean);
    query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", options.status);
  }
  if (options.search) {
    const search = options.search.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search)) {
      query = query.or(`id.eq.${search},notes.ilike.%${search}%`);
    } else {
      query = query.ilike("notes", `%${search}%`);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let rows = data ?? [];

  if (options.linenItemId || options.hasExtras != null) {
    const batchIds = rows.map((row: any) => String(row.id));
    if (batchIds.length === 0) return [];
    let itemQuery = supabase
      .from("laundry_batch_items")
      .select("batch_id, linen_item_id, linen_items(is_active)")
      .in("batch_id", batchIds);
    if (options.linenItemId) itemQuery = itemQuery.eq("linen_item_id", options.linenItemId);
    const { data: itemRows, error: itemError } = await itemQuery;
    if (itemError) throw new Error(itemError.message);
    let matchedBatchIds = new Set((itemRows ?? []).map((row: any) => String(row.batch_id)));
    if (options.hasExtras != null) {
      const extraBatchIds = new Set(
        (itemRows ?? [])
          .filter((row: any) => Boolean(row.linen_items?.is_active) === false)
          .map((row: any) => String(row.batch_id))
      );
      matchedBatchIds = options.hasExtras ? extraBatchIds : new Set(batchIds.filter((id) => !extraBatchIds.has(id)));
    }
    rows = rows.filter((row: any) => matchedBatchIds.has(String(row.id)));
  }

  if (options.hasRewash != null) {
    const batchIds = rows.map((row: any) => String(row.id));
    if (batchIds.length === 0) return [];
    const { data: rewashRows, error: rewashError } = await supabase
      .from("laundry_rewash_events")
      .select("sent_in_batch_id")
      .in("sent_in_batch_id", batchIds);
    if (rewashError) throw new Error(rewashError.message);
    const rewashBatchIds = new Set((rewashRows ?? []).map((row: any) => String(row.sent_in_batch_id)));
    rows = rows.filter((row: any) => options.hasRewash ? rewashBatchIds.has(String(row.id)) : !rewashBatchIds.has(String(row.id)));
  }

  if (options.hasEdits != null) {
    const batchIds = rows.map((row: any) => String(row.id));
    if (batchIds.length === 0) return [];
    const { data: editRows, error: editError } = await supabase
      .from("linen_edit_audit_log")
      .select("batch_id")
      .in("batch_id", batchIds);
    if (editError && editError.code !== "42P01") throw new Error(editError.message);
    const editBatchIds = new Set((editRows ?? []).map((row: any) => String(row.batch_id)));
    rows = rows.filter((row: any) => options.hasEdits ? editBatchIds.has(String(row.id)) : !editBatchIds.has(String(row.id)));
  }

  const batchIds = rows.map((row: any) => String(row.id));
  if (batchIds.length === 0) return rows;

  const { data: totalRows, error: totalError } = await supabase
    .from("laundry_batch_items")
    .select("batch_id, sent_by_hotel, received_back")
    .in("batch_id", batchIds);
  if (totalError) throw new Error(totalError.message);

  const totalsByBatch = new Map<string, { total_sent: number; total_received: number }>();
  for (const item of totalRows ?? []) {
    const batchId = String((item as any).batch_id);
    const totals = totalsByBatch.get(batchId) ?? { total_sent: 0, total_received: 0 };
    totals.total_sent += Number((item as any).sent_by_hotel ?? 0);
    totals.total_received += Number((item as any).received_back ?? 0);
    totalsByBatch.set(batchId, totals);
  }

  return rows.map((row: any) => ({
    ...row,
    ...(totalsByBatch.get(String(row.id)) ?? { total_sent: 0, total_received: 0 }),
  }));
}

export async function getLaundryBatchDetail(supabase: SupabaseClient, batchId: string) {
  const { data: batch, error: batchError } = await supabase
    .from("laundry_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (batchError) throw new Error(batchError.message);
  if (!batch) throw new LinenBatchError("Batch not found.", 404);

  const [itemsRes, eventsRes, tokensRes, returnSources, rewashRes, editLogRes, pendingItems] = await Promise.all([
    supabase
      .from("laundry_batch_items")
      .select("*, linen_items(item_number, name_th)")
      .eq("batch_id", batchId)
      .order("is_dayuse", { ascending: true }),
    supabase.from("laundry_batch_events").select("*").eq("batch_id", batchId).order("created_at", { ascending: true }),
    supabase.from("laundry_vendor_tokens").select("*").eq("batch_id", batchId).order("created_at", { ascending: false }).limit(3),
    listLaundryReturnPartition(supabase, batchId),
    supabase
      .from("laundry_rewash_events")
      .select("*, linen_items(item_number, name_th)")
      .eq("sent_in_batch_id", batchId)
      .order("created_at", { ascending: true }),
    supabase
      .from("linen_edit_audit_log")
      .select("*")
      .eq("batch_id", batchId)
      .order("edited_at", { ascending: true }),
    listPendingItems(supabase),
  ]);
  if (itemsRes.error) throw new Error(itemsRes.error.message);
  if (eventsRes.error) throw new Error(eventsRes.error.message);
  if (tokensRes.error) throw new Error(tokensRes.error.message);
  if (rewashRes.error && rewashRes.error.code !== "42P01") throw new Error(rewashRes.error.message);
  if (editLogRes.error && editLogRes.error.code !== "42P01") throw new Error(editLogRes.error.message);

  const eventRows = eventsRes.data ?? [];
  const resolvedRewashRefs = eventRows
    .filter((event: any) => event.event_type === "rewash_resolved")
    .map((event: any) => ({
      event_id: event.id,
      rewash_event_id: Number(event.data?.rewash_event_id ?? 0),
      resolved_qty: Number(event.data?.resolved_qty ?? 0),
      resolved_at: event.created_at,
    }))
    .filter((event) => event.rewash_event_id > 0 && event.resolved_qty > 0);

  let resolvedRewashEvents: any[] = [];
  if (resolvedRewashRefs.length > 0) {
    const { data: resolvedRewashRows, error: resolvedRewashError } = await supabase
      .from("laundry_rewash_events")
      .select("*, linen_items(item_number, name_th)")
      .in("id", [...new Set(resolvedRewashRefs.map((event) => event.rewash_event_id))]);
    if (resolvedRewashError && resolvedRewashError.code !== "42P01") throw new Error(resolvedRewashError.message);

    const rowById = new Map((resolvedRewashRows ?? []).map((row: any) => [Number(row.id), row]));
    resolvedRewashEvents = resolvedRewashRefs
      .map((event) => {
        const row = rowById.get(event.rewash_event_id);
        if (!row) return null;
        return {
          ...row,
          id: `${event.event_id}-${event.rewash_event_id}`,
          rewash_event_id: event.rewash_event_id,
          resolved_qty: event.resolved_qty,
          resolved_at: event.resolved_at,
          item_number: row.linen_items?.item_number,
          name_th: row.linen_items?.name_th,
        };
      })
      .filter(Boolean);
  }

  return {
    batch,
    items: (itemsRes.data ?? []).map((row: any) => ({
      ...row,
      item_number: row.linen_items?.item_number,
      name_th: row.linen_items?.name_th,
    })),
    events: eventRows,
    tokens: tokensRes.data ?? [],
    return_sources: returnSources,
    pending_items: pendingItems,
    rewash_events: (rewashRes.data ?? []).map((row: any) => ({
      ...row,
      item_number: row.linen_items?.item_number,
      name_th: row.linen_items?.name_th,
    })),
    resolved_rewash_events: resolvedRewashEvents,
    edit_audit_log: editLogRes.data ?? [],
  };
}

export async function createLaundryBatch(supabase: SupabaseClient, input: CreateBatchInput) {
  assertDate(input.business_date);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new LinenBatchError("items are required.", 400);

  const { data: rpcData, error: rpcError } = await (supabase as any).rpc("fn_create_laundry_batch_with_rewash", {
    p_batch: {
      business_date: input.business_date,
      pickup_round: input.pickup_round,
      vendor_name: input.vendor_name ?? null,
      created_by: input.created_by ?? null,
      notes: input.notes ?? null,
    },
    p_items: input.items.map((item) => ({
      linen_item_id: item.linen_item_id,
      is_dayuse: Boolean(item.is_dayuse),
      estimated_qty: item.estimated_qty,
      sent_by_hotel: item.sent_by_hotel,
    })),
    p_rewash: (input.rewash_items ?? []).map((item) => ({
      linen_item_id: item.linen_item_id,
      is_dayuse: Boolean(item.is_dayuse),
      qty: item.qty,
      photo_keys: item.photo_keys,
      note: item.note ?? null,
    })),
  });
  if (rpcError) throw new Error(rpcError.message);

  const batchId = String((rpcData as any)?.batch_id ?? "");
  if (!batchId) throw new Error("Batch creation did not return batch_id.");
  const detail = await getLaundryBatchDetail(supabase, batchId);
  return { ...detail, rewash_event_ids: (rpcData as any)?.rewash_event_ids ?? [] };
}

export async function updateLaundryBatchDirtyItems(
  supabase: SupabaseClient,
  batchId: string,
  input: {
    items: CreateBatchItemInput[];
    rewashItems?: CreateBatchRewashItemInput[];
    createdBy?: string | null;
    consumeDayuseAccumulator?: boolean;
  }
) {
  if (!Array.isArray(input.items) || input.items.length === 0) throw new LinenBatchError("items are required.", 400);

  await replaceLaundryBatchDirtyItemsAtomic(supabase, {
    batchId,
    items: input.items,
    rewashItems: input.rewashItems,
    createdBy: input.createdBy,
    consumeDayuseAccumulator: input.consumeDayuseAccumulator,
  });

  return getLaundryBatchDetail(supabase, batchId);
}

export async function deleteLaundryBatch(supabase: SupabaseClient, batchId: string) {
  const detail = await getLaundryBatchDetail(supabase, batchId);
  const currentStatus = String((detail.batch as any).status) as LaundryBatchStatus;
  const deletableStatuses: LaundryBatchStatus[] = ["draft", "fo_dirty_counted", "fo_return_counted", "vendor_signed"];
  if (!deletableStatuses.includes(currentStatus)) {
    throw new LinenBatchError("Only unfinished linen batches can be deleted.", 409);
  }

  await rollbackReturnEffects(supabase, detail);
  await rollbackRewashEffects(supabase, detail);
  await restoreDayuseAccumulator(supabase, detail);

  const signatureKeys = [
    String((detail.batch as any).vendor_pickup_signature_url ?? ""),
    String((detail.batch as any).fo_return_signature_url ?? ""),
  ].filter((key) => key.startsWith("signatures/linen/"));
  const rewashPhotoKeys = (detail.rewash_events as any[] ?? []).flatMap((event) => ((event.photo_keys ?? []) as string[]));
  try {
    await deleteR2Objects([...signatureKeys, ...rewashPhotoKeys]);
  } catch (error) {
    console.error("Failed to delete linen batch R2 objects", error);
  }

  const { count: linkedPendingCount, error: linkedPendingError } = await supabase
    .from("laundry_pending_items")
    .select("id", { count: "exact", head: true })
    .eq("created_by_batch_id", batchId);
  if (linkedPendingError) throw new Error(linkedPendingError.message);
  if ((linkedPendingCount ?? 0) > 0) {
    throw new LinenBatchError("This batch has pending items already resolved by a later batch.", 409);
  }

  const { error: pendingResolvedError } = await supabase
    .from("laundry_pending_items")
    .update({ resolved_batch_id: null, resolved_at: null })
    .eq("resolved_batch_id", batchId);
  if (pendingResolvedError) throw new Error(pendingResolvedError.message);

  const { error: dayuseRefError } = await supabase
    .from("linen_dayuse_pending")
    .update({ sent_in_batch_id: null, sent_at: null })
    .eq("sent_in_batch_id", batchId);
  if (dayuseRefError) throw new Error(dayuseRefError.message);

  const { error } = await supabase
    .from("laundry_batches")
    .delete()
    .eq("id", batchId);
  if (error) throw new Error(error.message);

  return { deleted: true, id: batchId };
}

export async function advanceLaundryBatchStep(supabase: SupabaseClient, batchId: string, input: StepInput) {
  if (input.step === "fo_return_counted") {
    const submission: Record<string, unknown> = {
      return_items: input.return_items ?? [],
      pending_resolved: input.pending_resolved ?? [],
      rewash_resolved: input.rewash_resolved ?? [],
    };
    if (input.vendor_name !== undefined) submission.vendor_name = input.vendor_name;

    await applyLaundryReturnStepAtomic(
      supabase,
      batchId,
      submission,
      input.actor_name ?? null,
      async (entries) => {
        await deleteR2Objects(entries.map((entry) => entry.key));
      }
    );
    return getLaundryBatchDetail(supabase, batchId);
  }

  const detail = await getLaundryBatchDetail(supabase, batchId);
  const currentStatus = String((detail.batch as any).status) as LaundryBatchStatus;
  const nextStatus = input.step as LaundryBatchStatus;
  assertCanTransition(currentStatus, nextStatus);

  const updatePayload: Record<string, unknown> = { status: nextStatus };
  if (input.vendor_name !== undefined) updatePayload.vendor_name = input.vendor_name;

  const { data: batch, error } = await supabase
    .from("laundry_batches")
    .update(updatePayload)
    .eq("id", batchId)
    .select()
    .single();
  if (error) throw new Error(error.message);

  await logEvent(supabase, batchId, input.step, {
    actorName: input.actor_name ?? null,
    actorRole: input.step === "vendor_signed" ? "vendor" : "fo",
    data: {},
  });

  return getLaundryBatchDetail(supabase, String((batch as any).id));
}

export async function reopenLaundryBatch(supabase: SupabaseClient, batchId: string, actorName?: string | null) {
  const detail = await getLaundryBatchDetail(supabase, batchId);
  const currentStatus = String((detail.batch as any).status) as LaundryBatchStatus;
  if (currentStatus === "draft") throw new LinenBatchError("Draft batch does not need reopen.", 409);

  await rollbackReturnEffects(supabase, detail);
  await rollbackRewashEffects(supabase, detail);

  await supabase.from("laundry_vendor_tokens").update({ revoked: true }).eq("batch_id", batchId);

  const { error } = await supabase
    .from("laundry_batches")
    .update({
      status: "fo_dirty_counted",
      vendor_name: null,
      vendor_pickup_signature_url: null,
      fo_return_signature_url: null,
    })
    .eq("id", batchId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, batchId, "reopened", { actorName, actorRole: "admin", data: { previous_status: currentStatus } });
  return getLaundryBatchDetail(supabase, batchId);
}

export async function vendorConfirmBatch(supabase: SupabaseClient, batchId: string, actorName?: string | null) {
  const detail = await getLaundryBatchDetail(supabase, batchId);
  const currentStatus = String((detail.batch as any).status) as LaundryBatchStatus;
  assertCanTransition(currentStatus, "closed");

  const { count, error: pendingError } = await supabase
    .from("laundry_pending_items")
    .select("id", { count: "exact", head: true })
    .is("resolved_at", null);
  if (pendingError) throw new Error(pendingError.message);

  const nextStatus: LaundryBatchStatus = (count ?? 0) > 0 ? "partial" : "closed";
  const { error } = await supabase.from("laundry_batches").update({ status: nextStatus }).eq("id", batchId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, batchId, "vendor_shop_confirmed", { actorName, actorRole: "vendor" });
  await logEvent(supabase, batchId, nextStatus === "closed" ? "closed" : "partial_closed", {
    actorName,
    actorRole: "vendor",
    data: { pending_count: count ?? 0 },
  });
  return getLaundryBatchDetail(supabase, batchId);
}

export async function vendorDisputeBatch(supabase: SupabaseClient, batchId: string, note?: string | null, actorName?: string | null) {
  const detail = await getLaundryBatchDetail(supabase, batchId);
  const currentStatus = String((detail.batch as any).status) as LaundryBatchStatus;
  assertCanTransition(currentStatus, "disputed");

  const { error } = await supabase.from("laundry_batches").update({ status: "disputed", notes: note ?? (detail.batch as any).notes }).eq("id", batchId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, batchId, "disputed", { actorName, actorRole: "vendor", data: { note: note ?? null } });
  return getLaundryBatchDetail(supabase, batchId);
}
