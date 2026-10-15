import assert from "node:assert/strict";
import test from "node:test";

import { parsePatchFiles } from "@pierre/diffs";

import { prepareFindingComment } from "./finding-comment";

const files = parsePatchFiles(
  "diff --git a/src/user-rent.ts b/src/user-rent.ts\n--- a/src/user-rent.ts\n+++ b/src/user-rent.ts\n@@ -455,3 +455,3 @@\n before\n-old\n+new\n after\n",
).flatMap((patch) => patch.files);
const annotation = {
  id: "finding",
  file: "user-rent.ts",
  line: 457,
  severity: "critical" as const,
  message: "Inspect this exact code",
};
const context = {
  prUrl: "https://github.com/o/r/pull/1",
  sessionId: "saved",
  scope: "revision1",
  reviewedRef: "a".repeat(40),
  displayedHeadSha: "a".repeat(40),
  files,
};
test("finding prefill resolves basename to full path and preserves exact body/line/right source revision", () => {
  const { request, inPatch } = prepareFindingComment(annotation, context);
  assert.equal(inPatch, true);
  assert.equal(request.filePath, "src/user-rent.ts");
  assert.equal(request.line, 457);
  assert.equal(request.side, "RIGHT");
  assert.equal(request.body, "src/user-rent.ts:457\n[AI][critical]: Inspect this exact code");
  assert.equal(request.expectedHeadSha, context.displayedHeadSha);
});
test("unchanged line and unchanged file select pinned inline-source loading rather than guessing a diff row", () => {
  assert.equal(prepareFindingComment({ ...annotation, line: 161 }, context).inPatch, false);
  assert.equal(
    prepareFindingComment({ ...annotation, file: "src/other.ts", line: 161 }, context).inPatch,
    false,
  );
});
test("historical, unknown, unsafe, ambiguous and invalid finding targets cannot create current-line drafts", () => {
  assert.throws(
    () => prepareFindingComment(annotation, { ...context, commitScope: true }),
    /commit scope/,
  );
  assert.throws(
    () =>
      prepareFindingComment(
        { ...annotation, origin: { sessionId: context.sessionId, revision: "b".repeat(40) } },
        context,
      ),
    /provenance/,
  );
  assert.throws(
    () => prepareFindingComment(annotation, { ...context, reviewedRef: "b".repeat(40) }),
    /historical/,
  );
  assert.throws(
    () => prepareFindingComment(annotation, { ...context, reviewedRef: undefined }),
    /unavailable/,
  );
  assert.throws(
    () => prepareFindingComment({ ...annotation, file: "../user-rent.ts" }, context),
    /unsafe/,
  );
  assert.throws(
    () =>
      prepareFindingComment(annotation, {
        ...context,
        files: [...files, { ...files[0], name: "test/user-rent.ts" }],
      }),
    /ambiguous/,
  );
  assert.throws(
    () => prepareFindingComment({ ...annotation, line: 0 }, context),
    /valid source line/,
  );
});
