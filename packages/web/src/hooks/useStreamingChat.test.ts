import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationStreamChunk } from "@flue/sdk";
import { createRoot } from "solid-js";

type UseStreamingChat = typeof import("./useStreamingChat").useStreamingChat;
type CreateConversationClient = typeof import("./useStreamingChat").createConversationClient;

type FlueClientFactory = NonNullable<Parameters<UseStreamingChat>[1]>;
type FlueClient = ReturnType<FlueClientFactory>;

let useStreamingChat: UseStreamingChat;
let createConversationClient: CreateConversationClient;

test.before(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost" } },
  });
  ({ createConversationClient, useStreamingChat } = await import("./useStreamingChat"));
});

test("retries a failed prompt without duplicating the user message", async () => {
  const sentMessages: string[] = [];
  let attempt = 0;
  const client = {
    async send(input: { message: { body: string } }) {
      sentMessages.push(input.message.body);
      attempt += 1;
      return {
        submissionId: `submission-${attempt}`,
        offset: String(attempt),
        streamUrl: "http://localhost/stream",
      };
    },
    async wait(
      sent: { submissionId: string },
      options?: { onEvent?: (event: ConversationStreamChunk) => void | Promise<void> },
    ) {
      await options?.onEvent?.({
        type: "submission-settled",
        conversationId: "session-1",
        submissionId: sent.submissionId,
        outcome: attempt === 1 ? "failed" : "completed",
        error: attempt === 1 ? { message: "Upstream failed" } : undefined,
        position: { batch: attempt, index: 0 },
      } as ConversationStreamChunk);
    },
    async abort() {},
  } as unknown as FlueClient;
  const clientFactory = (() => client) as FlueClientFactory;

  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat({ getSessionId: () => "session-1" }, clientFactory),
    dispose,
  }));

  assert.equal(await chat.sendMessage("Review this PR"), false);
  assert.equal(chat.retryableMessage(), "Review this PR");

  assert.equal(await chat.retry(), true);
  assert.deepEqual(sentMessages, ["Review this PR", "Review this PR"]);
  assert.equal(chat.messages().filter((message) => message.role === "user").length, 1);
  assert.equal(chat.retryableMessage(), null);
  dispose();
});

test("the default Flue client uses Better Review's authenticated fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let called = false;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (key === "better-review.apiToken" ? "test-token" : null),
      removeItem: () => undefined,
      setItem: () => undefined,
    },
  });
  globalThis.fetch = async (_input, init) => {
    called = true;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    throw new Error("stop after auth assertion");
  };

  try {
    await assert.rejects(
      createConversationClient("session-auth").send({
        message: { kind: "user", body: "test" },
      }),
      /stop after auth assertion/,
    );
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});

function createPendingClient() {
  let abortCount = 0;
  let waitStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    waitStarted = resolve;
  });

  const client = {
    async send() {
      return {
        submissionId: "submission-1",
        offset: "0",
        streamUrl: "http://localhost/stream",
      };
    },
    async wait(_sent: unknown, options?: { signal?: AbortSignal }) {
      waitStarted();
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        const rejectAbort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    },
    async abort() {
      abortCount += 1;
    },
  } as unknown as FlueClient;

  return {
    clientFactory: (() => client) as FlueClientFactory,
    started,
    abortCount: () => abortCount,
  };
}

test("component cleanup does not report an intentional stream abort", async () => {
  const errors: string[] = [];
  const { clientFactory, started, abortCount } = createPendingClient();
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat(
      {
        getSessionId: () => "session-1",
        onError: (error) => errors.push(error),
      },
      clientFactory,
    ),
    dispose,
  }));

  const sending = chat.sendMessage("Review this PR");
  await started;
  dispose();

  assert.equal(await sending, false);
  assert.deepEqual(errors, []);
  assert.equal(chat.error(), null);
  assert.equal(abortCount(), 1);
});

test("a replacement prompt does not turn the cancelled request into an error", async () => {
  const errors: string[] = [];
  const { clientFactory, started, abortCount } = createPendingClient();
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat(
      {
        getSessionId: () => "session-1",
        onError: (error) => errors.push(error),
      },
      clientFactory,
    ),
    dispose,
  }));

  const first = chat.sendMessage("First prompt");
  await started;
  const second = chat.sendMessage("Replacement prompt");

  assert.equal(await first, false);
  assert.deepEqual(errors, []);
  assert.equal(abortCount(), 1);

  dispose();
  assert.equal(await second, false);
  assert.deepEqual(errors, []);
  assert.equal(abortCount(), 2);
});

test("message completion keeps controls busy until the submission settles", async () => {
  let emitEvent: ((event: ConversationStreamChunk) => void | Promise<void>) | undefined;
  let markWaitStarted!: () => void;
  const waitStarted = new Promise<void>((resolve) => {
    markWaitStarted = resolve;
  });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const client = {
    async send() {
      return {
        submissionId: "submission-1",
        offset: "0",
        streamUrl: "http://localhost/stream",
      };
    },
    async wait(
      _sent: unknown,
      options?: { onEvent?: (event: ConversationStreamChunk) => void | Promise<void> },
    ) {
      emitEvent = options?.onEvent;
      markWaitStarted();
      await settled;
    },
  } as unknown as FlueClient;
  const clientFactory = (() => client) as FlueClientFactory;
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat({ getSessionId: () => "session-1" }, clientFactory),
    dispose,
  }));

  const sending = chat.sendMessage("Review this PR");
  await waitStarted;
  assert.ok(emitEvent);
  await emitEvent({
    type: "message-started",
    submissionId: "submission-1",
    messageId: "message-1",
  } as ConversationStreamChunk);
  await emitEvent({
    type: "message-completed",
    messageId: "message-1",
  } as ConversationStreamChunk);

  assert.equal(chat.isStreaming(), true);
  settle();
  assert.equal(await sending, true);
  assert.equal(chat.isStreaming(), false);
  dispose();
});

test("Flue 2 events render text, reasoning, and completed tool calls", async () => {
  const client = {
    async send() {
      return {
        submissionId: "submission-1",
        offset: "0",
        streamUrl: "http://localhost/stream",
      };
    },
    async wait(
      _sent: unknown,
      options?: { onEvent?: (event: ConversationStreamChunk) => void | Promise<void> },
    ) {
      const emit = options?.onEvent;
      assert.ok(emit);
      await emit({
        type: "message-started",
        submissionId: "submission-1",
        messageId: "message-1",
      } as ConversationStreamChunk);
      await emit({
        type: "message-delta",
        messageId: "message-1",
        kind: "reasoning",
        delta: "Inspecting",
      } as ConversationStreamChunk);
      await emit({
        type: "message-delta",
        messageId: "message-1",
        kind: "text",
        delta: "One finding",
      } as ConversationStreamChunk);
      await emit({
        type: "tool-input",
        messageId: "message-1",
        toolCallId: "tool-1",
        toolName: "read",
        input: { path: "src/index.ts" },
      } as ConversationStreamChunk);
      await emit({
        type: "tool-output",
        messageId: "message-1",
        toolCallId: "tool-1",
        output: "file contents",
      } as unknown as ConversationStreamChunk);
      await emit({ type: "message-completed", messageId: "message-1" } as ConversationStreamChunk);
      await emit({
        type: "submission-settled",
        submissionId: "submission-1",
        outcome: "completed",
      } as ConversationStreamChunk);
    },
  } as unknown as FlueClient;
  const { chat, dispose } = createRoot((dispose) => ({
    chat: useStreamingChat(
      { getSessionId: () => "session-1" },
      (() => client) as FlueClientFactory,
    ),
    dispose,
  }));

  assert.equal(await chat.sendMessage("Review this PR"), true);
  const assistant = chat.messages().find((message) => message.role === "assistant");
  assert.equal(assistant?.content, "One finding");
  assert.equal(assistant?.reasoning, "Inspecting");
  assert.deepEqual(assistant?.toolCalls, [
    {
      id: "tool-1",
      callId: "tool-1",
      tool: "read",
      title: "read",
      status: "completed",
      input: { path: "src/index.ts" },
      output: "file contents",
    },
  ]);
  dispose();
});
