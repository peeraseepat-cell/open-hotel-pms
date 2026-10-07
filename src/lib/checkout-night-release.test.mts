import assert from "node:assert/strict";
import { resolveCheckoutReleaseStartDate } from "./checkout-night-release.ts";

assert.equal(
  resolveCheckoutReleaseStartDate("2026-06-28", "2026-06-28"),
  "2026-06-29",
  "checkout before night audit closes must preserve the consumed business-date night"
);

assert.equal(
  resolveCheckoutReleaseStartDate("2026-06-28", "2026-06-27"),
  "2026-06-28",
  "normal early checkout must release nights after the prior consumed night"
);

assert.equal(
  resolveCheckoutReleaseStartDate("2026-06-28", null),
  "2026-06-28",
  "missing occupied-night context must retain the business-date fallback"
);
