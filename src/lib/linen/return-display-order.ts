import type { LaundryReturnSourceItem } from "@/lib/types";

type DisplayOrderRow = Pick<LaundryReturnSourceItem, "source_business_date" | "source_pickup_round">;

/**
 * Restores the desktop receive-list order that batch-service.ts used to guarantee
 * before A1 moved the query into fn_laundry_return_partition.
 *
 * The comparator is a byte-faithful copy of the legacy one (00546b9^:439-442),
 * localeCompare and `?? 0` included — replicated rather than improved, because the
 * scope freeze forbids changing a rendered order, which includes changing it for
 * the better. The RPC emits lane_order + date DESC + round DESC; the mobile screen
 * re-sorts for itself, so this is the one consumer that needs it.
 *
 * Sorts a copy: the argument is a React prop.
 */
export function sortReturnSourcesForDisplay<T extends DisplayOrderRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const dateCompare = String(a.source_business_date).localeCompare(String(b.source_business_date));
    if (dateCompare !== 0) return dateCompare;
    return Number(a.source_pickup_round ?? 0) - Number(b.source_pickup_round ?? 0);
  });
}
