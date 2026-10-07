// Chronological order for the paged money reads in payments/report and
// payments/detail.
//
// Both routes had a byte-identical private copy of `compareText` plus these two
// comparators. Extracted here for the reason a review proved: the contract
// pins in payments-rowcap.contract.test.mjs assert that `.sort(comparePaymentsChronological)`
// and `.sort(comparePosOrdersChronological)` are CALLED, and the full suite stayed
// GREEN when `compareText` was made inert, when it was direction-flipped, when
// `comparePosOrdersChronological` was made inert, and when the `id` tiebreaker was
// dropped. A comparator has to be RUN to be verified, and it cannot be run while it
// is private to a route handler.
//
// The order is asserted against fixtures in chronological-order.test.mts.

/**
 * Rows as the two routes read them. Fields are `unknown` on purpose: the original
 * `compareText` took `unknown` and coerced with `String(x ?? "")`, so widening the
 * row types here would change behaviour, and narrowing them would reject the route
 * types for no benefit. The names are the contract; the coercion is deliberate.
 */
export type ChronologicalPaymentRow = {
  id?: unknown;
  paid_date?: unknown;
  paid_at?: unknown;
};

export type ChronologicalPosOrderRow = {
  id?: unknown;
  order_date?: unknown;
};

const compareText = (left: unknown, right: unknown): number => {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Restores the SQL order `paid_date, paid_at, id` the paged read used to carry —
 * ASCENDING, i.e. oldest first, which is what a payments ledger reads as.
 *
 * `id` is not decoration. `paid_date` is a date and `paid_at` can be null on
 * back-dated rows, so ties are ordinary; without the tiebreaker tied rows keep
 * whatever order the keyset (uuid) scan produced, which differs run to run.
 */
export function comparePaymentsChronological(
  left: ChronologicalPaymentRow,
  right: ChronologicalPaymentRow
): number {
  return (
    compareText(left.paid_date, right.paid_date) ||
    compareText(left.paid_at, right.paid_at) ||
    compareText(left.id, right.id)
  );
}

/** Restores the SQL order `order_date, id`, ascending, for the POS walk-in read. */
export function comparePosOrdersChronological(
  left: ChronologicalPosOrderRow,
  right: ChronologicalPosOrderRow
): number {
  return compareText(left.order_date, right.order_date) || compareText(left.id, right.id);
}
