import { rewriteReviewTokens } from "./parseReviewTokens";

export function buildFeedbackText(
  messages: Array<{ role: string; content: string }>,
  activeAnnotationIds: Set<string>,
): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content.trim()) continue;
    let text = rewriteReviewTokens(msg.content, {
      reviewOrder: () => "",
      annotation(annotation, originalSeverity) {
        if (!activeAnnotationIds.has(annotation.id)) return "";
        return `[${originalSeverity.toUpperCase()}] ${annotation.file}:${annotation.line} - ${annotation.message}`;
      },
      fileRef: (file, originalLine) => (originalLine ? `${file}:${originalLine}` : file),
    });
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n---\n\n");
}
