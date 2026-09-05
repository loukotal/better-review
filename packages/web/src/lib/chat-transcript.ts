import type { StreamingMessage } from "../hooks/useStreamingChat";
import {
  ADVERSARIAL_REVIEW_PROMPT,
  STRUCTURED_REVIEW_PROMPT,
  buildReviewPrompt,
} from "./review-prompts";

/** Only abbreviate exact app-generated requests; custom instructions stay visible. */
export function reviewRequestLabel(content: string): string | null {
  for (const [prompt, label] of [
    [STRUCTURED_REVIEW_PROMPT, "Review this PR"],
    [ADVERSARIAL_REVIEW_PROMPT, "Adversarial review"],
  ] as const) {
    if (content === prompt) return label;
    if (content === buildReviewPrompt(prompt, true)) return `${label} · Simplified English`;
  }
  return null;
}

export function groupTranscript(messages: StreamingMessage[]) {
  const groups: { id: string; role: StreamingMessage["role"]; messages: StreamingMessage[] }[] = [];
  for (const message of messages) {
    if (!message.content.trim() && !message.reasoning?.trim() && !message.toolCalls.length)
      continue;
    const previous = groups.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant")
      previous.messages.push(message);
    else groups.push({ id: message.id, role: message.role, messages: [message] });
  }
  return groups;
}
