import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import type { ReviewSnapshot, ReviewModelIntent } from "@better-review/shared";

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
  let listener!: Parameters<ReviewClient["observe"]>[0];
  let onError!: Parameters<ReviewClient["observe"]>[1];
  let onConnected!: Parameters<ReviewClient["observe"]>[2];
  let disposed = 0;
  let deliveries = 0;
  const keys: string[] = [];
  const requests: { body: string; key: string; model?: ReviewModelIntent }[] = [];
  const sends: ReturnType<typeof deferred<Awaited<ReturnType<ReviewClient["send"]>>>>[] = [];
  const histories: ReturnType<typeof deferred<ReviewSnapshot>>[] = [];
  let historyCalls = 0;
  let historyFinished = 0;
  let fail = false;
  let aborts = 0;
  const client: ReviewClient = {
    history: async () => {
      historyCalls++;
      try {
        return await (histories.shift()?.promise ?? snapshot);
      } finally {
        historyFinished++;
      }
    },
    send: async (body, key, model) => {
      keys.push(key);
      requests.push({ body, key, model });
      const held = sends.shift();
      if (held) return held.promise;
      if (fail) throw new Error("Connection lost");
      return { submissionId: "submission" };
    },
    abort: async () => {
      aborts++;
    },
    compact: async () => {},
    observe: (value, error, connected) => {
      listener = value;
      onError = error;
      onConnected = connected;
      return () => {
        disposed++;
      };
    },
  };
  return {
    client,
    keys,
    requests,
    sends,
    histories,
    historyCalls: () => historyCalls,
    historyFinished: () => historyFinished,
    disposed: () => disposed,
    deliveries: () => deliveries,
    error(message: string) {
      deliveries++;
      onError(message);
    },
    connected() {
      deliveries++;
      onConnected();
    },
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
    aborts: () => aborts,
    publish(value: ReviewSnapshot) {
      snapshot = value;
      deliveries++;
      listener(value);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 1000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Race checkpoint timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function mounted(mock = mockClient()) {
  return {
    mock,
    ...createRoot((dispose) => ({
      chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
      dispose,
    })),
  };
}

const completed = (id = "submission"): ReviewSnapshot => ({
  ...empty(),
  revision: "new",
  settlements: [{ submissionId: id, outcome: "completed" }],
  messages: [
    {
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "Done" }],
      metadata: { timestamp: "2026-10-23T00:00:00Z", revision: "new" },
    },
  ],
});

test(
  "observer completion before held admission settles once without remaining busy",
  { timeout: 2000 },
  async (t) => {
    const { mock, chat, dispose } = mounted();
    t.after(dispose);
    const admission = deferred<{ submissionId: string }>();
    mock.sends.push(admission);
    let outcomes = 0;
    const sent = chat.sendMessage("Review").then((value) => {
      outcomes++;
      return value;
    });
    mock.publish(completed());
    assert.equal(outcomes, 0);
    admission.resolve({ submissionId: "submission" });
    assert.equal(await sent, true);
    mock.publish(completed());
    assert.equal(outcomes, 1);
    assert.equal(chat.isStreaming(), false);
    assert.equal(mock.historyCalls(), 0);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.deliveries(), 2);
    assert.equal(mock.aborts(), 0);
  },
);

for (const outcome of ["success", "error"] as const) {
  test(
    `old history ${outcome} after settlement cannot replace newer observation or install retry`,
    { timeout: 2000 },
    async (t) => {
      const { mock, chat, dispose } = mounted();
      t.after(dispose);
      const history = deferred<ReviewSnapshot>();
      mock.histories.push(history);
      const sent = chat.sendMessage("Review");
      await until(() => mock.historyCalls() === 1);
      const fresh: ReviewSnapshot = {
        ...completed(),
        running: true,
        messages: [
          ...completed().messages,
          {
            id: "live",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolCallId: "tool",
                toolName: "read",
                input: {},
                state: "input-available",
              },
            ],
            metadata: { timestamp: "2026-10-23T00:00:00Z", revision: "new" },
          },
        ],
      };
      mock.publish(fresh);
      if (outcome === "success") history.resolve(empty());
      else history.reject(new Error("Stale history failure"));
      assert.equal(await sent, true);
      assert.deepEqual(chat.snapshot(), fresh);
      assert.equal(chat.messages()[0]?.content, "Done");
      assert.equal(chat.activeTools()[0]?.callId, "tool");
      assert.equal(chat.streamingRevision(), "new");
      assert.equal(chat.revision(), "new");
      assert.equal(chat.isStreaming(), true);
      assert.equal(chat.retryableMessage(), null);
      assert.equal(chat.error(), null);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.deliveries(), 1);
      assert.equal(mock.aborts(), 0);
    },
  );

  test(
    `A held history ${outcome} cannot clear or overwrite pending B`,
    { timeout: 2000 },
    async (t) => {
      const { mock, chat, dispose } = mounted();
      t.after(dispose);
      const history = deferred<ReviewSnapshot>();
      mock.histories.push(history);
      const first = chat.sendMessage("A");
      await until(() => mock.historyCalls() === 1);
      mock.publish(completed());
      const admission = deferred<{ submissionId: string }>();
      mock.sends.push(admission);
      let bSettled = false;
      const second = chat.sendMessage("B").then((value) => {
        bSettled = true;
        return value;
      });
      if (outcome === "success") history.resolve(empty());
      else history.reject(new Error("A failed late"));
      assert.equal(await first, true);
      assert.equal(bSettled, false);
      assert.equal(chat.isStreaming(), true);
      assert.equal(chat.error(), null);
      assert.equal(chat.retryableMessage(), null);
      assert.deepEqual(
        chat.messages().map((message) => message.content),
        ["Done"],
      );
      mock.publish(completed("B"));
      admission.resolve({ submissionId: "B" });
      assert.equal(await second, true);
      assert.equal(chat.isStreaming(), false);
      assert.equal(mock.requests.length, 2);
      assert.equal(mock.historyCalls(), 1);
      assert.equal(mock.deliveries(), 2);
      assert.equal(mock.aborts(), 0);
    },
  );
}

test(
  "fresh history still settles admission without an observation",
  { timeout: 2000 },
  async (t) => {
    const { mock, chat, dispose } = mounted();
    t.after(dispose);
    const history = deferred<ReviewSnapshot>();
    mock.histories.push(history);
    const sent = chat.sendMessage("Review");
    await until(() => mock.historyCalls() === 1);
    history.resolve(completed());
    assert.equal(await sent, true);
    assert.equal(chat.isStreaming(), false);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.deliveries(), 0);
  },
);

test("current history failure still reports a retryable request", { timeout: 2000 }, async (t) => {
  const { mock, chat, dispose } = mounted();
  t.after(dispose);
  const history = deferred<ReviewSnapshot>();
  mock.histories.push(history);
  const sent = chat.sendMessage("Review");
  await until(() => mock.historyCalls() === 1);
  history.reject(new Error("Current history failed"));
  assert.equal(await sent, false);
  assert.equal(chat.error(), "Current history failed");
  assert.equal(chat.retryableMessage(), "Review");
  assert.equal(chat.isStreaming(), false);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.historyCalls(), 1);
  assert.equal(mock.deliveries(), 0);
  assert.equal(mock.aborts(), 0);
});

for (const previous of ["empty", "existing messages"] as const) {
  test(
    `late pre-admission observer with ${previous} cannot fence matching completion history`,
    { timeout: 2000 },
    async (t) => {
      const { mock, chat, dispose } = mounted();
      t.after(dispose);
      const history = deferred<ReviewSnapshot>();
      mock.histories.push(history);
      let outcomes = 0;
      const sent = chat.sendMessage("A").then((value) => {
        outcomes++;
        return value;
      });
      await until(() => mock.historyCalls() === 1);
      const prior: ReviewSnapshot =
        previous === "empty"
          ? empty()
          : {
              ...completed("previous"),
              messages: completed("previous").messages.map((message) => ({
                ...message,
                id: "previous",
                submissionId: "previous",
              })),
            };
      mock.publish(prior);
      const final = {
        ...completed(),
        messages: [...prior.messages, ...completed().messages],
        settlements: [...prior.settlements, ...completed().settlements],
      };
      history.resolve(final);
      await until(() => mock.historyFinished() === 1);
      assert.deepEqual(chat.snapshot(), final);
      assert.equal(chat.messages().at(-1)?.content, "Done");
      assert.equal(chat.isStreaming(), false);
      assert.equal(await sent, true);
      assert.equal(outcomes, 1);
      assert.equal(chat.error(), null);
      assert.equal(chat.retryableMessage(), null);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.historyCalls(), 1);
      assert.equal(mock.deliveries(), 1);
      assert.equal(mock.aborts(), 0);
    },
  );
}

for (const historyRevision of ["other-ref", undefined, "observer-ref"] as const) {
  test(
    `idle observation revision is preserved against history revision ${historyRevision ?? "absent"}`,
    { timeout: 2000 },
    async (t) => {
      const { mock, chat, dispose } = mounted();
      t.after(dispose);
      const history = deferred<ReviewSnapshot>();
      mock.histories.push(history);
      const sent = chat.sendMessage("A");
      await until(() => mock.historyCalls() === 1);
      const observed: ReviewSnapshot = {
        ...empty(),
        revision: "observer-ref",
        messages: completed("previous").messages,
      };
      mock.publish(observed);
      const final: ReviewSnapshot = {
        ...completed(),
        revision: historyRevision,
        messages: [...observed.messages, { ...completed().messages[0]!, id: "new-answer" }],
      };
      history.resolve(final);
      assert.equal(await sent, true);
      assert.deepEqual(chat.snapshot(), historyRevision === observed.revision ? final : observed);
      assert.equal(chat.revision(), "observer-ref");
      assert.equal(chat.messages().length, historyRevision === observed.revision ? 2 : 1);
      assert.equal(chat.isStreaming(), false);
      assert.equal(chat.awaitingFirstToken(), false);
      assert.equal(chat.error(), null);
      assert.equal(chat.retryableMessage(), null);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.historyCalls(), 1);
      assert.equal(mock.deliveries(), 1);
      assert.equal(mock.aborts(), 0);
    },
  );
}

for (const presentation of ["live progress", "changed prior message"] as const) {
  test(
    `matching history settles A without replacing ${presentation}`,
    { timeout: 2000 },
    async (t) => {
      const { mock, chat, dispose } = mounted();
      t.after(dispose);
      const history = deferred<ReviewSnapshot>();
      mock.histories.push(history);
      const sent = chat.sendMessage("A");
      await until(() => mock.historyCalls() === 1);
      const observed: ReviewSnapshot = {
        ...empty(),
        running: presentation === "live progress",
        revision: "observer-ref",
        messages: [
          {
            ...completed().messages[0]!,
            parts: [
              { type: "text", text: "Newer observed text" },
              {
                type: "dynamic-tool",
                toolCallId: "observed-tool",
                toolName: "read",
                input: {},
                state: "input-available",
              },
            ],
            metadata: { timestamp: "2026-10-23T00:00:00Z", revision: "observer-ref" },
          },
        ],
      };
      mock.publish(observed);
      history.resolve(completed());
      assert.equal(await sent, true);
      assert.deepEqual(chat.snapshot(), observed);
      assert.equal(chat.revision(), "observer-ref");
      assert.equal(chat.isStreaming(), observed.running);
      if (observed.running) {
        assert.equal(chat.streamingContent(), "Newer observed text");
        assert.equal(chat.activeTools()[0]?.callId, "observed-tool");
        assert.equal(chat.streamingRevision(), "observer-ref");
      } else {
        assert.equal(chat.messages()[0]?.content, "Newer observed text");
        assert.equal(chat.messages()[0]?.toolCalls[0]?.callId, "observed-tool");
      }
      assert.equal(chat.error(), null);
      assert.equal(chat.retryableMessage(), null);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.historyCalls(), 1);
      assert.equal(mock.deliveries(), 1);
      assert.equal(mock.aborts(), 0);
    },
  );
}

test("matching A completion history cannot settle pending B", { timeout: 2000 }, async (t) => {
  const { mock, chat, dispose } = mounted();
  t.after(dispose);
  const history = deferred<ReviewSnapshot>();
  mock.histories.push(history);
  const first = chat.sendMessage("A");
  await until(() => mock.historyCalls() === 1);
  const observation = completed();
  mock.publish(observation);
  const admission = deferred<{ submissionId: string }>();
  mock.sends.push(admission);
  let bOutcomes = 0;
  const second = chat.sendMessage("B").then((value) => {
    bOutcomes++;
    return value;
  });
  history.resolve({ ...completed(), messages: [] });
  assert.equal(await first, true);
  assert.equal(bOutcomes, 0);
  assert.deepEqual(chat.snapshot(), observation);
  assert.equal(chat.isStreaming(), true);
  assert.equal(chat.retryableMessage(), null);
  assert.equal(chat.error(), null);
  admission.resolve({ submissionId: "B" });
  await until(() => mock.historyCalls() === 2);
  assert.equal(bOutcomes, 0);
  mock.publish(completed("B"));
  assert.equal(await second, true);
  assert.equal(bOutcomes, 1);
  assert.equal(chat.isStreaming(), false);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.deliveries(), 2);
  assert.equal(mock.aborts(), 0);
});

test(
  "newer same-session progress fences held history before settlement",
  { timeout: 2000 },
  async (t) => {
    const { mock, chat, dispose } = mounted();
    t.after(dispose);
    const history = deferred<ReviewSnapshot>();
    mock.histories.push(history);
    let settled = false;
    const sent = chat.sendMessage("Review").then((value) => {
      settled = true;
      return value;
    });
    await until(() => mock.historyCalls() === 1);
    const progress: ReviewSnapshot = {
      ...completed(),
      running: true,
      settlements: [],
      messages: [
        {
          id: "progress",
          role: "assistant",
          parts: [
            { type: "text", text: "Reading" },
            {
              type: "dynamic-tool",
              toolCallId: "read",
              toolName: "read",
              input: {},
              state: "input-available",
            },
          ],
          metadata: { timestamp: "2026-10-23T00:00:00Z", revision: "new" },
        },
      ],
    };
    mock.publish(progress);
    history.resolve(empty());
    await until(() => mock.historyFinished() === 1);
    assert.deepEqual(chat.snapshot(), progress);
    assert.equal(chat.streamingContent(), "Reading");
    assert.equal(chat.activeTools()[0]?.callId, "read");
    assert.equal(chat.streamingRevision(), "new");
    assert.equal(chat.revision(), "new");
    assert.equal(chat.isStreaming(), true);
    assert.equal(settled, false);
    mock.publish(completed());
    assert.equal(await sent, true);
    assert.equal(chat.isStreaming(), false);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.deliveries(), 2);
    assert.equal(mock.aborts(), 0);
  },
);

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

test(
  "a lost admission response retries the same durable request key",
  { timeout: 2000 },
  async () => {
    const mock = mockClient();
    mock.fail();
    const { chat, dispose } = createRoot((dispose) => ({
      chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
      dispose,
    }));
    const model: ReviewModelIntent = {
      providerId: "fixture",
      modelId: "captured",
      variant: null,
      thinkingLevel: "high",
    };
    assert.equal(await chat.sendMessage("Review", { model }), false);
    mock.recover();
    const retried = chat.retry();
    await Promise.resolve();
    mock.publish({
      ...empty(),
      settlements: [{ submissionId: "submission", outcome: "completed" }],
    });
    assert.equal(await retried, true);
    assert.equal(mock.keys[0], mock.keys[1]);
    assert.match(
      mock.keys[0]!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(mock.requests, [
      { body: "Review", key: mock.keys[0], model },
      { body: "Review", key: mock.keys[0], model },
    ]);
    assert.equal(chat.error(), null);
    assert.equal(chat.isStreaming(), false);
    assert.equal(mock.aborts(), 0);
    dispose();
  },
);

for (const phase of ["admission", "history"] as const) {
  test(
    `unmount detaches with held ${phase}; late callbacks cannot abort or mutate durable work`,
    { timeout: 2000 },
    async () => {
      const mock = mockClient();
      const { chat, dispose } = createRoot((dispose) => ({
        chat: useStreamingChat({ getSessionId: () => "review" }, () => mock.client),
        dispose,
      }));
      const admission = deferred<{ submissionId: string }>();
      const history = deferred<ReviewSnapshot>();
      if (phase === "admission") mock.sends.push(admission);
      else mock.histories.push(history);
      const sent = chat.sendMessage("Review");
      if (phase === "history") await until(() => mock.historyCalls() === 1);
      dispose();
      const before = {
        snapshot: chat.snapshot(),
        error: chat.error(),
        connected: chat.isConnected(),
        status: chat.connectionStatus(),
        heartbeat: chat.lastHeartbeatAt(),
      };
      mock.publish(completed());
      mock.error("Detached error");
      mock.connected();
      if (phase === "admission") admission.resolve({ submissionId: "submission" });
      else history.resolve(completed());
      assert.equal(await sent, false);
      assert.deepEqual(
        {
          snapshot: chat.snapshot(),
          error: chat.error(),
          connected: chat.isConnected(),
          status: chat.connectionStatus(),
          heartbeat: chat.lastHeartbeatAt(),
        },
        before,
      );
      assert.equal(mock.disposed(), 1);
      assert.equal(mock.deliveries(), 3);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.aborts(), 0);
    },
  );
}

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

for (const phase of ["admission", "history"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(
      `session change rejects old callbacks and held ${phase} ${outcome}`,
      { timeout: 2000 },
      async (t) => {
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
        t.after(dispose);
        const admission = deferred<{ submissionId: string }>();
        const history = deferred<ReviewSnapshot>();
        if (phase === "admission") first.sends.push(admission);
        else first.histories.push(history);
        const sent = chat.sendMessage("Old review");
        if (phase === "history") await until(() => first.historyCalls() === 1);
        setId("second");
        second.publish({ ...completed("second"), sessionId: "second" });
        second.error("Current session error");
        const current = {
          snapshot: chat.snapshot(),
          messages: chat.messages(),
          error: chat.error(),
          connected: chat.isConnected(),
          status: chat.connectionStatus(),
          heartbeat: chat.lastHeartbeatAt(),
        };
        first.publish({ ...empty(), running: true });
        first.error("Old error");
        first.connected();
        if (phase === "admission") {
          if (outcome === "success") admission.resolve({ submissionId: "submission" });
          else admission.reject(new Error("Old admission failed"));
        } else {
          if (outcome === "success") history.resolve(empty());
          else history.reject(new Error("Old history failed"));
        }
        assert.equal(await sent, false);
        assert.deepEqual(
          {
            snapshot: chat.snapshot(),
            messages: chat.messages(),
            error: chat.error(),
            connected: chat.isConnected(),
            status: chat.connectionStatus(),
            heartbeat: chat.lastHeartbeatAt(),
          },
          current,
        );
        assert.equal(chat.isStreaming(), false);
        assert.equal(chat.retryableMessage(), null);
        assert.equal(first.disposed(), 1);
        assert.equal(first.deliveries(), 3);
        assert.equal(first.requests.length, 1);
        assert.equal(second.requests.length, 0);
        assert.equal(first.aborts(), 0);
        assert.equal(second.aborts(), 0);
      },
    );
  }
}
