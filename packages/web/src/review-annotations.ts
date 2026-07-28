import type { ReviewSessionAnnotation } from "@better-review/shared";

export function annotationInlineCommentId(annotationId: string): number {
  let hash = 0;
  for (let i = 0; i < annotationId.length; i += 1) {
    hash = (hash << 5) - hash + annotationId.charCodeAt(i);
    hash |= 0;
  }
  return -Math.abs(hash || 1);
}

export function appendAnnotationReply(
  annotations: ReviewSessionAnnotation[],
  commentId: number,
  body: string,
  createId: (quote: string, comment: string) => string,
  createdAt = Date.now(),
): ReviewSessionAnnotation[] {
  const root = annotations.find(
    (annotation) =>
      !annotation.inReplyToId && annotationInlineCommentId(annotation.id) === commentId,
  );
  const comment = body.trim();
  if (!root || !comment) return annotations;

  return [
    ...annotations,
    {
      ...root,
      id: createId(root.quote, comment),
      comment,
      createdAt,
      inReplyToId: root.id,
    },
  ];
}
