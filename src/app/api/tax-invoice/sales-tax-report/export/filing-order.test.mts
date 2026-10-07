import assert from "node:assert/strict";

// The row order of a GOVERNMENT SALES-TAX FILING. Separate from the truncation
// fix in an earlier commit, and separate on purpose: this one changes what the
// submitted workbook looks like, so the owner decided it directly.
//
// The defect: `next_invoice_no` builds numbers as
//   'IV' || YY || LPAD(seq, GREATEST(3, LENGTH(seq)), '0')
// so the sequence is VARIABLE-WIDTH. `IV69999` is 7 characters, `IV691000` is 8.
// Text collation compares character by character and decides at position 3
// ('9' vs '1'), so IV691000 < IV69999 — the filing lists invoice 1000 before
// invoice 999 for every year-series that passes 999.

let compareFiledInvoiceRows:
  | ((
      left: { id?: string | null; invoice_no?: string | null; issue_date?: string | null },
      right: { id?: string | null; invoice_no?: string | null; issue_date?: string | null }
    ) => number)
  | undefined;

try {
  ({ compareFiledInvoiceRows } = await import("./filing-order.ts"));
} catch (error) {
  assert.fail(
    `filing-order module is missing: ${error instanceof Error ? error.message : String(error)}`
  );
}

const filed = (invoice_no: string, issue_date = "2026-07-01", id = invoice_no) =>
  ({ invoice_no, issue_date, id });

// ── 1. The defect: past sequence 999, numeric order must win ─────────────────
{
  const rows = [filed("IV691000"), filed("IV69999")];
  const sorted = [...rows].sort(compareFiledInvoiceRows!);
  assert.deepEqual(
    sorted.map((row) => row.invoice_no),
    ["IV69999", "IV691000"],
    "invoice 999 must be filed BEFORE invoice 1000 — text collation reverses them because " +
      "the sequence is variable-width, and this is a submitted document"
  );
}

// ── 2. A whole crossing of the 3-to-4 digit boundary stays monotonic ─────────
{
  const rows = ["IV691002", "IV69998", "IV691000", "IV69999", "IV691001"].map((no) => filed(no));
  const sorted = [...rows].sort(compareFiledInvoiceRows!);
  assert.deepEqual(
    sorted.map((row) => row.invoice_no),
    ["IV69998", "IV69999", "IV691000", "IV691001", "IV691002"],
    "the filing must read as one ascending run across the width change"
  );
}

// ── 3. Positive control: same-width numbers were never broken ────────────────
// Without this, a comparator that returned 0 for everything would pass test 1
// only by luck of a stable sort — and same-width ordering is the case that
// already worked, so it must not regress.
{
  const rows = ["IV69003", "IV69001", "IV69002"].map((no) => filed(no));
  const sorted = [...rows].sort(compareFiledInvoiceRows!);
  assert.deepEqual(
    sorted.map((row) => row.invoice_no),
    ["IV69001", "IV69002", "IV69003"],
    "same-width sequences must still sort ascending"
  );
}

// ── 4. issue_date remains the PRIMARY key of the filing order ───────────────
// The fix must not promote invoice_no above the date; a filing is grouped by day.
{
  const rows = [
    filed("IV69001", "2026-07-02"),
    filed("IV691000", "2026-07-01"),
  ];
  const sorted = [...rows].sort(compareFiledInvoiceRows!);
  assert.deepEqual(
    sorted.map((row) => row.issue_date),
    ["2026-07-01", "2026-07-02"],
    "issue_date must still decide first — a later date cannot precede an earlier one " +
      "regardless of invoice number"
  );
}

// ── 5. `id` is the final tiebreaker, so the order is total ──────────────────
// A filing must be reproducible run to run; two rows identical on date and
// number cannot be left to chance.
{
  const rows = [
    { invoice_no: "IV69001", issue_date: "2026-07-01", id: "zzz" },
    { invoice_no: "IV69001", issue_date: "2026-07-01", id: "aaa" },
  ];
  const sorted = [...rows].sort(compareFiledInvoiceRows!);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ["aaa", "zzz"],
    "ties on date and number must break on id, or the filing is not reproducible"
  );
}

// ── 6. Null-safety: a missing invoice_no must not throw mid-filing ──────────
{
  const rows = [{ invoice_no: null, issue_date: "2026-07-01", id: "b" }, filed("IV69001")];
  assert.doesNotThrow(
    () => [...rows].sort(compareFiledInvoiceRows!),
    "a null invoice_no must sort, not crash the export"
  );
}
