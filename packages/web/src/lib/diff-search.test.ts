import assert from "node:assert/strict";
import test from "node:test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { searchDiffFiles } from "./diff-search";

const file: FileDiffMetadata = {
  name: "src/example.ts",
  type: "change",
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 10,
      additionCount: 3,
      additionLines: 1,
      additionLineIndex: 0,
      deletionStart: 10,
      deletionCount: 3,
      deletionLines: 1,
      deletionLineIndex: 0,
      hunkContent: [],
      splitLineStart: 0,
      splitLineCount: 3,
      unifiedLineStart: 0,
      unifiedLineCount: 3,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
  splitLineCount: 3,
  unifiedLineCount: 3,
  isPartial: true,
  additionLines: ["const visible = true;", "unchanged", "after"],
  deletionLines: ["const previous = true;", "unchanged", "after"],
};

test("searchDiffFiles returns matching lines with their displayed line numbers", () => {
  assert.deepEqual(searchDiffFiles([file], "visible"), [
    {
      fileName: "src/example.ts",
      line: 10,
      side: "RIGHT",
      preview: "const visible = true;",
    },
  ]);
});

test("searchDiffFiles searches removed lines", () => {
  assert.deepEqual(searchDiffFiles([file], "previous"), [
    {
      fileName: "src/example.ts",
      line: 10,
      side: "LEFT",
      preview: "const previous = true;",
    },
  ]);
});

test("searchDiffFiles maps later hunk lines", () => {
  assert.deepEqual(searchDiffFiles([file], "after"), [
    {
      fileName: "src/example.ts",
      line: 12,
      side: "RIGHT",
      preview: "after",
    },
    {
      fileName: "src/example.ts",
      line: 12,
      side: "LEFT",
      preview: "after",
    },
  ]);
});

test("searchDiffFiles includes matching file paths", () => {
  assert.deepEqual(searchDiffFiles([file], "example"), [
    {
      fileName: "src/example.ts",
      preview: "src/example.ts",
    },
  ]);
});
