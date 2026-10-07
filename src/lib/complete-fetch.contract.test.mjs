import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Source-grep contract for the complete-fetch pager. The behavioural test in
// complete-fetch.test.mts proves the pager itself is correct; it cannot prove
// that the CALLERS are wired to it. That is a property of the source, so the
// source is what is checked here.
//
// ── Rewritten after a review addendum ─────────────────────────
// The previous version asserted `callSites.length >= 8`. Z defeated it: a FLOOR
// cannot detect a REVERSION, so reverting canReuseInvoiceNumber to a naked
// `.limit(5000)` left 8 sites and stayed green. His second finding was that the
// `.limit(5000)` sweep keyed on `booking_snapshot` adjacency, which the reverted
// query's shape did not have.
//
// Both are fixed the same way — stop describing the invariant approximately:
//   1. EXACT enumeration. The expected sites are named, and the total is pinned
//      to ==, so removing one fails and adding an unpinned one also fails.
//   2. The `.limit(5000)` sweep no longer looks for a neighbouring column name;
//      it rejects the string outright in the swept files, so no query SHAPE can
//      slip past it.
//
// Note the inverted invariant since the keyset rework: call sites must NOT pass
// their own `.order()`. The pager owns ordering because keyset paging requires
// the cursor column to be the primary sort, so a site-level order would fight
// the cursor. Sites that need a different order sort in JS after the fetch.

const SRC = path.resolve(new URL("../", import.meta.url).pathname);
const HELPER = "fetchAllRowsComplete";

/**
 * Every paged read, named exactly. `label` is unique per call within its file,
 * which is what makes each site addressable without a fragile text window.
 */
const EXPECTED_SITES = [
  { file: "app/api/tax-invoice/route.ts", label: "invoices", factory: "buildInvoiceQuery" },
  { file: "app/api/tax-invoice/route.ts", label: "pending tax-invoice reservations" },
  { file: "app/api/tax-invoice/route.ts", label: "issued invoices" },
  { file: "app/api/tax-invoice/route.ts", label: "existing invoices" },
  { file: "app/api/tax-invoice/[id]/route.ts", label: "issued invoice numbers" },
  { file: "app/api/tax-invoice/[id]/issue/route.ts", label: "issued invoices" },
  { file: "lib/monthly-audit.ts", label: "issued full tax invoices" },
  { file: "lib/monthly-audit.ts", label: "issued full tax invoice coverage" },
  { file: "lib/abbreviated-tax-invoice/service.ts", label: "issued full tax invoices" },
  // Added in a later change:
  { file: "app/api/tax-invoice/sales-tax-report/export/route.ts", label: "full tax invoices for the sales-tax report" },
  { file: "lib/abbreviated-tax-invoice/service.ts", label: "monthly audit entries" },
  { file: "lib/abbreviated-tax-invoice/service.ts", label: "overlapping reservations" },
  // Added in a later change. These five were INVISIBLE to the old counter, which
  // matched `await fetchAllRowsComplete` — four of them sit inside a
  // `Promise.all([...])` and so have no `await` of their own. A review found that;
  // fixing the counter to a token match is what surfaced them, and declaring them
  // here is what subjects them to the per-site checks above.
  { file: "app/api/payments/report/route.ts", label: "folio payments" },
  { file: "app/api/payments/report/route.ts", label: "POS walk-in orders" },
  { file: "app/api/payments/detail/route.ts", label: "folio payments", factory: "buildPaymentsQuery" },
  { file: "app/api/payments/detail/route.ts", label: "POS walk-in orders" },
  { file: "app/api/payments/detail/route.ts", label: "reservation nights" },
  // Group-B tier 1. Two different shapes of the SAME defect, which is why they
  // land together:
  //   - the revenue route paged by offset with NO .order() at all;
  //   - loadNights paged by offset under .order("stay_date"), which LOOKS ordered
  //     and is not a total order — stay_date is not unique on reservation_nights
  //     (only the (room, day) composites are), so ties could reshuffle across a
  //     page boundary and duplicate or skip exactly as the unordered read did.
  // The second outlived the first precisely because it looked safe.
  { file: "app/api/revenue/route.ts", label: "revenue nights" },
  { file: "app/api/revenue/route.ts", label: "revenue POS orders" },
  { file: "app/api/revenue/route.ts", label: "revenue extra charges" },
  { file: "app/api/revenue/route.ts", label: "revenue day-use" },
  { file: "lib/abbreviated-tax-invoice/service.ts", label: "invoice nights" },
];

/**
 * Files this PR finished. A `.limit(5000)` anywhere in one of these is a
 * reversion, in any query shape.
 *
 * Deliberately NOT the whole cluster, and the omissions are named so this does
 * not read as a loosened check:
 *   - `app/api/receipt/route.ts:73` and `app/api/admin/settings/route.ts:532`
 *     are group B — a different lane's files, not this sweep's to pin.
 *
 * `service.ts` and the sales-tax export were omitted while the first change stood alone,
 * because both still carried capped reads that were a later change's scope. **That change paged
 * them and adds them here**, which is the promise the first change made coming good: the
 * invariant tightens as the stack lands rather than being asserted before it was
 * true.
 */
const SWEPT_FILES = [
  "lib/monthly-audit.ts",
  "app/api/tax-invoice/route.ts",
  "app/api/tax-invoice/[id]/route.ts",
  "app/api/tax-invoice/[id]/issue/route.ts",
  "lib/abbreviated-tax-invoice/service.ts",
  "app/api/tax-invoice/sales-tax-report/export/route.ts",
  // A later change finished both payments routes; verified 0 occurrences before adding.
  "app/api/payments/report/route.ts",
  "app/api/payments/detail/route.ts",
];

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

/**
 * Strips line and block comments so a check about CODE cannot be satisfied — or
 * defeated — by prose. Both of this file's negative checks describe constructs
 * that the surrounding docstrings legitimately name while explaining why they
 * were removed.
 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── 1. IDENTITY FIRST — every named site is PRESENT ─────────────────────────
// Deliberately ordered ahead of the total. The review's framing, and it is this
// sweep's own size-vs-identity lesson one layer up: a COUNT of call sites
// certifies QUANTITY, never IDENTITY. A revert paired with any newly added paged
// read leaves the total intact, so the manifest has to speak first — and it names
// the site that vanished instead of reporting an arithmetic mismatch.
//
// REQUIRED MUTANT for a source-grep guard like this one (review rule 4
// corollary): TOTAL REMOVAL, never a partial edit. Restoring a swept file
// byte-for-byte to its pre-sweep self takes the call site, the pager import and
// the `count: "exact"` away together — so any check scoped to "files that still
// import the helper" lets that file walk out of the guard's scope on its way to
// being broken, and tsc cannot see it either because the file is its own previous
// self. Verified against this head, not assumed: service.ts reverted to 37d0fc8^
// (3 × `.limit(5000)`, 0 pager imports) → RED here, and RED again when a decoy
// paged read was added to hold the total at 9.
for (const { file, label, factory } of EXPECTED_SITES) {
  // STRIPPED BEFORE the window is located, so every offset below refers to code.
  // The masking sweep, source [1] of 3: the positive pins here (`count: "exact"`,
  // the `id` projection) read raw text, so a comment inside a site's window quoting
  // either one satisfies the pin for a read that no longer has it.
  const source = stripComments(read(file));
  const labelToken = `label: "${label}"`;
  const labelAt = source.indexOf(labelToken);
  assert.ok(
    labelAt > -1,
    `${file}: the paged read labelled "${label}" is gone. If it was reverted to a naked ` +
      `.limit(5000) the row cap is back; if it was renamed, update EXPECTED_SITES.`
  );

  // Bound the window precisely: from the call that owns this label back to the
  // helper name. No adjacency guessing, so no false positive from nearby code.
  const callAt = source.lastIndexOf(HELPER, labelAt);
  assert.ok(callAt > -1, `${file}: "${label}" has no ${HELPER} call before it`);
  const site = source.slice(callAt, labelAt);

  // A named factory is defined above the call, so check its definition instead.
  const body = factory
    ? (() => {
        const at = source.search(new RegExp(`const\\s+${factory}\\s*=`));
        assert.ok(at > -1, `${file}: named factory ${factory} is not defined in this file`);
        return source.slice(at, source.indexOf("\n    };", at));
      })()
    : site;

  assert.match(
    body,
    /count:\s*["']exact["']/,
    `${file} [${label}]: the paged select needs { count: "exact" } — without it the pager ` +
      `has no completeness oracle and refuses at runtime`
  );

  // Keyset paging reads the cursor out of every row, so `id` must be projected.
  assert.match(
    body,
    /\.select\(\s*(\n\s*)?["'`]id[,"'`]/,
    `${file} [${label}]: "id" must be FIRST in the select projection — keyset paging reads ` +
      `the cursor from each row and throws if it is absent`
  );

  // Inverted since the keyset rework: the pager owns ordering.
  assert.ok(
    !/\.order\(/.test(body),
    `${file} [${label}]: do not pass .order() — the pager orders by its keyset cursor, and a ` +
      `site-level order would displace it. Need a different order? Sort in JS after the fetch, ` +
      `as monthly-audit and the invoice list both do.`
  );
}

// ── 2. THEN the exact total — catches an UNPINNED ADDITION ──────────────────
// The manifest above cannot see a paged read nobody declared. This can. It is ==
// and not >= because a floor cannot detect a reversion: a review blocked an earlier version by
// reverting canReuseInvoiceNumber to a naked `.limit(5000)`, which left 8 sites
// and stayed green under `>= 8`.
//
// ── The counter itself had two opposite defects, both found in review ─
// They are one gap seen from two sides — PROSE INFLATES, Promise.all HIDES:
//   (a) it matched `await fetchAllRowsComplete`, so a call inside
//       `Promise.all([ fetchAllRowsComplete(...), ... ])` has no `await` of its
//       own and was INVISIBLE. Z measured 15 real calls where this reported 9.
//       An undercount is the dangerous direction: it hides exactly the reads a
//       concurrent handler makes, and those are the busiest ones.
//   (b) it read COMMENTS as code, so a decoy in prose pushed 9 -> 10 and turned
//       the pin RED on something that never executes. `stripComments` was already
//       defined in this file and simply not applied here.
// Fixed by counting a CALL token over comment-stripped source.
//   (c) third defect, found again in review: the first fix counted
//       `fetchAllRowsComplete<`, on the reasoning that "every call site passes a
//       type argument". That is a fact about today's nine sites, not a property of
//       the language — `T` infers from the factory, so `fetchAllRowsComplete(() =>
//       …)` compiles with tsc clean and was invisible again. I reproduced it: a real
//       paged read added with no type argument left the suite GREEN where it owed
//       "found 10". Counting `[<(]` matches BOTH call forms and still skips the bare
//       import specifier, which is followed by ` }`.
{
  const files = fs
    .readdirSync(SRC, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(ts|tsx)$/.test(entry))
    .filter((entry) => !entry.endsWith("complete-fetch.ts"));

  let total = 0;
  const perFile = new Map();
  for (const rel of files) {
    const matches = stripComments(read(rel)).match(new RegExp(`${HELPER}\\s*[<(]`, "g")) ?? [];
    if (matches.length === 0) continue;
    perFile.set(rel, matches.length);
    total += matches.length;
  }

  assert.equal(
    total,
    EXPECTED_SITES.length,
    `expected exactly ${EXPECTED_SITES.length} paged reads, found ${total}. Per file: ` +
      `${JSON.stringify(Object.fromEntries(perFile))}. If you added a paged read on ` +
      `purpose, add it to EXPECTED_SITES so it gets the per-site checks too.`
  );
}

// ── 2b. ORDER RESTORATIONS MUST BE BOUND, not merely defined ────────────────
// Found by asking whether an earlier review finding was a class rather than one site.
// It was. Deleting each of these three `.sort(...)` calls left the FULL suite
// green at 360/360 — three order restorations that this PR's own comments call
// LOAD-BEARING, enforced by nothing. A comment is an assertion that can never
// fail; only a mutant can tell you whether a structure prevents anything.
//
// Severity is why these are pinned rather than noted. The pager now orders by its
// keyset cursor, so if one of these sorts disappears the rows arrive in uuid order
// and:
//   * loadIssuedFullTaxInvoiceMap is FIRST-WRITE-WINS — row order decides WHICH
//     invoice's grand_total is reported as covering a reservation. Audited money.
//   * loadIssuedFullTaxCoverageMap ACCUMULATES — it comma-joins id/invoice_no in
//     row order and takes issue_date from the first row.
//   * the invoice list sort IS the API response order.
{
  const audit = read("lib/monthly-audit.ts");
  const auditCode = stripComments(audit);

  const bindings = auditCode.match(/rows\.sort\(compareIssuedInvoiceNewestFirst\)/g) ?? [];
  assert.equal(
    bindings.length,
    2,
    `lib/monthly-audit.ts: expected BOTH issued-invoice reads to restore newest-first order ` +
      `after the keyset fetch, found ${bindings.length}. Deleting one changes which invoice's ` +
      `grand_total is reported as covering a reservation — the comment saying it is load-bearing ` +
      `does not enforce it.`
  );

  // Bound to the right reads, and bounded on BOTH sides. Checking only
  // `sortAt > fetchAt` was not enough: a mutant that moved the sort to AFTER the
  // consuming loop still satisfied it and stayed green. The real invariant is
  // fetch → sort → consume, so the consumer is the upper bound.
  for (const fn of ["loadIssuedFullTaxInvoiceMap", "loadIssuedFullTaxCoverageMap"]) {
    const at = auditCode.indexOf(`export async function ${fn}`);
    assert.ok(at > -1, `lib/monthly-audit.ts: ${fn} is gone`);
    const body = auditCode.slice(at, at + 2600);
    const fetchAt = body.indexOf(HELPER);
    const sortAt = body.indexOf("rows.sort(compareIssuedInvoiceNewestFirst)");
    const consumeAt = body.indexOf("for (const row of rows)");
    assert.ok(fetchAt > -1, `${fn}: must still page through ${HELPER}`);
    assert.ok(consumeAt > -1, `${fn}: the row-consuming loop is gone`);
    assert.ok(
      sortAt > fetchAt,
      `${fn}: the newest-first restore must come AFTER its paged fetch — the pager returns ` +
        `keyset (uuid) order`
    );
    assert.ok(
      sortAt < consumeAt,
      `${fn}: the newest-first restore must come BEFORE the loop that consumes the rows. ` +
        `Sorting afterwards is indistinguishable from not sorting at all for this consumer, ` +
        `and it decides which invoice's grand_total covers a reservation.`
    );
  }

  // The comparator must come from the module that has a fixture test. It used to be
  // a private `function compareIssuedInvoiceNewestFirst` here, and this pin used to
  // assert only that it existed — which is why review mutants (direction flip,
  // inert) were both green on the full suite. What it COMPUTES is asserted in
  // lib/issued-invoice-order.test.mts; what this file can assert is that the name
  // resolves there and not to a local redefinition.
  assert.match(
    auditCode,
    /import\s*{\s*compareIssuedInvoiceNewestFirst\s*}\s*from\s*"@\/lib\/issued-invoice-order"/,
    "lib/monthly-audit.ts: the newest-first comparator must be imported from " +
      "@/lib/issued-invoice-order — a local copy is untested by fixtures and can drift"
  );
  assert.ok(
    !/function\s+compareIssuedInvoiceNewestFirst/.test(auditCode),
    "lib/monthly-audit.ts: the comparator must not be redefined locally — a local definition " +
      "shadows the fixture-tested one and the order becomes unverifiable again"
  );
}

{
  // The invoice list read: its order IS the response, since listRows maps
  // invoiceRows straight through.
  const listCode = stripComments(read("app/api/tax-invoice/route.ts"));
  assert.match(
    listCode,
    /invoiceRowsRaw\s*\?\?\s*\[\]\)\s*as\s*InvoiceRow\[\]\)\.sort\(compareInvoiceListNewestFirst\)/,
    "app/api/tax-invoice/route.ts: the invoice list must be re-sorted after the keyset fetch, by " +
      "compareInvoiceListNewestFirst — this array becomes the API response order, so dropping the " +
      "sort reorders the UI list"
  );
  assert.match(
    listCode,
    /import\s*{\s*compareInvoiceListNewestFirst\s*}\s*from\s*"\.\/list-order"/,
    "app/api/tax-invoice/route.ts: the list comparator must be imported from ./list-order"
  );
  // WHY THE INLINE COMPARATOR IS GONE. This block used to check that both sides of
  // each key (`left.issue_date`, `right.issue_date`, …) appeared inside the arrow
  // body — an improvement over `includes(key)`, which one-sided neutering walked
  // through, but still only a claim about which TOKENS are present. A review
  // flipped the comparison direction, kept every token, and the full suite stayed
  // green. Presence is not computation, and no amount of text matching gets there:
  // a comparator has to be RUN. So it moved to ./list-order.ts and the order is
  // asserted against fixtures in list-order.test.mts — direction, key precedence,
  // and the id tiebreaker. This pin now guards only the thing text CAN prove: that
  // the route calls the fixture-tested comparator on the array that becomes the
  // response.
}

// ── 3. The pager's own guards must still be present ──────────────────────────
{
  const helper = read("lib/complete-fetch.ts");
  // EVERY assertion in this block reads STRIPPED source. A review finding, and it
  // is this file's own earlier lesson landing on this file: the SCOPE OF THE GUARANTEE
  // docstring necessarily NAMES the guards it explains, so a pin on raw text is
  // satisfied by the prose that describes the guard. Measured: deleting the final wall
  // outright left this file GREEN 1/1 — the comment fed the pin, and only the
  // behavioural bench noticed. Same defect I fixed in the site counter earlier, in the
  // pins added later.
  const helperCode = stripComments(helper);
  assert.match(helperCode, /count === null \|\| count === undefined/, "missing count must be detected");
  assert.match(
    helperCode,
    /rows\.length < expected/,
    "the completeness comparison must exist and be DOWNWARD (missing rows throw; an ahead-insert " +
      "served mid-scan is allowed)"
  );
  // Termination must not consult the count: a remainder count in the break condition
  // ended the walk early and never requested the last page (TOTAL=2500).
  assert.ok(
    !/rows\.length >= expected/.test(helperCode),
    "the loop must terminate on a short/empty page, never on the count — a remainder in the " +
      "break condition ends the walk before the last page"
  );
  assert.match(
    stripComments(helper),
    /if \(page\.length < pageSize\) break;/,
    "a short page is the end-of-walk signal"
  );
  assert.match(
    stripComments(helper),
    /if \(count < owed\)/,
    "the per-page remainder oracle must be ONE-SIDED — strict equality turns a benign " +
      "ahead-insert into a hard failure (measured; the review withdrew that tax)"
  );
  assert.match(helperCode, /cause: error/, "the raw query error must stay reachable for callers that tolerate one");

  // The keyset invariants, pinned so an "optimisation" back to offset fails here
  // as well as in the behavioural test. Comments are stripped first: the docstring
  // legitimately NAMES `.range(from, to)` while explaining why it was removed, and
  // matching that would fail on the explanation instead of on the code.
  assert.match(helperCode, /\.gt\(cursorColumn, cursor\)/, "paging must advance by identity, not position");
  assert.ok(
    !/\.range\(/.test(helperCode),
    "offset paging is the defect found in review — it must not return"
  );
  assert.match(helperCode, /advanced\(cursor, first\)/, "each page must be proven to start after the previous one");

  // The total must be pinned from the FIRST uncursored page only. `count: 'exact'`
  // is FILTER-SCOPED and `.gt(cursorColumn, cursor)` rides in the same query, so
  // every later page reports the REMAINDER. Re-pinning `expected` per page made the
  // final comparison read "loaded 1519 of 519" and throw on every multi-page read —
  // It was measured against real PostgREST, and the bench could not see it because
  // its fake counted the whole table. Behavioural proof is complete-fetch.test.mts
  // §12; this is the source-level pin a "simplify" pass has to walk past first.
  assert.match(
    helperCode,
    /if \(cursor === null\) \{[\s\S]{0,600}?expected = count;/,
    "the expected total must be pinned inside the `cursor === null` branch — an unconditional " +
      "`expected = count` reads the last page's remainder as the total"
  );
  assert.match(
    helperCode,
    /expected - rows\.length/,
    "each later page must certify its own remainder against what is still owed (" +
      "per-page oracle, asymmetric: loss throws, growth re-baselines) — pinning page 1 alone " +
      "defers every divergence to the final comparison"
  );
}

// ── 4. No swept file may carry the lying limit, in ANY query shape ───────────
for (const rel of SWEPT_FILES) {
  // Source [3] of 3, and this one is a hole in the OPPOSITE direction (found in review): the
  // sweep rejects the literal `.limit(5000)`, so the first author who writes a comment
  // explaining WHY that limit was removed turns this RED on prose. Latent today — no
  // swept file carries such a comment yet — which makes it a trap laid for the next
  // author rather than a live failure. Masking closes both directions at once.
  const source = stripComments(read(rel));
  // assert.ok, not assert.doesNotMatch: a failing doesNotMatch dumps the whole
  // source file into the output and buries the message.
  assert.ok(
    !source.includes(".limit(5000)"),
    `${rel}: a read still carries .limit(5000) — PostgREST caps every response at 1000, so the ` +
      `limit is a lie. This check is shape-independent on purpose: the previous version keyed on ` +
      `a neighbouring column name and a review slipped a reverted query past it.`
  );
}
