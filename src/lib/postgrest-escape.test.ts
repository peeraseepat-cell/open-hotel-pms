import assert from "node:assert/strict";
import { buildQuotedIlikeOrFilter, escapeOrValue } from "./postgrest-escape";

assert.equal(escapeOrValue("50%"), "50\\\\%");
assert.equal(escapeOrValue("TOWEL_LG"), "TOWEL\\\\_LG");
assert.equal(escapeOrValue("a,name.ilike.*"), "a,name.ilike.*");
assert.equal(escapeOrValue("a)or(b"), "a)or(b");

assert.equal(
  buildQuotedIlikeOrFilter(["name", "sku"], "a,name.ilike.*"),
  'name.ilike."%a,name.ilike.*%",sku.ilike."%a,name.ilike.*%"'
);
assert.equal(
  buildQuotedIlikeOrFilter(["name", "sku"], "TOWEL_LG"),
  'name.ilike."%TOWEL\\\\_LG%",sku.ilike."%TOWEL\\\\_LG%"'
);
