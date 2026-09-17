import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatAnnotationForClipboard,
  formatAnnotationForComment,
} from "./formatAnnotationForClipboard";

test("includes the full file reference when copying an AI annotation", () => {
  assert.equal(
    formatAnnotationForClipboard({
      id: "annotation-1",
      file: "packages/web/src/ChatPanel.tsx",
      line: 509,
      severity: "warning",
      message: "Keep the clipboard output actionable.",
    }),
    "packages/web/src/ChatPanel.tsx:509\nKeep the clipboard output actionable.",
  );
});

test("includes the full file reference when prefilling an AI annotation comment", () => {
  assert.equal(
    formatAnnotationForComment({
      id: "annotation-1",
      file: "packages/web/src/ChatPanel.tsx",
      line: 509,
      severity: "warning",
      message: "Keep the comment actionable.",
    }),
    "packages/web/src/ChatPanel.tsx:509\n[AI][warning]: Keep the comment actionable.",
  );
});
