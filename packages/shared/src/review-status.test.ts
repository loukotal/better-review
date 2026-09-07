import assert from "node:assert/strict";
import test from "node:test";

import { STRUCTURED_REVIEW_PROMPT } from "./review-prompts";
import {
  conversationIsRunning,
  reviewConversationStatus,
  type ReviewConversation,
} from "./review-status";
const conversation = (): ReviewConversation => ({
  messages: [
    {
      role: "user",
      submissionId: "request",
      parts: [{ type: "text", text: STRUCTURED_REVIEW_PROMPT }],
    },
  ],
  settlements: [],
});

test("an empty session still needs review; admitted work is running before the first token", () => {
  assert.equal(reviewConversationStatus(null), "none");
  assert.equal(reviewConversationStatus({ messages: [], settlements: [] }), "none");
  assert.equal(reviewConversationStatus(null, "admitted"), "running");
  assert.equal(reviewConversationStatus(conversation()), "running");
});
test("tokens do not finish a review: only its settlement does", () => {
  const history = conversation();
  history.messages.push({
    role: "assistant",
    submissionId: "request",
    parts: [{ type: "text", text: "A finding" }],
  });
  assert.equal(reviewConversationStatus(history), "running");
  assert.equal(conversationIsRunning(history), true);
  history.settlements.push({ submissionId: "request", outcome: "completed" });
  assert.equal(reviewConversationStatus(history), "completed");
  assert.equal(conversationIsRunning(history), false);
});
test("failed and stopped reviews can be retried, without mistaking custom chat for a review", () => {
  for (const outcome of ["failed", "aborted"] as const) {
    const history = conversation();
    history.settlements.push({ submissionId: "request", outcome });
    assert.equal(reviewConversationStatus(history), "failed");
  }
  assert.equal(
    reviewConversationStatus({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      settlements: [],
    }),
    "none",
  );
});

test("a newer running request takes precedence over an older completed automatic review", () => {
  const history = conversation();
  history.settlements.push({ submissionId: "request", outcome: "completed" });
  history.messages.push({
    role: "user",
    submissionId: "follow-up",
    parts: [{ type: "text", text: "Check auth too" }],
  });
  assert.equal(reviewConversationStatus(history, "request"), "running");
});
