import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const { deriveBookingGroupStatus } = require("./booking-group-status") as typeof import("./booking-group-status");

assert.equal(deriveBookingGroupStatus("active", ["checked_out", "active"]), "active");
assert.equal(deriveBookingGroupStatus("cancelled", ["active"]), "cancelled");
assert.equal(deriveBookingGroupStatus("active", ["checked_out", "checked_out"]), "completed");
assert.equal(deriveBookingGroupStatus("active", ["checked_out", "no_show"]), "completed");
assert.equal(deriveBookingGroupStatus("active", ["no_show", "no_show"]), "active");
assert.equal(deriveBookingGroupStatus("cancelled_by_guest", ["cancelled", "cancelled"]), "active");
assert.equal(deriveBookingGroupStatus("draft_checkin", ["draft_checkin"]), "active");
assert.equal(deriveBookingGroupStatus("active", []), "active");
