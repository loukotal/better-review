import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isFlueV2ReviewSession } from "../../flue-review-sessions";

test("projects persisted Flue conversation history into chat messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "better-review-flue-test-"));
  process.env.BETTER_REVIEW_FLUE_DB_PATH = path.join(directory, "flue.sqlite");
  const { conversationHistoryToChatMessages } = await import("./flue-review");

  const messages = conversationHistoryToChatMessages({
    v: 1,
    conversationId: "conversation-1",
    offset: "offset-1",
    settlements: [],
    messages: [
      {
        id: "user-1",
        role: "user",
        metadata: { timestamp: "2026-07-13T12:00:00.000Z" },
        parts: [{ type: "text", text: "Review this PR", state: "done" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { timestamp: "2026-07-13T12:00:01.000Z" },
        parts: [
          { type: "reasoning", text: "Inspecting", state: "done" },
          { type: "text", text: "Found one issue", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "read",
            toolCallId: "tool-1",
            state: "output-available",
            input: { path: "src/index.ts" },
            output: { lines: 10 },
          },
        ],
      },
    ],
  });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    id: "user-1",
    role: "user",
    content: "Review this PR",
    reasoning: undefined,
    toolCalls: [],
    isStreaming: false,
    timestamp: Date.parse("2026-07-13T12:00:00.000Z"),
  });
  assert.equal(messages[1]?.content, "Found one issue");
  assert.equal(messages[1]?.reasoning, "Inspecting");
  assert.deepEqual(messages[1]?.toolCalls[0], {
    id: "tool-1",
    callId: "tool-1",
    tool: "read",
    status: "completed",
    input: { path: "src/index.ts" },
    title: "read",
    output: '{\n  "lines": 10\n}',
  });
});

test("only versioned Flue 2 review sessions remain selectable", () => {
  assert.equal(isFlueV2ReviewSession(undefined), false);
  assert.equal(isFlueV2ReviewSession({ runtimeVersion: 1 } as never), false);
  assert.equal(isFlueV2ReviewSession({ runtimeVersion: 2 } as never), true);
});
