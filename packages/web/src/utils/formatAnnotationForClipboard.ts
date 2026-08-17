import type { Annotation } from "./parseReviewTokens";

export function formatAnnotationForClipboard(annotation: Annotation): string {
  return `${annotation.file}:${annotation.line}\n${annotation.message}`;
}
