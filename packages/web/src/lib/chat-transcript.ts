import type { StreamingMessage, ToolCall } from "../hooks/useStreamingChat";
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

/** Keep progress across model steps, but never carry it across user requests. */
export function currentActivity(
  messages: StreamingMessage[],
  activeTools: ToolCall[],
  reasoning: string,
) {
  const boundary = messages.findLastIndex((message) => message.role === "user");
  const assistants = messages.slice(boundary + 1).filter((message) => message.role === "assistant");
  const tools = new Map<string, ToolCall>();
  for (const tool of [...assistants.flatMap((message) => message.toolCalls), ...activeTools]) {
    tools.set(tool.callId, tool);
  }
  return {
    tools: [...tools.values()],
    reasoning: reasoning.trim()
      ? reasoning
      : (assistants.findLast((message) => message.reasoning?.trim())?.reasoning ?? ""),
  };
}

/** A bounded tail follows new thinking instead of freezing on its opening lines. */
export function thinkingTail(content: string, limit = 360): string {
  const text = content.trim();
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  const boundary = tail.search(/\s/);
  return `…${boundary >= 0 ? tail.slice(boundary) : tail}`;
}
