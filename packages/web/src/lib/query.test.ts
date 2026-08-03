import assert from "node:assert/strict";
import test from "node:test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { getFileRevision } from "./file-revision";

const file: FileDiffMetadata = {
  name: "src/example.ts",
  type: "change",
  hunks: [],
  splitLineCount: 1,
  unifiedLineCount: 1,
  isPartial: true,
  additionLines: ["const value = 1;"],
  deletionLines: ["const value = 0;"],
};

test("getFileRevision changes when a reviewed patch changes", () => {
  assert.notEqual(
    getFileRevision(file),
    getFileRevision({ ...file, additionLines: ["const value = 2;"] }),
  );
});
