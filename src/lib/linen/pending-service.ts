import type { SupabaseClient } from "@supabase/supabase-js";

export type ReturnItemInput = {
  source_batch_id: string;
  linen_item_id: number;
  received_qty: number;
  is_dayuse?: boolean;
};

export type PendingResolveInput = {
  pending_item_id: string;
};

type PendingRebuildOptions = {
  createdByBatchId?: string | null;
};

function ensureNonNegativeInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
  return parsed;
}

export function allocatePendingAcrossVariants(
  rows: Array<{
    id: string;
    sent_by_hotel: number;
    received_back: number;
    is_dayuse: boolean;
  }>,
  pendingQty: number
) {
  let remaining = ensureNonNegativeInt(pendingQty, "pending_qty");
  const allocations: Array<{ id: string; qty: number; is_dayuse: boolean }> = [];
  const orderedRows = [...rows].sort(
    (left, right) => Number(Boolean(left.is_dayuse)) - Number(Boolean(right.is_dayuse))
  );

  for (const row of orderedRows) {
    const sentQty = ensureNonNegativeInt(row.sent_by_hotel, "sent_by_hotel");
    const receivedQty = ensureNonNegativeInt(row.received_back, "received_back");
    const available = Math.max(0, sentQty - receivedQty);
    const qty = Math.min(remaining, available);
    if (qty > 0) {
      allocations.push({ id: String(row.id), qty, is_dayuse: Boolean(row.is_dayuse) });
      remaining -= qty;
    }
    if (remaining === 0) break;
  }

  if (remaining > 0) {
    throw new Error("Pending quantity exceeds authoritative remaining linen.");
  }

  return allocations;
}

export async function listPendingItems(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("laundry_pending_items")
    .select("*, linen_items(item_number, name_th), laundry_batches!source_batch_id(business_date, pickup_round)")
    .is("resolved_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    ...row,
    item_number: row.linen_items?.item_number,
    name_th: row.linen_items?.name_th,
    source_batch_date: row.laundry_batches?.business_date,
    source_pickup_round: row.laundry_batches?.pickup_round,
  }));
}

export async function rebuildOpenPendingItemsForSourceBatches(
  supabase: SupabaseClient,
  sourceBatchIds: string[],
  options: PendingRebuildOptions = {}
) {
  const batchIds = Array.from(new Set(sourceBatchIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (batchIds.length === 0) return [];

  const { data: sourceItems, error: sourceItemsError } = await supabase
    .from("laundry_batch_items")
    .select("batch_id, linen_item_id, sent_by_hotel, received_back")
    .in("batch_id", batchIds);
  if (sourceItemsError) throw new Error(sourceItemsError.message);

  const { error: deleteError } = await supabase
    .from("laundry_pending_items")
    .delete()
    .in("source_batch_id", batchIds)
    .is("resolved_at", null);
  if (deleteError) throw new Error(deleteError.message);

  const pendingByItem = new Map<string, { source_batch_id: string; linen_item_id: number; pending_qty: number }>();
  for (const item of sourceItems ?? []) {
    const sourceBatchId = String((item as any).batch_id ?? "");
    const linenItemId = Number((item as any).linen_item_id ?? 0);
    if (!sourceBatchId || !linenItemId) continue;

    const sentQty = ensureNonNegativeInt((item as any).sent_by_hotel, "sent_by_hotel");
    const receivedQty = ensureNonNegativeInt((item as any).received_back, "received_back");
    const pendingQty = Math.max(0, sentQty - receivedQty);
    if (pendingQty <= 0) continue;

    const key = `${sourceBatchId}:${linenItemId}`;
    const current = pendingByItem.get(key) ?? {
      source_batch_id: sourceBatchId,
      linen_item_id: linenItemId,
      pending_qty: 0,
    };
    current.pending_qty += pendingQty;
    pendingByItem.set(key, current);
  }

  const rows = Array.from(pendingByItem.values()).map((row) => ({
    ...row,
    created_by_batch_id: options.createdByBatchId ?? null,
    reason: "return_short",
  }));
  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from("laundry_pending_items")
    .insert(rows)
    .select();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function applyReturnsToSourceBatches(
  supabase: SupabaseClient,
  currentBatchId: string,
  returnItems: ReturnItemInput[] = []
) {
  await supabase.from("laundry_pending_items").delete().eq("created_by_batch_id", currentBatchId).is("resolved_at", null);

  const applied: Array<{
    source_batch_id: string;
    linen_item_id: number;
    received_qty: number;
    returned_pending_qty: number;
    pending_qty: number;
    is_dayuse: boolean;
  }> = [];
  const affectedSourceBatchIds = new Set<string>();

  for (const input of returnItems) {
    const receivedQty = ensureNonNegativeInt(input.received_qty, "received_qty");
    const sourceBatchId = String(input.source_batch_id ?? "").trim();
    if (sourceBatchId) affectedSourceBatchIds.add(sourceBatchId);
    const { data: existing, error: existingError } = await supabase
      .from("laundry_batch_items")
      .select("id, sent_by_hotel, received_back, is_dayuse")
      .eq("batch_id", sourceBatchId)
      .eq("linen_item_id", input.linen_item_id)
      .eq("is_dayuse", Boolean(input.is_dayuse))
      .maybeSingle();

    if (existingError) throw new Error(existingError.message);
    if (!existing) throw new Error("Source batch item not found.");

    const nextReceived = ensureNonNegativeInt((existing as any).received_back, "received_back") + receivedQty;
    const sentQty = ensureNonNegativeInt((existing as any).sent_by_hotel, "sent_by_hotel");
    const { data: oldPendingRows, error: oldPendingError } = await supabase
      .from("laundry_pending_items")
      .select("pending_qty")
      .eq("source_batch_id", sourceBatchId)
      .eq("linen_item_id", input.linen_item_id)
      .is("resolved_at", null);
    if (oldPendingError) throw new Error(oldPendingError.message);
    const oldPendingQty = (oldPendingRows ?? []).reduce(
      (sum: number, row: any) => sum + ensureNonNegativeInt(row.pending_qty, "pending_qty"),
      0
    );

    const { error: updateError } = await supabase
      .from("laundry_batch_items")
      .update({ received_back: nextReceived })
      .eq("id", (existing as any).id);
    if (updateError) throw new Error(updateError.message);

    const pendingQty = Math.max(0, sentQty - nextReceived);

    applied.push({
      source_batch_id: sourceBatchId,
      linen_item_id: input.linen_item_id,
      received_qty: receivedQty,
      returned_pending_qty: Math.min(receivedQty, oldPendingQty),
      pending_qty: pendingQty,
      is_dayuse: Boolean((existing as any).is_dayuse),
    });
  }

  await rebuildOpenPendingItemsForSourceBatches(supabase, [...affectedSourceBatchIds], {
    createdByBatchId: currentBatchId,
  });

  return applied;
}

export async function resolvePendingItems(
  supabase: SupabaseClient,
  currentBatchId: string,
  pendingItems: PendingResolveInput[] = []
) {
  const resolved: Array<{ pending_item_id: string; source_batch_id: string; linen_item_id: number; qty: number; is_dayuse: boolean }> = [];
  const affectedSourceBatchIds = new Set<string>();

  for (const input of pendingItems) {
    const { data: pending, error: pendingError } = await supabase
      .from("laundry_pending_items")
      .select("id, source_batch_id, linen_item_id, pending_qty")
      .eq("id", input.pending_item_id)
      .is("resolved_at", null)
      .maybeSingle();

    if (pendingError) throw new Error(pendingError.message);
    if (!pending) continue;
    affectedSourceBatchIds.add(String((pending as any).source_batch_id));

    const { data: sourceItems, error: itemError } = await supabase
      .from("laundry_batch_items")
      .select("id, sent_by_hotel, received_back, is_dayuse")
      .eq("batch_id", (pending as any).source_batch_id)
      .eq("linen_item_id", (pending as any).linen_item_id)
      .order("is_dayuse", { ascending: true });
    if (itemError) throw new Error(itemError.message);
    if (!sourceItems || sourceItems.length === 0) {
      throw new Error("Source batch item for pending record not found.");
    }

    const qty = ensureNonNegativeInt((pending as any).pending_qty, "pending_qty");
    const allocations = allocatePendingAcrossVariants(
      (sourceItems as any[]).map((item) => ({
        id: String(item.id),
        sent_by_hotel: ensureNonNegativeInt(item.sent_by_hotel, "sent_by_hotel"),
        received_back: ensureNonNegativeInt(item.received_back, "received_back"),
        is_dayuse: Boolean(item.is_dayuse),
      })),
      qty
    );

    for (const allocation of allocations) {
      const item = (sourceItems as any[]).find((row) => String(row.id) === allocation.id);
      if (!item) throw new Error("Source batch item for pending allocation not found.");
      const nextReceived = ensureNonNegativeInt(item.received_back, "received_back") + allocation.qty;
      const { error: updateItemError } = await supabase
        .from("laundry_batch_items")
        .update({ received_back: nextReceived })
        .eq("id", allocation.id);
      if (updateItemError) throw new Error(updateItemError.message);

      resolved.push({
        pending_item_id: String((pending as any).id),
        source_batch_id: String((pending as any).source_batch_id),
        linen_item_id: Number((pending as any).linen_item_id),
        qty: allocation.qty,
        is_dayuse: allocation.is_dayuse,
      });
    }

    const { error: updatePendingError } = await supabase
      .from("laundry_pending_items")
      .update({ resolved_batch_id: currentBatchId, resolved_at: new Date().toISOString() })
      .eq("id", (pending as any).id);
    if (updatePendingError) throw new Error(updatePendingError.message);

  }

  await rebuildOpenPendingItemsForSourceBatches(supabase, [...affectedSourceBatchIds], {
    createdByBatchId: currentBatchId,
  });

  return resolved;
}
