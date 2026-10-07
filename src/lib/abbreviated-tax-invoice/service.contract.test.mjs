import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./service.ts", import.meta.url), "utf8");
const nightAllocationSource = fs.readFileSync(new URL("./night-allocation.ts", import.meta.url), "utf8");

// Comments are stripped before any negative assertion below. The fix that removed
// offset paging from loadNights DOCUMENTS the old form in prose (it names
// `.order("stay_date")` to explain why a non-unique sort key was not safe), so an
// unstripped `doesNotMatch` would go RED on the very code it is meant to bless —
// the false-RED direction of the same masking hazard that lets prose satisfy a
// positive pin.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const code = stripComments(source);

// No `?? ""` fallback: an empty block makes every doesNotMatch below pass
// vacuously, so the guard would survive this function being renamed or deleted.
const loadNightsBlock = code.match(/async function loadNights[\s\S]*?async function loadFolioRows/)?.[0];
assert.ok(loadNightsBlock, "loadNights block anchor missing — this test no longer knows what it guards");
assert.match(loadNightsBlock, /cancelled_at/);
assert.doesNotMatch(loadNightsBlock, /\.is\("cancelled_at", null\)/);

// The nights read feeds the month's tax exactly as the audit-entry read does, so
// it pages with the same completeness oracle. It used to page by OFFSET under
// `.order("stay_date")` — but stay_date is NOT unique on reservation_nights (the
// only unique indexes are the (room, day) composites), so that is not a total
// order: rows tying on a stay_date could reshuffle between pages and duplicate or
// skip. What is being kept out is offset paging, not "paging without an order".
assert.match(loadNightsBlock, /fetchAllRowsComplete/, "invoice nights must be paged completely");
assert.match(loadNightsBlock, /count:\s*["']exact["']/, "invoice nights need a completeness oracle");
assert.doesNotMatch(loadNightsBlock, /\.range\(/, "offset paging is back on the invoice nights read");
assert.doesNotMatch(
  loadNightsBlock,
  /\.order\(\s*["']stay_date["']/,
  "a non-unique sort key cannot make offset paging safe — do not reintroduce it as if it could"
);
assert.doesNotMatch(code, /RESERVATION_NIGHT_PAGE_SIZE/, "the offset pager's page-size constant is back");

assert.match(source, /refund_total:\s*number;/);
// The pinned intent is the COLUMN LIST (refund_total/outstanding must stay
// selected), not the call's punctuation. The trailing `)` was dropped from this
// pattern when loadAuditEntries gained a `{ count: "exact" }` second argument
// for the 1000-row cap fix; the column list itself is still frozen verbatim.
assert.match(
  source,
  /\.select\(\s*"id, period_id, reservation_id, source, guest_name, checkin_date, checkout_date, room_revenue, extra_revenue, total_revenue, refund_total, outstanding"/
);

// Strengthened alongside: the audit-entry read feeds the month's tax, so it must
// page with a completeness oracle rather than trusting one capped response.
const loadAuditEntriesBlock =
  source.match(/async function loadAuditEntries[\s\S]*?\n}/)?.[0] ?? "";
assert.match(loadAuditEntriesBlock, /fetchAllRowsComplete/, "audit entries must be paged");
assert.match(loadAuditEntriesBlock, /count:\s*["']exact["']/, "audit entries need a completeness oracle");
assert.doesNotMatch(loadAuditEntriesBlock, /\.limit\(5000\)/, "the 5000 limit is a lie; PostgREST caps at 1000");

assert.match(nightAllocationSource, /function completeChargedReservationNightsFromAuditTotal/);
assert.match(nightAllocationSource, /refundTotal > 0/);
assert.match(nightAllocationSource, /candidateTotal/);
assert.match(nightAllocationSource, /Math\.abs\(candidateTotal - residualTotal\) > 0\.01/);
assert.match(nightAllocationSource, /function applyCoveredRoomRevenueToNights/);
assert.match(nightAllocationSource, /function computeInvoiceableRoomTotal/);
assert.match(nightAllocationSource, /function allocateRoomAndExtraAcrossNights/);
assert.match(source, /covered_room_revenue_by_stay_date/);
assert.match(source, /applyCoveredRoomRevenueToNights/);
assert.match(source, /allocateRoomAndExtraAcrossNights/);
assert.match(source, /planAbbreviatedInvoiceRenumbering/);
assert.match(source, /rpc\("renumber_abbreviated_invoices"/);

const generateBlock = source.match(/export async function generateAbbreviatedInvoices[\s\S]*?export async function recalculateAbbreviated/)?.[0] ?? "";
const generateRenumberIndex = generateBlock.indexOf("preparePersistedAbbreviatedInvoiceNumbers");
const generateRefreshIndex = generateBlock.indexOf("refreshPersistedAbbreviatedInvoice");
assert.ok(generateRenumberIndex > -1, "generate should prepare invoice numbers atomically");
assert.ok(generateRefreshIndex > -1, "generate should still refresh persisted invoices");
assert.ok(generateRenumberIndex < generateRefreshIndex, "generate must renumber before refreshing headers");

const recalculateBlock = source.match(/export async function recalculateAbbreviated[\s\S]*?export async function shiftRow/)?.[0] ?? "";
const recalculateRenumberIndex = recalculateBlock.indexOf("preparePersistedAbbreviatedInvoiceNumbers");
const recalculateRefreshIndex = recalculateBlock.indexOf("refreshPersistedAbbreviatedInvoice");
assert.ok(recalculateRenumberIndex > -1, "recalculate should prepare invoice numbers atomically");
assert.ok(recalculateRefreshIndex > -1, "recalculate should still refresh persisted invoices");
assert.ok(recalculateRenumberIndex < recalculateRefreshIndex, "recalculate must renumber before refreshing headers");

const buildRoomPreviewBlock = source.match(/async function buildRoomPreview[\s\S]*?const drafts = assignSequentialInvoiceNumbers/)?.[0] ?? "";
const completeIndex = buildRoomPreviewBlock.indexOf("const completedNights = completeChargedReservationNightsFromAuditTotal");
const includedIndex = buildRoomPreviewBlock.indexOf("const includedNights = nights.filter");
assert.ok(completeIndex > -1, "buildRoomPreview should complete charged nights from audit totals");
assert.ok(includedIndex > -1, "buildRoomPreview should still filter included nights");
assert.ok(completeIndex < includedIndex, "charged cancelled nights must be restored before include/carry filtering");
