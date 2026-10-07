// Row order for the tax-invoice LIST response.
//
// Extracted from route.ts for the same reason as issued-invoice-order.ts: the
// contract pin could only see that a sort was called and that both sides of each
// key appeared inside its body. Neither is an assertion about the resulting order,
// and review mutants proved it — a direction flip on `issue_date` left the
// full suite green. The order is pinned in list-order.test.mts instead.
//
// This array IS the API response order: `listRows` maps `invoiceRows` straight
// through, so a wrong order here is a wrong order in the UI list.

export type InvoiceListOrderRow = {
  id?: string | null;
  issue_date?: string | null;
  created_at?: string | null;
};

/**
 * Restores the SQL order this read used before the keyset pager owned ordering:
 * `issue_date desc, created_at desc, id asc`.
 *
 * `created_at` is the second key and it matters: several invoices are issued on
 * the same date, and the list is expected to show the most recently created of
 * them first. `id` ascending closes the order so a tie is not left to the keyset
 * scan.
 */
export function compareInvoiceListNewestFirst(
  left: InvoiceListOrderRow,
  right: InvoiceListOrderRow
): number {
  const leftIssue = String(left.issue_date ?? "");
  const rightIssue = String(right.issue_date ?? "");
  if (leftIssue !== rightIssue) return leftIssue < rightIssue ? 1 : -1;
  const leftCreated = String(left.created_at ?? "");
  const rightCreated = String(right.created_at ?? "");
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1;
  const leftId = String(left.id ?? "");
  const rightId = String(right.id ?? "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
