import assert from "node:assert/strict";
import { fromSatang, toSatang } from "./money";

assert.equal(toSatang(8.70), 870);
assert.equal(toSatang("8.70"), 870);

for (const satang of [29, 129, 12345]) {
  assert.equal(toSatang(fromSatang(satang)), satang);
}

assert.equal(toSatang(2340.70), 234070);
assert.equal(toSatang(0), 0);
assert.equal(toSatang(-8.70), -870);
