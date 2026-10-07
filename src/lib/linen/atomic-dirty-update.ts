import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateBatchItemInput, CreateBatchRewashItemInput } from "@/lib/linen/batch-service";

export type DirtyBatchAtomicInput = {
  batchId: string;
  items: CreateBatchItemInput[];
  rewashItems?: CreateBatchRewashItemInput[];
  createdBy?: string | null;
  consumeDayuseAccumulator?: boolean;
};

export type DirtyBatchAtomicResult = {
  batch_id: string;
  item_count: number;
  rewash_event_ids: number[];
  dayuse_consumed: boolean;
};

function toAtomicDirtyError(error: { message?: string; code?: string }) {
  const message = String(error?.message ?? "Failed to update linen batch.");
  const mapped = new Error(message) as Error & { status?: number };

  if (message === "Batch not found." || error?.code === "P0002") {
    mapped.status = 404;
  } else if (message.startsWith("Batch must be reopened")) {
    mapped.status = 409;
  } else if (error?.code === "22023" || message === "created_by is required for rewash items.") {
    mapped.status = 400;
  }

  return mapped;
}

export async function replaceLaundryBatchDirtyItemsAtomic(
  supabase: SupabaseClient,
  input: DirtyBatchAtomicInput
): Promise<DirtyBatchAtomicResult> {
  const { data, error } = await (supabase as any).rpc("fn_laundry_replace_dirty_items", {
    p_batch_id: input.batchId,
    p_items: input.items,
    p_rewash: input.rewashItems ?? [],
    p_created_by: input.createdBy ?? null,
    p_consume_dayuse_accumulator: Boolean(input.consumeDayuseAccumulator),
  });

  if (error) throw toAtomicDirtyError(error);
  return data as DirtyBatchAtomicResult;
}
