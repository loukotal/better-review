import type { Annotation } from "./parseReviewTokens";

export function formatAnnotationFileReference(annotation: Annotation): string {
  return `${annotation.file}:${annotation.line}`;
}

export function formatAnnotationForClipboard(annotation: Annotation): string {
  return `${formatAnnotationFileReference(annotation)}\n${annotation.message}`;
}

export function formatAnnotationForComment(annotation: Annotation): string {
  return `${formatAnnotationFileReference(annotation)}\n[AI][${annotation.severity}]: ${annotation.message}`;
}
