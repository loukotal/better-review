import assert from "node:assert/strict";
import test from "node:test";

import { getFlueProviders } from "./oauth-auth";

for (const method of ["stream", "streamSimple"] as const) {
  test(`Codex ${method} completes over SSE when WebSockets would drop mid-response`, async (t) => {
    let socketsCreated = 0;
    class DroppingWebSocket extends EventTarget {
      readyState = 1;

      constructor() {
        super();
        socketsCreated++;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send() {
        // Match the reported failure: the provider has already started the
        // response, so its automatic pre-stream SSE fallback cannot help.
        setImmediate(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "response.created", response: { id: "resp_test" } }),
            }),
          );
          setImmediate(() => this.dispatchEvent(new Event("error")));
        });
      }

      close() {
        this.readyState = 3;
      }
    }

    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = DroppingWebSocket as unknown as typeof WebSocket;
    t.after(() => {
      globalThis.WebSocket = originalWebSocket;
    });

    const provider = getFlueProviders().find((candidate) => candidate.id === "openai-codex")!;
    const model = provider.getModels().find((candidate) => candidate.id === "gpt-5.6-sol")!;
    const token = `test.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url")}.test`;
    let httpRequests = 0;
    const result = await provider[method](
      model,
      { messages: [{ role: "user", content: "Reply with OK.", timestamp: 0 }] },
      {
        apiKey: token,
        signal: AbortSignal.timeout(5_000),
        fetch: async (_url, init) => {
          httpRequests++;
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
          const events = [
            { type: "response.created", response: { id: "resp_test" } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "msg_test", role: "assistant", content: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_test",
              output_index: 0,
              content_index: 0,
              delta: "OK",
            },
            {
              type: "response.completed",
              response: {
                id: "resp_test",
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      },
    ).result();

    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.ok(result.content.some((part) => part.type === "text" && part.text === "OK"));
    assert.equal(httpRequests, 1);
    assert.equal(socketsCreated, 0);
  });
}
