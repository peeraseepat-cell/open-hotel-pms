import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("changing draft identity remounts the stateful dirty-entry form", () => {
  const text = readFileSync(new URL("../../app/linen-mobile/batch/[id]/page.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let identity: string | undefined;
  const walk = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === "MobileBatchStepDirty") {
      const key = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(file) === "key");
      if (key && ts.isJsxAttribute(key) && key.initializer && ts.isJsxExpression(key.initializer)) identity = key.initializer.expression?.getText(file);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  assert.equal(identity, 'activeDraftKey ?? batchId ?? "new"', "React must discard local quantities when persisted draft identity becomes available");
});
