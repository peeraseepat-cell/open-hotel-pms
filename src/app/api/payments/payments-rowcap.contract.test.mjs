import assert from "node:assert/strict";
import fs from "node:fs";

// Source-grep contract for the payments report/detail 1000-row cap fix.
//
// Why source-grep and not a behavioural test: the aggregation in both routes is
// inline in the handler, not an exported seam, so there is nothing to call
// without extracting it. The pager itself IS tested behaviourally
// (src/lib/complete-fetch.test.mts, fixture of 1001 rows against a table that
// hard-caps at 1000). What remains unproven by that test is the WIRING: that
// these two routes actually route their unbounded reads through it. That is a
// property of the source, so the source is what is checked here. Stated plainly
// rather than described as full TDD.
//
// ── Amended after review ──────────────────────────────────────────
// This header used to say extraction was outside the PR's scope, and used that to
// justify pinning only the source. It held for the aggregation and NOT for the
// comparators: pinning `.sort(comparePaymentsChronological)` proves the call and
// says nothing about the comparison, so an inert or direction-flipped `compareText`
// left the whole suite green. The two comparators are now in
// ../chronological-order.ts with a fixture test, and what this file pins is the
// binding plus the requirement that neither route re-declare them locally.
// Extraction was not out of scope; it was the only way to make the order testable.

const routes = {
  "payments/report/route.ts": fs.readFileSync(new URL("./report/route.ts", import.meta.url), "utf8"),
  "payments/detail/route.ts": fs.readFileSync(new URL("./detail/route.ts", import.meta.url), "utf8"),
};

/**
 * Strips comments so a check about CODE cannot be satisfied — or defeated — by
 * prose. The `.order()` checks below are negative, and the comments explaining
 * why `.order()` was removed necessarily contain the string.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

for (const [name, source] of Object.entries(routes)) {
  assert.match(
    source,
    /import \{ fetchAllRowsComplete \} from "@\/lib\/complete-fetch"/,
    `${name}: must use the shared pager, not a local copy`
  );

  // Both unbounded reads must be paged.
  assert.match(
    source,
    /fetchAllRowsComplete<PaymentReportRow>/,
    `${name}: the folio_payments read spans a free-form date range and must be paged`
  );
  assert.match(
    source,
    /fetchAllRowsComplete<PosOrderRow>/,
    `${name}: the pos_orders read spans a free-form date range and must be paged`
  );

  // The date-range reads must not survive anywhere OUTSIDE a pager factory.
  // One occurrence each, and each inside the paged construct.
  const paidDateReads = source.match(/\.in\("paid_date", scopedDates\)/g) ?? [];
  assert.equal(
    paidDateReads.length,
    1,
    `${name}: expected exactly one folio_payments date-range read, found ${paidDateReads.length} — a second one is almost certainly unpaged`
  );
  const orderDateReads = source.match(/\.in\("order_date", scopedDates\)/g) ?? [];
  assert.equal(
    orderDateReads.length,
    1,
    `${name}: expected exactly one pos_orders date-range read, found ${orderDateReads.length}`
  );

  // Truncation is now loud. `count: 'exact'` must ride on both paged selects.
  const exactCounts = source.match(/count:\s*["']exact["']/g) ?? [];
  assert.ok(
    exactCounts.length >= 2,
    `${name}: both paged reads need { count: "exact" } as their completeness oracle, found ${exactCounts.length}`
  );

  // PIN, not a fix: the chunkArray(...) reads are bounded by a 200-id `.in()`
  // and are deliberately left alone. If a later "consistency" pass converts
  // them, that is a behaviour change and should not pass silently.
  assert.match(
    source,
    /for \(const chunk of chunkArray\(scopedPaymentIds\)\)/,
    `${name}: the bounded void-reversal lookup must stay chunked, not be folded into the pager`
  );
}

// The chunked reservation_nights read fans out to one row per stay night, so a
// 200-id `.in()` bounds the ARGUMENT, not the RESULT — ~200 reservations across a
// long stay range crosses 1000 rows per chunk. It must be paged even though it
// looks bounded. Its sibling reservations read genuinely is bounded (one row per
// id) and stays a plain query.
{
  const detail = routes["payments/detail/route.ts"];
  const nightsAt = detail.indexOf('.from("reservation_nights")');
  assert.ok(nightsAt > -1, "detail: the reservation_nights read must still exist");
  assert.match(
    detail.slice(Math.max(0, nightsAt - 400), nightsAt),
    /fetchAllRowsComplete/,
    "detail: the reservation_nights read must be paged — chunking bounds the argument, not the row count"
  );
  const nightsCall = detail.slice(nightsAt, nightsAt + 700);
  assert.match(nightsCall, /count:\s*["']exact["']/, "detail: nights read needs a completeness oracle");

  // INVERTED since the keyset rework: this used to require .order("id") as a
  // unique tiebreaker. The pager now owns ordering — it must, because keyset
  // paging requires the cursor to be the PRIMARY sort — so a site-level order
  // would displace the cursor instead of supplementing it.
  assert.ok(
    !/\.order\(/.test(stripComments(nightsCall)),
    "detail: nights read must not pass .order() — the pager orders by its keyset cursor"
  );

  // ...and the cursor has to be readable, so `id` must be projected. This read
  // did not select it before the rework; without it the pager throws at runtime.
  assert.match(
    nightsCall,
    /\.select\(\s*["']id,/,
    'detail: nights read must project "id" first — keyset reads the cursor from every row'
  );
}

// Every paged read in this lane must leave ordering to the pager, and the two
// money reads must have their chronological order restored in JS instead: the
// SQL order they used to carry is gone, and `detail` emits a row list whose
// grouping sorts are not proven total.
for (const [name, source] of Object.entries(routes)) {
  const stripped = stripComments(source);
  const pagedOrders = stripped.match(/\.order\(/g) ?? [];
  assert.equal(
    pagedOrders.length,
    0,
    `${name}: found ${pagedOrders.length} .order() call(s) — the pager owns ordering since the keyset ` +
      `rework. Restore any needed order in JS after the fetch, as comparePaymentsChronological does.`
  );
  assert.match(
    source,
    /\.sort\(comparePaymentsChronological\)/,
    `${name}: the folio_payments rows must be re-sorted to paid_date, paid_at, id after the keyset fetch`
  );
  assert.match(
    source,
    /\.sort\(comparePosOrdersChronological\)/,
    `${name}: the pos_orders rows must be re-sorted to order_date, id after the keyset fetch`
  );

  // Both comparators must resolve to the fixture-tested module. Until a later fix they were
  // private to each route, in byte-identical copies, which is what made the ORDER
  // unassertable: the review made compareText inert, flipped it, made
  // comparePosOrdersChronological inert and dropped the id tiebreaker — four green
  // runs on a money read. What each one computes is now pinned in
  // chronological-order.test.mts; this is the pin that says the routes use it.
  assert.match(
    source,
    /import \{ comparePaymentsChronological, comparePosOrdersChronological \} from "\.\.\/chronological-order"/,
    `${name}: both chronological comparators must be imported from ../chronological-order — a ` +
      `route-local copy is untested by fixtures and drifts from its twin silently`
  );
  for (const local of ["comparePaymentsChronological", "comparePosOrdersChronological", "compareText"]) {
    assert.ok(
      !new RegExp(`(function|const)\\s+${local}\\b`).test(stripComments(source)),
      `${name}: ${local} must not be re-declared locally — a local definition shadows the ` +
        `fixture-tested one and puts the order back out of reach of every test`
    );
  }
}

// The response shape is contractual for both routes — the fix must not have
// renamed or dropped the aggregate the UI reads.
assert.match(routes["payments/report/route.ts"], /tx_count/, "report: tx_count must survive the fix");
assert.match(
  routes["payments/report/route.ts"],
  /for \(const posOrder of posOrderRows\)/,
  "report: POS aggregation must consume the paged rows, not a stale response object"
);
assert.match(
  routes["payments/detail/route.ts"],
  /for \(const posOrder of posOrderRows\)/,
  "detail: POS aggregation must consume the paged rows, not a stale response object"
);
