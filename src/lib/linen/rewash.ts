import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteR2Objects } from "@/lib/r2";
import { LinenBatchError } from "@/lib/linen/batch-service";

export type RewashCreateItemInput = {
  linen_item_id: number;
  is_dayuse?: boolean;
  qty: number;
  photo_keys: string[];
  note?: string | null;
};

function assertPhotoKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new LinenBatchError("At least one rewash photo is required.", 400);
  }
  const normalized = keys.map((key) => String(key ?? "").trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new LinenBatchError("At least one rewash photo is required.", 400);
  }
  for (const key of normalized) {
    if (!key.startsWith("rewash/linen/")) {
      throw new LinenBatchError("Invalid rewash photo key.", 400);
    }
  }
  return normalized;
}

export function normalizeRewashItems(items: RewashCreateItemInput[] = []) {
  return items.map((item) => ({
    linen_item_id: Number(item.linen_item_id),
    is_dayuse: Boolean(item.is_dayuse),
    qty: Number(item.qty),
    photo_keys: assertPhotoKeys(item.photo_keys),
    note: item.note ? String(item.note).trim() : null,
  }));
}

export async function createRewashEvents(
  supabase: SupabaseClient,
  input: {
    batchId: string;
    createdBy: string;
    items: RewashCreateItemInput[];
    note?: string | null;
  }
) {
  const items = normalizeRewashItems(input.items);
  if (items.length === 0) throw new LinenBatchError("rewash_items are required.", 400);

  const { data: batch, error: batchError } = await supabase
    .from("laundry_batches")
    .select("id, status")
    .eq("id", input.batchId)
    .maybeSingle();
  if (batchError) throw new Error(batchError.message);
  if (!batch) throw new LinenBatchError("Batch not found.", 404);

  const status = String((batch as any).status ?? "");
  if (status !== "draft" && status !== "fo_dirty_counted") {
    throw new LinenBatchError("Rewash can only be added before return counting.", 409);
  }

  const rows = items.map((item) => ({
    sent_in_batch_id: input.batchId,
    linen_item_id: item.linen_item_id,
    is_dayuse: item.is_dayuse,
    qty: item.qty,
    photo_keys: item.photo_keys,
    created_by: input.createdBy,
    note: item.note ?? input.note ?? null,
  }));

  const { data, error } = await supabase
    .from("laundry_rewash_events")
    .insert(rows)
    .select("*");
  if (error) throw new Error(error.message);

  const eventIds = (data ?? []).map((row: any) => row.id);
  await supabase.from("laundry_batch_events").insert({
    batch_id: input.batchId,
    event_type: "rewash_created",
    actor_role: "fo",
    data: { rewash_event_ids: eventIds, item_count: rows.length },
  });

  return data ?? [];
}

export async function listPendingRewashEvents(
  supabase: SupabaseClient,
  options: { asOf?: string | null } = {}
) {
  let query = supabase
    .from("laundry_rewash_events")
    .select(`
      *,
      linen_items(name_th),
      laundry_batches!sent_in_batch_id(business_date, pickup_round)
    `)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const now = options.asOf ? new Date(`${options.asOf}T00:00:00.000Z`) : new Date();
  return (data ?? [])
    .filter((row: any) => !options.asOf || String(row.laundry_batches?.business_date ?? "") <= options.asOf)
    .map((row: any) => {
    const qty = Number(row.qty ?? 0);
    const resolvedQty = Number(row.resolved_qty ?? 0);
    const remainingQty = Math.max(0, qty - resolvedQty);
    const createdAt = new Date(row.created_at);
    const daysWaiting = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
    return {
      ...row,
      resolved_qty: resolvedQty,
      item_name_th: row.linen_items?.name_th ?? "",
      sent_batch_business_date: row.laundry_batches?.business_date ?? null,
      sent_batch_pickup_round: row.laundry_batches?.pickup_round ?? null,
      days_waiting: daysWaiting,
      remaining_qty: remainingQty,
    };
  })
    .filter((row: any) => Number(row.remaining_qty ?? 0) > 0);
}

export async function resolveRewashEvent(
  supabase: SupabaseClient,
  input: { id: number; resolvedBatchId: string; resolvedQty: number },
  deletePhotos: (keys: string[]) => Promise<unknown> = deleteR2Objects
) {
  const { data: existing, error: existingError } = await supabase
    .from("laundry_rewash_events")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (!existing) throw new LinenBatchError("Rewash event not found.", 404);
  if (String((existing as any).status) !== "pending") {
    throw new LinenBatchError("Rewash event is not pending.", 409);
  }

  const resolvedQty = Math.max(0, Number(input.resolvedQty));
  const maxQty = Number((existing as any).qty ?? 0);
  const currentResolvedQty = Math.max(0, Number((existing as any).resolved_qty ?? 0));
  const nextResolvedQty = currentResolvedQty + resolvedQty;
  if (resolvedQty <= 0) {
    throw new LinenBatchError("resolved_qty must be greater than zero.", 400);
  }
  if (nextResolvedQty > maxQty) {
    throw new LinenBatchError("resolved_qty cannot exceed rewash qty.", 400);
  }
  const isFullyResolved = nextResolvedQty >= maxQty;

  const { data: event, error } = await supabase
    .from("laundry_rewash_events")
    .update({
      status: isFullyResolved ? "resolved" : "pending",
      resolved_batch_id: input.resolvedBatchId,
      resolved_qty: nextResolvedQty,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const photoKeys = ((existing as any).photo_keys ?? []) as string[];
  let deleted = false;
  if (isFullyResolved && photoKeys.length > 0) {
    try {
      await deletePhotos(photoKeys);
      deleted = true;
    } catch (deleteError) {
      console.error("Failed to delete rewash photos", deleteError);
    }
  }

  if (deleted) {
    try {
      const { data: cleared, error: clearError } = await supabase
        .from("laundry_rewash_events")
        .update({ photo_keys: [] })
        .eq("id", input.id)
        .select("*")
        .single();
      if (clearError) throw new Error(clearError.message);
      Object.assign(event as any, cleared);
    } catch (clearError) {
      console.error("Failed to clear resolved rewash photo keys", {
        rewash_event_id: input.id,
        stale_keys: photoKeys,
        error: clearError,
      });
    }
  }

  await supabase.from("laundry_batch_events").insert({
    batch_id: input.resolvedBatchId,
    event_type: "rewash_resolved",
    actor_role: "fo",
    data: {
      rewash_event_id: input.id,
      resolved_qty: resolvedQty,
      total_resolved_qty: nextResolvedQty,
      remaining_qty: Math.max(0, maxQty - nextResolvedQty),
      photos_deleted: deleted,
    },
  });

  return event;
}

export async function expireOldRewashEvents(supabase: SupabaseClient, olderThanIso: string, limit = 200) {
  const { data: rows, error } = await supabase
    .from("laundry_rewash_events")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", olderThanIso)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const expired: number[] = [];
  for (const row of rows ?? []) {
    const id = Number((row as any).id);
    const photoKeys = ((row as any).photo_keys ?? []) as string[];
    const { error: updateError } = await supabase
      .from("laundry_rewash_events")
      .update({ status: "expired", resolved_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw new Error(updateError.message);

    try {
      await deleteR2Objects(photoKeys);
      await supabase.from("laundry_rewash_events").update({ photo_keys: [] }).eq("id", id);
    } catch (deleteError) {
      console.error("Failed to delete expired rewash photos", deleteError);
    }

    await supabase.from("laundry_batch_events").insert({
      batch_id: String((row as any).sent_in_batch_id),
      event_type: "rewash_expired",
      actor_role: "admin",
      data: { rewash_event_id: id },
    });
    expired.push(id);
  }

  return { expired_count: expired.length, expired_ids: expired };
}
