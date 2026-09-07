import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePatchFiles } from "@pierre/diffs";

import { parseReviewTokens } from "../utils/parseReviewTokens";
import { navigateAnnotation } from "./annotation-navigation";
import { resolveFileReference } from "./file-reference";

const files = parsePatchFiles(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,3 @@
 before
-old
+new
 after
`).flatMap((patch) => patch.files);

test("annotation navigation uses visible head lines only at the same revision", () => {
  for (const [path, line, sameRevision, expected] of [
    ["src/example.ts", 11, true, "diff"],
    ["src/example.ts", 10, true, "diff"],
    ["src/example.ts", 12, true, "diff"],
    ["src/example.ts", 2, true, "source"],
    ["src/unchanged.ts", 2, true, "source"],
    ["README.md", undefined, true, "source"],
    ["src/example.ts", 11, false, "source"],
    ["src/example.ts", 0, true, "source"],
    ["src/example.ts", 1.5, true, "source"],
  ] as const) {
    const calls: unknown[] = [];
    navigateAnnotation({ path, line, sessionId: "review-old" }, files, sameRevision, {
      diff: (path, line) => calls.push(["diff", path, line]),
      source: (target) => calls.push(["source", target.path, target.line, target.sessionId]),
    });
    assert.deepEqual(calls, [
      expected === "diff" ? ["diff", path, line] : ["source", path, line, "review-old"],
    ]);
  }
});

test("unchanged annotation fixture reaches source with its originating session", () => {
  const { annotations } = parseReviewTokens(
    '<<ANNOTATION file="src/unchanged.ts" line="42" severity="info">>Inspect the caller<</ANNOTATION>>',
  );
  const annotation = annotations[0];
  const path = resolveFileReference(
    annotation.file,
    files.map((file) => file.name),
  );
  assert.equal(path, "src/unchanged.ts");
  const target = { path: path!, line: annotation.line, sessionId: "saved-review" };
  const calls: unknown[] = [];
  navigateAnnotation(target, files, true, {
    diff: () => assert.fail("Unchanged source must not navigate the diff"),
    source: (value) => calls.push(value),
  });
  assert.deepEqual(calls, [target]);
});
