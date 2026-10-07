/**
 * F1 — drop pending markers that the return_items pass will already have closed.
 *
 * Legacy ran the two passes sequentially against the DB: applyReturnItems updated
 * received_back and called rebuildOpenPendingItemsForSourceBatches, which closes
 * the marker; resolvePendingItems then looked the marker up with
 * `.is("resolved_at", null)`, found nothing, and hit `if (!pending) continue`
 * (pending-service.ts:220) — a SILENT SKIP. The press succeeded.
 *
 * The atomic RPC rejects the same overlap with 22023 and rolls the whole press
 * back, so a press that worked yesterday stops working. Restoring the legacy
 * outcome means not sending the marker in the first place.
 *
 * KEY IS THE PAIR (source_batch_id, linen_item_id), NOT the triple with is_dayuse.
 * A pending marker is not dayuse-discriminated anywhere in the model:
 *   - laundry_pending_items carries no is_dayuse (pending-service.ts:213 select)
 *   - the rebuild lookup filters on the pair only (pending-service.ts:165-170)
 *   - allocatePendingAcrossVariants SPREADS one marker across both variants
 * Keying on the triple would leak: a marker covering both variants would survive
 * when only the non-dayuse row carried a positive qty, and still collide.
 *
 * "Positive" matters: a typed 0 does not close a marker in legacy either, because
 * it does not change received_back, so a 0 must NOT drop the marker.
 */

export interface ReturnItemPayloadRow {
  source_batch_id: string;
  linen_item_id: number;
  received_qty: number;
}

export interface PendingMarker {
  id: string;
  source_batch_id: string;
  linen_item_id: number;
}

const pairKey = (sourceBatchId: string, linenItemId: number) => `${sourceBatchId}:${linenItemId}`;

/**
 * Returns the pending_item_ids that are still safe to send: the caller's selection
 * minus any marker whose (source_batch_id, linen_item_id) already carries a
 * POSITIVE received_qty in the same payload.
 *
 * Order of the surviving ids is preserved — it reaches the stored event.
 */
export function dropPendingResolvedCoveredByReturns(
  selectedPendingIds: readonly string[],
  returnItems: readonly ReturnItemPayloadRow[],
  pendingMarkers: readonly PendingMarker[]
): string[] {
  const covered = new Set(
    returnItems
      .filter((row) => Number(row.received_qty) > 0)
      .map((row) => pairKey(row.source_batch_id, row.linen_item_id))
  );

  const markerById = new Map(pendingMarkers.map((marker) => [marker.id, marker]));

  return selectedPendingIds.filter((id) => {
    const marker = markerById.get(id);
    // An id with no known marker is left alone: dropping it would be a second
    // behaviour change, and the server already tolerates an unknown id.
    if (!marker) return true;
    return !covered.has(pairKey(marker.source_batch_id, marker.linen_item_id));
  });
}
