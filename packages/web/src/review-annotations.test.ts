import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewSessionAnnotation } from "@better-review/shared";

import { annotationInlineCommentId, appendAnnotationReply } from "./review-annotations";

test("adds an inline reply to the review annotations shown in the side panel", () => {
  const root: ReviewSessionAnnotation = {
    id: "root-annotation",
    quote: "src/example.ts:12",
    comment: "Handle this case",
    createdAt: 1,
    kind: "selection",
    filePath: "src/example.ts",
    line: 12,
    side: "RIGHT",
  };

  const result = appendAnnotationReply(
    [root],
    annotationInlineCommentId(root.id),
    "  I agree  ",
    () => "reply-annotation",
    2,
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result[1], {
    ...root,
    id: "reply-annotation",
    comment: "I agree",
    createdAt: 2,
    inReplyToId: root.id,
  });
});
