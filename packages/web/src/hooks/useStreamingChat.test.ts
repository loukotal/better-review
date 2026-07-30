import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationStreamChunk, FlueClient } from "@flue/sdk";
import { createRoot } from "solid-js";

test("retries a failed prompt without duplicating the user message", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost" } },
  });
  const { useStreamingChat } = await import("./useStreamingChat");
  const sentMessages: string[] = [];
  let attempt = 0;

  const client = {
    agents: {
      send: async (_agent: string, _session: string, input: { message: string }) => {
        sentMessages.push(input.message);
        attempt += 1;
        return { submissionId: `submission-${attempt}` };
      },
      wait: async (
        sent: { submissionId: string },
        options: { onEvent?: (event: ConversationStreamChunk) => void | Promise<void> },
      ) => {
        await options.onEvent?.({
          type: "submission-settled",
          conversationId: "session-1",
          submissionId: sent.submissionId,
          outcome: attempt === 1 ? "failed" : "completed",
          error: attempt === 1 ? { message: "Upstream failed" } : undefined,
          position: { batch: attempt, index: 0 },
        });
      },
      abort: async () => undefined,
    },
  } as unknown as FlueClient;

  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const chat = useStreamingChat({ getSessionId: () => "session-1" }, client);

      void (async () => {
        assert.equal(await chat.sendMessage("Review this PR"), false);
        assert.equal(chat.retryableMessage(), "Review this PR");

        assert.equal(await chat.retry(), true);
        assert.deepEqual(sentMessages, ["Review this PR", "Review this PR"]);
        assert.equal(chat.messages().filter((message) => message.role === "user").length, 1);
        assert.equal(chat.retryableMessage(), null);
      })()
        .then(resolve, reject)
        .finally(dispose);
    });
  });
});
