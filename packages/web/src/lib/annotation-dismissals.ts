import type { Annotation } from "../utils/parseReviewTokens";

/** Exact content identity, independent of parser IDs, message positions and replay order.
 * Storage is PR-scoped; provenance keeps a dismissal local to its source session/revision.
 */
export function annotationDismissalKey(annotation: Annotation): string {
  return JSON.stringify([
    annotation.origin?.sessionId ?? null,
    annotation.origin?.revision ?? null,
    annotation.file,
    annotation.line,
    annotation.severity,
    annotation.message,
  ]);
}

export function reconcileAnnotationDismissals(
  annotations: Annotation[],
  dismissed: readonly string[],
): Annotation[] {
  const keys = new Set(dismissed);
  return annotations.filter((annotation) => !keys.has(annotationDismissalKey(annotation)));
}
