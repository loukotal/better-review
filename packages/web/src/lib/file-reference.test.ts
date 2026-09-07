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

test("unchanged source references survive resolution without basename misrouting", () => {
  for (const path of ["src/unchanged.ts", "README.md", "Makefile", "other/App.tsx"]) {
    assert.equal(resolveFileReference(path, files), path);
  }
  assert.equal(resolveFileReference("./App.tsx", files), "App.tsx");
});

test("unsafe unknown references never reach source lookup", () => {
  for (const path of [
    "/tmp/secret",
    "C:\\secret.txt",
    "../secret",
    "src/../secret",
    "https://example.com/a",
    "src/\u0000bad",
  ]) {
    assert.equal(resolveFileReference(path, files), null);
  }
});
