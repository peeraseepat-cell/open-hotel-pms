// Row order for the two issued-invoice reads in monthly-audit.ts.
//
// Extracted from monthly-audit.ts so the ORDER ITSELF is testable, not merely the
// fact that a sort is called. A review is the reason: the binding pin in
// complete-fetch.contract.test.mjs proves `rows.sort(compareIssuedInvoiceNewestFirst)`
// exists and sits between the fetch and its consumer, and it stayed GREEN on the
// full suite when this comparator was direction-flipped and when it was made inert.
// A pin on the CALL is not an assertion about the COMPUTATION. The computation is
// pinned in issued-invoice-order.test.mts, against fixtures, with no database.

export type IssuedInvoiceOrderRow = {
  id?: string | null;
  issue_date?: string | null;
};

/**
 * Newest `issue_date` first, then `id` ascending as a total-order tiebreaker.
 *
 * Load-bearing in BOTH callers, because the pager returns keyset (uuid) order:
 *  - `loadIssuedFullTaxInvoiceMap` is FIRST-WRITE-WINS (`map.has(id) → continue`),
 *    so row order decides WHICH invoice's `grand_total` is reported as covering a
 *    reservation. That is audited money.
 *  - `loadIssuedFullTaxCoverageMap` ACCUMULATES — it comma-joins `id`/`invoice_no`
 *    in row order and takes `issue_date` from the first row.
 *
 * The `id` tiebreaker is not decoration: `issue_date` is a date, so ties are the
 * common case within a month, and without it the order of tied rows is whatever
 * the keyset scan produced.
 */
export function compareIssuedInvoiceNewestFirst(
  left: IssuedInvoiceOrderRow,
  right: IssuedInvoiceOrderRow
): number {
  const leftDate = String(left?.issue_date ?? "");
  const rightDate = String(right?.issue_date ?? "");
  if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
  const leftId = String(left?.id ?? "");
  const rightId = String(right?.id ?? "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
