import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import type { ReviewSnapshot } from "@better-review/shared";

import type { ReviewClient } from "../lib/review-client";
import {
  conversationSnapshotMessages,
  conversationSnapshotState,
  useStreamingChat,
} from "./useStreamingChat";

const empty = (): ReviewSnapshot => ({
  sessionId: "review",
  messages: [],
  settlements: [],
  running: false,
  compacting: false,
});
function mockClient() {
  let snapshot = empty();
  let publish: (value: ReviewSnapshot) => void = () => {};
  const keys: string[] = [];
  let fail = false;
  let aborts = 0;
  const client: ReviewClient = {
    history: async () => snapshot,
    send: async (_body, key) => {
      keys.push(key);
      if (fail) throw new Error("Connection lost");
      return { submissionId: "submission" };
    },
    abort: async () => {
      aborts++;
    },
    compact: async () => {},
    observe: (listener) => {
      publish = listener;
      return () => {
        publish = () => {};
      };
    },
  };
  return {
    client,
    keys,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
    aborts: () => aborts,
    publish(value: ReviewSnapshot) {
      snapshot = value;
      publish(value);
    },
  };
}

test("imported aborted requests show a readable stopped status instead of legacy error JSON", () => {
  const mock = mockClient();
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
    dispose,
  }));
  try {
    mock.publish({
      ...empty(),
      settlements: [
        {
          submissionId: "old",
          outcome: "aborted",
          error:
            '{"name":"FlueError","message":"Submission was aborted.","type":"submission_aborted","details":"The operation was stopped before it produced a completed response."}',
        },
      ],
    });
    assert.equal(chat.error(), "Review stopped before completion. Send a follow-up to continue.");
    assert.equal(chat.isStreaming(), false);
    mock.publish({ ...empty(), settlements: [{ submissionId: "new", outcome: "completed" }] });
    assert.equal(chat.error(), null);
  } finally {
    dispose();
  }
});

test("a lost admission response retries the same durable request key", async () => {
  const mock = mockClient();
  mock.fail();
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
    dispose,
  }));
  assert.equal(await chat.sendMessage("Review"), false);
  mock.recover();
  const retried = chat.retry();
  await Promise.resolve();
  mock.publish({ ...empty(), settlements: [{ submissionId: "submission", outcome: "completed" }] });
  assert.equal(await retried, true);
  assert.equal(mock.keys[0], mock.keys[1]);
  dispose();
});

test("unmounting detaches observation without aborting durable work", async () => {
  const mock = mockClient();
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
    dispose,
  }));
  const sent = chat.sendMessage("Review");
  await Promise.resolve();
  dispose();
  assert.equal(await sent, false);
  assert.equal(mock.aborts(), 0);
});

test("remote snapshots hydrate reasoning/tools and final settlement without duplicate messages", () => {
  const snapshot: ReviewSnapshot = {
    ...empty(),
    running: true,
    messages: [
      {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Review" }],
        metadata: { timestamp: "1970-01-01T00:00:00Z", revision: "A" },
      },
      {
        id: "assistant",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Inspecting" },
          {
            type: "dynamic-tool",
            toolCallId: "read-1",
            toolName: "read",
            input: { path: "source.ts" },
            state: "input-available",
          },
        ],
        metadata: { timestamp: "2026-10-14T12:00:00Z", revision: "A" },
      },
    ],
  };
  const live = conversationSnapshotState(snapshot);
  assert.equal(live.messages.length, 1);
  assert.equal(live.live?.reasoning, "Inspecting");
  assert.equal(live.live?.toolCalls[0]?.status, "running");
  snapshot.running = false;
  const messages = conversationSnapshotMessages(snapshot);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.timestamp, 0);
  assert.equal(messages[1]?.revision, "A");
});

test("late responses from a previously selected session cannot replace the current chat", async () => {
  const first = mockClient();
  const second = mockClient();
  const { chat, setId, dispose } = createRoot((dispose) => {
    const [id, setId] = createSignal("first");
    return {
      chat: useStreamingChat({ getSessionId: id }, (id) =>
        id === "first" ? first.client : second.client,
      ),
      setId,
      dispose,
    };
  });
  const sent = chat.sendMessage("Old review");
  setId("second");
  assert.equal(await sent, false);
  first.publish({ ...empty(), running: true });
  assert.equal(chat.isStreaming(), false);
  assert.equal(first.aborts(), 0);
  dispose();
});
