import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

// Prose must not be able to satisfy any pin below. Every guard here reads `code`,
// never `route` — a comment quoting the old pager verbatim is exactly how a
// source-assertion suite goes green over a reverted fix.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const code = stripComments(route);

// Each read's window ends where the NEXT read begins — never a fixed character
// count. A fixed window silently overran into the following `.from(...)` chain,
// so a pin looking for a leading `id` in this read matched the NEXT read's
// projection and stayed green while the cursor column was deleted. A bounded
// window that can reach past its subject is a fail-open guard.
function callWindow(src, table) {
  const start = src.indexOf(`.from("${table}")`);
  if (start === -1) throw new Error(`anchor missing — this test no longer knows what it guards: .from("${table}")`);
  const next = src.indexOf(".from(", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

// --- the defect this file exists to keep dead ------------------------------
// The old pager walked `.range(offset, offset + PAGE - 1)` with NO `.order()`.
// Postgres may return rows in any order without an ORDER BY, so once a filtered
// result crossed 1000 rows the pages duplicated and skipped silently — revenue
// came out WRONG, not empty. Offset paging is unsafe here by construction, so the
// guard is that offset paging is GONE, not that it grew an order.
assert.doesNotMatch(code, /\.range\(\s*offset/, "offset paging is back on the revenue reads");
assert.doesNotMatch(code, /REVENUE_REPORT_PAGE_SIZE/, "the old page-size constant is back");
assert.doesNotMatch(code, /async function fetchRevenueRows/, "the hand-rolled pager is back");

// --- what must be there instead --------------------------------------------
// Keyset paging via the shared oracle: pins the total from the first page, walks
// by a unique cursor, throws on a short read.
assert.match(code, /fetchAllRowsComplete/, "the complete-fetch oracle is not imported");

for (const table of ["reservation_nights", "pos_orders"]) {
  const call = callWindow(code, table);
  // The cursor column must ride in the projection. fetchAllRowsComplete pages by
  // `id`, and a row without it throws IncompleteFetchError at runtime — this pin
  // turns that runtime throw into a test-time one.
  //
  // It pins `id` as the FIRST TOP-LEVEL column rather than merely present, because
  // reservation_nights embeds `reservations!inner ( id, ... )`. A bare /\bid\b/ is
  // satisfied by the JOINED row's id while the night's own cursor column stays
  // absent — i.e. the pin would pass on precisely the code it exists to reject.
  assert.match(call, /\.select\(\s*[`"']\s*id\s*,/, `${table}: "id" is not the first projected column (keyset cursor)`);
  // Without an exact count the oracle cannot certify completeness. Its absence is
  // what made the old truncation silent.
  assert.match(call, /count:\s*["']exact["']/, `${table}: select is missing { count: "exact" }`);
}

// All four revenue reads page completely — one un-paged read is enough to truncate
// the report, and the four share a single total.
const completeCalls = code.match(/fetchAllRowsComplete</g) ?? [];
assert.equal(completeCalls.length, 4, `expected all 4 revenue reads to page completely, found ${completeCalls.length}`);
