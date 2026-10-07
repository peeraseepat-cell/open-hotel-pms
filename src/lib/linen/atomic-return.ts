import type { SupabaseClient } from "@supabase/supabase-js";

export type RewashPhotoCleanupEntry = {
  rewash_event_id: number;
  key: string;
};

export type LaundryAtomicReturnResult = {
  batch_id: string;
  status: "fo_return_counted";
  returns: unknown[];
  resolved: unknown[];
  rewash_resolved: unknown[];
  photo_cleanup: RewashPhotoCleanupEntry[];
};

function toAtomicReturnError(error: { message?: string; code?: string }) {
  const message = String(error?.message ?? "Failed to apply linen return step.");
  const mapped = new Error(message) as Error & { status?: number };

  if (message === "Batch not found."
    || message === "Source batch item not found."
    || message === "Rewash event not found."
    || error?.code === "P0002") {
    mapped.status = 404;
  } else if (message.startsWith("Invalid status transition:")
    || message === "Rewash event is not pending.") {
    mapped.status = 409;
  } else if (error?.code === "22023"
    || message === "resolved_qty must be greater than zero."
    || message === "resolved_qty cannot exceed rewash qty.") {
    mapped.status = 400;
  }

  return mapped;
}

export async function clearResolvedRewashPhotoKeys(
  supabase: SupabaseClient,
  entries: RewashPhotoCleanupEntry[]
) {
  const eventIds = [...new Set(entries.map((entry) => entry.rewash_event_id))];
  for (const eventId of eventIds) {
    const { error } = await supabase
      .from("laundry_rewash_events")
      .update({ photo_keys: [] })
      .eq("id", eventId)
      .eq("status", "resolved");
    if (error) throw new Error(error.message);
  }
}

export async function applyLaundryReturnStepAtomic(
  supabase: SupabaseClient,
  currentBatchId: string,
  submission: Record<string, unknown>,
  actorName: string | null,
  cleanupPhotos?: (entries: RewashPhotoCleanupEntry[]) => Promise<void>
): Promise<LaundryAtomicReturnResult> {
  const { data, error } = await (supabase as any).rpc("fn_laundry_apply_return_step", {
    p_current_batch_id: currentBatchId,
    p_submission: submission,
    p_actor_name: actorName,
  });

  if (error) throw toAtomicReturnError(error);

  const result = data as LaundryAtomicReturnResult;
  const cleanupEntries = Array.isArray(result?.photo_cleanup) ? result.photo_cleanup : [];
  if (cleanupEntries.length > 0 && cleanupPhotos) {
    try {
      await cleanupPhotos(cleanupEntries);
    } catch (cleanupError) {
      for (const entry of cleanupEntries) {
        console.error("Failed to delete committed linen rewash R2 object", {
          batch_id: currentBatchId,
          rewash_event_id: entry.rewash_event_id,
          orphan_key: entry.key,
          error: cleanupError,
        });
      }
      return result;
    }

    try {
      await clearResolvedRewashPhotoKeys(supabase, cleanupEntries);
    } catch (clearError) {
      for (const entry of cleanupEntries) {
        console.error("Failed to clear deleted linen rewash photo key", {
          batch_id: currentBatchId,
          rewash_event_id: entry.rewash_event_id,
          stale_key: entry.key,
          error: clearError,
        });
      }
    }
  }

  return result;
}
