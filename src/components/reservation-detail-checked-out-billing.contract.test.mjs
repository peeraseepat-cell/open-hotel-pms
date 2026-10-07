import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./reservation-detail-page.tsx", import.meta.url), "utf8");

assert.match(
  source,
  /mode === "checkout" \|\| dayUseAmountOnlyMode \|\| isCheckedOutReservation\s*\? totalPrice\s*:\s*fromSatang\(computedTotalSatang\)/,
  "checked-out edit folios should use persisted reservation charges when active nights are unavailable"
);
