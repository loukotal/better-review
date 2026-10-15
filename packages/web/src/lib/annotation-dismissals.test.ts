import assert from "node:assert/strict";
import test from "node:test";

import type { Annotation } from "../utils/parseReviewTokens";
import { annotationDismissalKey, reconcileAnnotationDismissals } from "./annotation-dismissals";

const finding: Annotation = {
  id: "parser-id",
  file: "src/a.ts",
  line: 12,
  severity: "warning",
  message: "Check this",
  origin: { sessionId: "one", revision: "head-A" },
};

test("identical replay stays dismissed regardless of parser ID/order; empty results do not resurrect stale findings", () => {
  const dismissed = [annotationDismissalKey(finding)];
  assert.deepEqual(
    reconcileAnnotationDismissals([{ ...finding, id: "different-parser-id" }], dismissed),
    [],
  );
  assert.deepEqual(reconcileAnnotationDismissals([], dismissed), []);
  assert.deepEqual(
    reconcileAnnotationDismissals([finding], JSON.parse(JSON.stringify(dismissed))),
    [],
  );
});

test("dismissals distinguish source session/revision and exact path/line/body/severity, not indices or hash IDs", () => {
  const dismissed = [annotationDismissalKey(finding)];
  for (const variant of [
    { ...finding, origin: { ...finding.origin!, sessionId: "two" } },
    { ...finding, origin: { ...finding.origin!, revision: "head-B" } },
    { ...finding, file: "other/a.ts" },
    { ...finding, line: 13 },
    { ...finding, severity: "critical" as const },
    { ...finding, message: "Revised finding" },
    { ...finding, origin: undefined },
  ])
    assert.deepEqual(reconcileAnnotationDismissals([variant, finding], dismissed), [variant]);
});
