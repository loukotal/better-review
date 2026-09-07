import assert from "node:assert/strict";
import test from "node:test";

import type { StreamingMessage } from "../hooks/useStreamingChat";
import {
  groupTranscript,
  reviewRequestLabel,
  currentActivity,
  thinkingTail,
} from "./chat-transcript";
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

test("live activity survives model steps, updates tools, and stops at the latest request", () => {
  const tool = { id: "1", callId: "1", tool: "read", status: "running" as const, input: {} };
  const previous = {
    ...message("a1", "assistant", ""),
    reasoning: "Old thinking",
    toolCalls: [tool],
  };
  const current = {
    ...message("a2", "assistant", ""),
    reasoning: "Inspecting code",
    toolCalls: [{ ...tool, callId: "2" }],
  };
  const messages = [previous, message("u", "user", "Review again"), current];
  const activity = currentActivity(messages, [{ ...tool, callId: "2", status: "completed" }], "");
  assert.deepEqual(
    activity.tools.map((t) => [t.callId, t.status]),
    [["2", "completed"]],
  );
  assert.equal(activity.reasoning, "Inspecting code");
  assert.equal(currentActivity(messages, [], "New thinking").reasoning, "New thinking");
  assert.deepEqual(currentActivity([...messages, message("u2", "user", "Next")], [], ""), {
    tools: [],
    reasoning: "",
  });
});

test("thinking preview follows the latest text and stays bounded", () => {
  assert.equal(thinkingTail(" Short thought "), "Short thought");
  const preview = thinkingTail(
    "Opening thought. " + "Investigating code. ".repeat(40) + "Found the cause.",
  );
  assert.ok(preview.startsWith("…"));
  assert.ok(preview.endsWith("Found the cause."));
  assert.ok(preview.length <= 361);
  assert.ok(!preview.includes("Opening thought"));
});
