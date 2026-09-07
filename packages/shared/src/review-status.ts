import {
  STRUCTURED_REVIEW_PROMPT,
  ADVERSARIAL_REVIEW_PROMPT,
  buildReviewPrompt,
} from "./review-prompts";

export type AutomaticReviewState = "none" | "starting" | "running" | "completed" | "failed";
export interface AutomaticReviewStatus {
  state: AutomaticReviewState;
  sessionId?: string;
  error?: string;
}
export interface ReviewConversation {
  messages: Array<{
    role: string;
    submissionId?: string;
    parts: Array<{ type: string; text?: string }>;
  }>;
  settlements: Array<{ submissionId: string; outcome: "completed" | "failed" | "aborted" }>;
}

export function isReviewRequest(text: string): boolean {
  return [STRUCTURED_REVIEW_PROMPT, ADVERSARIAL_REVIEW_PROMPT].some(
    (prompt) => text === prompt || text === buildReviewPrompt(prompt, true),
  );
}

/** Flue settlements, rather than the last token, decide whether work finished. */
export function reviewConversationStatus(
  conversation: ReviewConversation | null,
  submissionId?: string,
): AutomaticReviewStatus["state"] {
  if (conversation && conversationIsRunning(conversation)) return "running";
  if (submissionId) {
    const settlement = conversation?.settlements.find((s) => s.submissionId === submissionId);
    if (settlement) return settlement.outcome === "completed" ? "completed" : "failed";
    return "running";
  }
  if (!conversation) return "none";
  const request = conversation.messages.findLast(
    (m) =>
      m.role === "user" &&
      isReviewRequest(
        m.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(""),
      ),
  );
  if (!request) return "none";
  if (request.submissionId) return reviewConversationStatus(conversation, request.submissionId);
  return conversation.messages
    .slice(conversation.messages.indexOf(request) + 1)
    .some((m) => m.role === "assistant")
    ? "completed"
    : "running";
}

export function conversationIsRunning(conversation: ReviewConversation): boolean {
  return conversation.messages.some(
    (m) =>
      m.submissionId && !conversation.settlements.some((s) => s.submissionId === m.submissionId),
  );
}
