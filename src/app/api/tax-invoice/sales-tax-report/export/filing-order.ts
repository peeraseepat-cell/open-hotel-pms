// Row order for the government sales-tax filing.
//
// Extracted from the route so the ORDER OF A FILED DOCUMENT is independently
// testable. It was previously an `.order("issue_date").order("invoice_no")` in
// SQL, which made it untestable without a database and hid the defect below.

export type FiledInvoiceRow = {
  id?: string | null;
  invoice_no?: string | null;
  issue_date?: string | null;
};

/**
 * Orders rows as filed: `issue_date`, then `invoice_no`, then `id`.
 *
 * `invoice_no` is compared NUMERICALLY, not by text collation. This is the fix
 * Decided by the owner: `next_invoice_no` emits `'IV' || YY || LPAD(seq, GREATEST(3,
 * LENGTH(seq)), '0')`, so the sequence is VARIABLE-WIDTH — `IV69999` is 7 chars
 * and `IV691000` is 8. Under text collation the shorter string sorts second
 * because `'9' > '1'` at the third character, so once a year-series passes 999
 * the filing lists invoice 1000 BEFORE invoice 999. Numeric-aware comparison is
 * the same idiom `canReuseInvoiceNumber` already uses for the same reason.
 *
 * Correcting row order does not change any amount — only the sequence rows appear
 * in — but it is a submitted document, which is why it was escalated rather than
 * folded into the truncation fix.
 */
export function compareFiledInvoiceRows(left: FiledInvoiceRow, right: FiledInvoiceRow): number {
  const byDate = String(left.issue_date ?? "").localeCompare(String(right.issue_date ?? ""));
  if (byDate !== 0) return byDate;

  const byNo = String(left.invoice_no ?? "").localeCompare(String(right.invoice_no ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byNo !== 0) return byNo;

  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}
