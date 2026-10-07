import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source contract: Pending queue must use collectFullyCoveredReservationIds so a full-covering
// prepayment leaves the queue. The issued-invoices select must project
// coverage_amount + grand_total for that math.

const routePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "route.ts");
const source = fs.readFileSync(routePath, "utf8");

assert.match(
  source,
  /collectFullyCoveredReservationIds/,
  "tax-invoice GET Pending must call collectFullyCoveredReservationIds"
);

assert.match(
  source,
  /from\s+["']@\/lib\/tax-invoice\/pending-fully-covered["']/,
  "Pending coverage helper must be imported from pending-fully-covered"
);

const issuedLabel = 'label: "issued invoices"';
const labelAt = source.indexOf(issuedLabel);
assert.ok(labelAt > -1, "issued invoices paged read must remain labelled");

// Window: from the preceding .from("invoices") back-stop to the label.
const fromAt = source.lastIndexOf('.from("invoices")', labelAt);
assert.ok(fromAt > -1, "issued invoices label must sit on an invoices query");
const site = source.slice(fromAt, labelAt);

assert.match(
  site,
  /coverage_amount/,
  "issued invoices select must include coverage_amount for prepayment full-cover detection"
);
assert.match(
  site,
  /grand_total/,
  "issued invoices select must include grand_total fallback for coverage amount"
);

// Old Pending filter ignored every prepayment regardless of coverage amount.
assert.doesNotMatch(
  source,
  /normalizeInvoiceKind\(\s*row\.invoice_kind\s*\)\s*!==\s*["']prepayment["']\s*\)[\s\S]{0,80}?\.flatMap/,
  "must not keep the prepayment-blind Pending filter that stranded full-cover prepayments"
);

console.log("pending-fully-covered.contract.test.mjs: all assertions passed");
