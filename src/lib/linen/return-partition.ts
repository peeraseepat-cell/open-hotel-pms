import type { SupabaseClient } from "@supabase/supabase-js";
import type { LaundryReturnPartitionRow } from "@/lib/types";

const POSTGREST_ROW_CAP = 1000;

export async function listLaundryReturnPartition(
  supabase: SupabaseClient,
  currentBatchId: string
): Promise<LaundryReturnPartitionRow[]> {
  const { data, error, count } = await (supabase as any).rpc(
    "fn_laundry_return_partition",
    { p_current_batch_id: currentBatchId },
    { count: "exact" }
  );

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as LaundryReturnPartitionRow[];
  if (count == null) {
    if (rows.length >= POSTGREST_ROW_CAP) {
      throw new Error(
        `Incomplete return partition: batch_id=${currentBatchId} returned=${rows.length} count unavailable at PostgREST row cap`
      );
    }
    return rows;
  }
  if (rows.length !== count) {
    throw new Error(
      `Incomplete return partition: batch_id=${currentBatchId} returned=${rows.length} expected=${count}`
    );
  }

  return rows;
}
