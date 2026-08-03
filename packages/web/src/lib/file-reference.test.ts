import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveFileReference } from "./file-reference";

const files = ["packages/web/src/App.tsx", "packages/api/src/index.ts"];

test("resolves normalized and absolute AI file references", () => {
  assert.equal(resolveFileReference("./packages/web/src/App.tsx", files), files[0]);
  assert.equal(resolveFileReference("/checkout/packages/web/src/App.tsx", files), files[0]);
  assert.equal(resolveFileReference("App.tsx", files), files[0]);
});

test("does not guess an ambiguous basename", () => {
  assert.equal(resolveFileReference("index.ts", [...files, "packages/web/src/index.ts"]), null);
});
