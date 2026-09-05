import assert from "node:assert/strict";
import test from "node:test";

import type { StreamingMessage } from "../hooks/useStreamingChat";
import { groupTranscript, reviewRequestLabel } from "./chat-transcript";
import {
  STRUCTURED_REVIEW_PROMPT,
  ADVERSARIAL_REVIEW_PROMPT,
  buildReviewPrompt,
} from "./review-prompts";

const message = (
  id: string,
  role: StreamingMessage["role"],
  content: string,
): StreamingMessage => ({ id, role, content, toolCalls: [], timestamp: 0, isStreaming: false });

test("abbreviates only exact generated prompts, retaining custom instructions", () => {
  assert.equal(reviewRequestLabel(STRUCTURED_REVIEW_PROMPT), "Review this PR");
  assert.equal(
    reviewRequestLabel(buildReviewPrompt(ADVERSARIAL_REVIEW_PROMPT, true)),
    "Adversarial review · Simplified English",
  );
  assert.equal(reviewRequestLabel(STRUCTURED_REVIEW_PROMPT + " Also check authorization."), null);
});

test("groups assistant steps without crossing user turns or mutating history", () => {
  const messages = [
    message("u1", "user", "Review"),
    message("a1", "assistant", "First"),
    message("a2", "assistant", "Second"),
    message("empty", "assistant", ""),
    message("u2", "user", "Explain"),
    message("a3", "assistant", "Answer"),
  ];
  const groups = groupTranscript(messages);
  assert.deepEqual(
    groups.map((g) => g.messages.map((m) => m.id)),
    [["u1"], ["a1", "a2"], ["u2"], ["a3"]],
  );
  assert.equal(messages.length, 6);
});

test("retains reasoning-only and tool-only messages", () => {
  const reasoning = { ...message("r", "assistant", ""), reasoning: "Inspecting" };
  const tool: StreamingMessage = {
    ...message("t", "assistant", ""),
    toolCalls: [
      {
        id: "read",
        callId: "read",
        tool: "read",
        status: "error",
        input: { path: "file.ts" },
        error: "Not found",
      },
    ],
  };
  assert.deepEqual(groupTranscript([reasoning, tool])[0]?.messages, [reasoning, tool]);
});
