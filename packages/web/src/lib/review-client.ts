import type { ReviewSnapshot } from "@better-review/shared";

import { fetchWithApiAuth } from "./apiAuth";

export interface ReviewClient {
  history(): Promise<ReviewSnapshot>;
  send(body: string, requestId: string): Promise<{ submissionId: string }>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  observe(
    snapshot: (value: ReviewSnapshot) => void,
    error: (message: string) => void,
    connected: () => void,
  ): () => void;
}

export function createReviewClient(sessionId: string): ReviewClient {
  const url = `/api/review/sessions/${encodeURIComponent(sessionId)}`;
  async function request<T>(suffix: string, body?: unknown): Promise<T> {
    const response = await fetchWithApiAuth(
      url + suffix,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message ?? `Review request failed (${response.status})`);
    }
    return response.json();
  }
  return {
    history: () => request<ReviewSnapshot>(""),
    send: (body, requestId) => request("", { body, requestId }),
    abort: async () => {
      await request("/abort", {});
    },
    compact: async () => {
      await request("/compact", {});
    },
    observe(snapshot, error, connected) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      const connect = async () => {
        try {
          const response = await fetchWithApiAuth(url + "/events", {
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          });
          if (!response.ok || !response.body)
            throw new Error(`Review stream failed (${response.status})`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          try {
            while (!controller.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += chunk.value;
              let end: number;
              while ((end = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                if (frame.includes("event: snapshot") && data) snapshot(JSON.parse(data));
                if (data) {
                  attempt = 0;
                  connected();
                }
              }
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          if (!controller.signal.aborted)
            throw new Error("Review stream disconnected; reconnecting…");
        } catch (cause) {
          if (controller.signal.aborted) return;
          error(cause instanceof Error ? cause.message : "Review connection failed");
          timer = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt++, 10000));
        }
      };
      void connect();
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    },
  };
}
