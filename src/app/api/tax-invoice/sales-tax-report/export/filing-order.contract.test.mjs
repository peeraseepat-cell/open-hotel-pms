import assert from "node:assert/strict";
import fs from "node:fs";

// Source contract for the BINDING between the export route and its filing-order
// comparator.
//
// ── Why this file exists ─────────────────
// filing-order.test.mts proves the comparator ORDERS CORRECTLY. It cannot prove
// the route CALLS it — it imports the pure module directly and never touches the
// route. A review deleted `.sort(compareFiledInvoiceRows)` from the route and the
// whole suite stayed GREEN at 360/360: a correct, well-tested comparator that
// nothing invoked, and a government filing back in raw keyset (uuid) order.
//
// This is the same wiring gap I had already written down one PR earlier. The
// header of payments-rowcap.contract.test.mjs says, in my own words: "What
// remains unproven by that test is the WIRING: that these two routes actually
// route their unbounded reads through it. That is a property of the source, so
// the source is what is checked here." I had the remedy, in the right form, in
// the adjacent PR — and did not apply it here. Documentation fires at review
// time; the omission happens at authoring time.
//
// Rule earned, stated so it is reusable: EVERY extraction creates a binding, and
// the binding is a separate assertion from the thing extracted. Pulling logic
// into a pure module to make it testable makes the LOGIC testable and the CALL
// invisible in the same movement.

const route = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/**
 * Comments are stripped so a check about CODE cannot be satisfied by prose — the
 * route's comments legitimately name the comparator while explaining where the
 * ordering went.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const code = stripComments(route);

// ── 1. The comparator must be imported from the extracted module ─────────────
// Not merely present as a name: a local shadow would satisfy a bare name match
// while the tested module sat unused.
assert.match(
  code,
  /import\s*\{\s*compareFiledInvoiceRows\s*\}\s*from\s*["']\.\/filing-order["']/,
  "the export route must import compareFiledInvoiceRows from ./filing-order — the module " +
    "that filing-order.test.mts actually exercises"
);

// ── 2. It must be CALLED, and this is the assertion the gate was missing ─────
assert.match(
  code,
  /\.sort\(\s*compareFiledInvoiceRows\s*\)/,
  "the government filing must be sorted with compareFiledInvoiceRows before it is returned. " +
    "Deleting this call leaves the comparator fully tested and never invoked, and files the " +
    "report in raw keyset (uuid) order — which is what review caught"
);

// ── 3. The sort must apply to the PAGED result, not some other array ─────────
// Ordering a different collection would satisfy check 2 and still file wrongly.
{
  const pagedAt = code.indexOf("fetchAllRowsComplete");
  assert.ok(pagedAt > -1, "the invoices read must still go through the pager");
  const sortAt = code.indexOf(".sort(compareFiledInvoiceRows)");
  assert.ok(
    sortAt > pagedAt,
    "the sort must come AFTER the paged fetch — sorting before it would order an empty or " +
      "partial array and leave the returned rows in cursor order"
  );
  assert.match(
    code.slice(pagedAt, sortAt + 60),
    /return\s+rows\.sort\(\s*compareFiledInvoiceRows\s*\)/,
    "the value RETURNED from loadFullTaxInvoices must be the sorted rows, so no unsorted path " +
      "can reach the workbook builder"
  );
}

// ── 4. The route must not have re-grown its own ordering ─────────────────────
// A site-level .order() would displace the pager's keyset cursor, and an
// invoice_no order in SQL is the text-collation defect this PR exists to fix.
assert.ok(
  !/\.order\(/.test(code),
  "the export route must not pass .order() — the pager owns ordering (keyset cursor), and " +
    "ordering invoice_no in SQL is the variable-width text-collation bug this PR corrects"
);

// ── 5. `id` is fetched for the cursor and must NOT reach the filing ──────────
// It is in the projection only so the pager can page; emitting it would add a
// column to a submitted government document.
assert.match(
  code,
  /\.select\(\s*\n?\s*["']id,/,
  '"id" must be projected — the keyset cursor is read from every row'
);
assert.ok(
  !/["']id["']\s*:/.test(stripComments(route).split("toSalesTaxReportRows")[1] ?? ""),
  "id must not be emitted into the workbook rows — it is a paging cursor, not filing data"
);
