import { batch, createEffect, createSignal, onCleanup } from "solid-js";

import type {
  ReviewSnapshot,
  ReviewMessage,
  ReviewSettlement,
  ReviewModelIntent,
} from "@better-review/shared";

import { createReviewClient, type ReviewClient } from "../lib/review-client";

export interface ToolCall {
  id: string;
  tool: string;
  callId: string;
  status: "pending" | "running" | "completed" | "error";
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
}
export interface StreamingMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  isStreaming: boolean;
  timestamp: number;
  revision?: string;
}
export interface UseStreamingChatOptions {
  getSessionId: () => string | null;
  onError?: (error: string) => void;
}
export interface SendMessageOptions {
  model?: ReviewModelIntent;
  reviewMode?: "full" | "commit";
  commitSha?: string;
}
export const createConversationClient = createReviewClient;

export function conversationSnapshotMessages(snapshot: {
  messages: ReviewMessage[];
}): StreamingMessage[] {
  return snapshot.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
    reasoning:
      message.parts
        .filter((part) => part.type === "reasoning")
        .map((part) => (part.type === "reasoning" ? part.text : ""))
        .join("") || undefined,
    toolCalls: message.parts.flatMap((part): ToolCall[] =>
      part.type !== "dynamic-tool"
        ? []
        : [
            {
              id: part.toolCallId,
              callId: part.toolCallId,
              tool: part.toolName,
              title: part.toolName,
              input: part.input,
              status:
                part.state === "output-error"
                  ? "error"
                  : part.state === "output-available"
                    ? "completed"
                    : "running",
              output: part.output,
              error: part.errorText,
            },
          ],
    ),
    isStreaming: false,
    timestamp: Date.parse(message.metadata.timestamp),
    revision: message.metadata.revision,
  }));
}
export function conversationSnapshotState(snapshot: ReviewSnapshot) {
  const messages = conversationSnapshotMessages(snapshot);
  const last = messages.at(-1);
  const live = snapshot.running && last?.role === "assistant" ? last : undefined;
  return { messages: live ? messages.slice(0, -1) : messages, live, running: snapshot.running };
}
export async function loadConversationMessages(id: string) {
  return conversationSnapshotMessages(await createReviewClient(id).history());
}

function settlementMessage(settlement: ReviewSettlement): string | null {
  if (settlement.outcome === "completed") return null;
  if (settlement.outcome === "aborted")
    return "Review stopped before completion. Send a follow-up to continue.";
  const error = settlement.error;
  if (!error) return "Review failed. Try again.";
  // Already-imported conversations can contain serialized errors from the old runtime.
  try {
    const value: unknown = JSON.parse(error);
    if (
      value &&
      typeof value === "object" &&
      "message" in value &&
      typeof value.message === "string"
    )
      return value.message;
  } catch {
    // Native errors can also be plain text.
  }
  return error;
}

export function useStreamingChat(
  options: UseStreamingChatOptions,
  clientFactory: (id: string) => ReviewClient = createReviewClient,
) {
  const [messages, setMessages] = createSignal<StreamingMessage[]>([]);
  const [snapshot, setSnapshot] = createSignal<ReviewSnapshot | null>(null);
  const [isConnected, setIsConnected] = createSignal(false);
  const [connectionStatus, setConnectionStatus] = createSignal<
    "offline" | "connecting" | "connected" | "degraded" | "reconnecting"
  >("offline");
  const [lastHeartbeatAt, setLastHeartbeatAt] = createSignal<number | null>(null);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [compacting, setCompacting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streamingContent, setStreamingContent] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [streamingRevision, setStreamingRevision] = createSignal<string | undefined>();
  const [activeTools, setActiveTools] = createSignal<ToolCall[]>([]);
  const [awaitingFirstToken, setAwaitingFirstToken] = createSignal(false);
  const [retryableMessage, setRetryableMessage] = createSignal<string | null>(null);
  const [revision, setRevision] = createSignal<string | undefined>();
  let client: ReviewClient | undefined;
  let stop: (() => void) | undefined;
  let generation = 0;
  let pending:
    | { body: string; key: string; id?: string; resolve: (success: boolean) => void }
    | undefined;
  let retry: { body: string; key: string; model?: ReviewModelIntent } | undefined;
  let latest: ReviewSnapshot | undefined;

  function connected() {
    batch(() => {
      setIsConnected(true);
      setConnectionStatus("connected");
      setLastHeartbeatAt(Date.now());
    });
  }
  function resetStreaming() {
    setIsStreaming(false);
    setStreamingContent("");
    setStreamingReasoning("");
    setActiveTools([]);
    setAwaitingFirstToken(false);
  }
  function apply(snapshot: ReviewSnapshot) {
    latest = snapshot;
    const projected = conversationSnapshotState(snapshot);
    batch(() => {
      setSnapshot(snapshot);
      setMessages(projected.messages);
      setStreamingContent(projected.live?.content ?? "");
      setStreamingReasoning(projected.live?.reasoning ?? "");
      setStreamingRevision(projected.live?.revision);
      setActiveTools(projected.live?.toolCalls ?? []);
      const settlement = pending?.id
        ? snapshot.settlements.find((item) => item.submissionId === pending!.id)
        : undefined;
      const running = snapshot.running || Boolean(pending && !settlement);
      setIsStreaming(running);
      setCompacting(snapshot.compacting);
      setRevision(snapshot.revision);
      setAwaitingFirstToken(running && !projected.live);
      connected();
      if (settlement && pending) {
        const complete = settlement.outcome === "completed";
        retry = complete ? undefined : { body: pending.body, key: crypto.randomUUID() };
        setRetryableMessage(complete ? null : pending.body);
        setError(settlementMessage(settlement));
        pending.resolve(complete);
        pending = undefined;
      } else if (!pending && !snapshot.running) {
        const last = snapshot.settlements.at(-1);
        setError(last ? settlementMessage(last) : null);
      }
    });
  }
  function disconnect() {
    stop?.();
    stop = undefined;
    pending?.resolve(false);
    pending = undefined;
    client = undefined;
    generation++;
  }
  createEffect(() => {
    const id = options.getSessionId();
    disconnect();
    resetStreaming();
    setSnapshot(null);
    setMessages([]);
    setError(null);
    setRetryableMessage(null);
    latest = undefined;
    retry = undefined;
    if (!id) {
      setIsConnected(false);
      setConnectionStatus("offline");
      return;
    }
    const version = generation;
    client = clientFactory(id);
    setConnectionStatus("connecting");
    stop = client.observe(
      (snapshot) => {
        if (generation === version) apply(snapshot);
      },
      (message) => {
        if (generation !== version) return;
        setIsConnected(false);
        setConnectionStatus("reconnecting");
        setError(message);
      },
      () => {
        if (generation === version) connected();
      },
    );
  });
  onCleanup(disconnect);

  async function submit(body: string, key: string, model?: ReviewModelIntent): Promise<boolean> {
    if (!client || pending || isStreaming()) return false;
    const target = client;
    const version = generation;
    let resolve!: (success: boolean) => void;
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    pending = { body, key, resolve };
    setError(null);
    setRetryableMessage(null);
    setIsStreaming(true);
    setAwaitingFirstToken(true);
    try {
      const receipt = await target.send(body, key, model);
      if (generation !== version || !pending) return false;
      pending.id = receipt.submissionId;
      if (latest) apply(latest);
      // A fast completion may precede SSE attachment, or a reconnect may be in progress.
      if (pending) {
        const snapshot = await target.history();
        if (generation === version) apply(snapshot);
      }
    } catch (cause) {
      if (generation !== version) return false;
      const message = cause instanceof Error ? cause.message : "Failed to send review message";
      retry = { body, key, model };
      setRetryableMessage(body);
      setError(message);
      resetStreaming();
      pending?.resolve(false);
      pending = undefined;
      options.onError?.(message);
    }
    return result;
  }
  return {
    snapshot,
    messages,
    isConnected,
    connectionStatus,
    lastHeartbeatAt,
    upstreamStatus: () => (isConnected() ? ("Connected" as const) : ("Reconnecting" as const)),
    subscriberCount: () => (isConnected() ? 1 : 0),
    isStreaming,
    compacting,
    awaitingFirstToken,
    error,
    retryableMessage,
    streamingContent,
    streamingReasoning,
    streamingRevision,
    revision,
    activeTools,
    sendMessage: (body: string, options?: SendMessageOptions) =>
      submit(body, crypto.randomUUID(), options?.model),
    retry: () => (retry ? submit(retry.body, retry.key, retry.model) : Promise.resolve(false)),
    async abort() {
      const target = client;
      const version = generation;
      try {
        await target?.abort();
        if (target) {
          const snapshot = await target.history();
          if (generation === version) apply(snapshot);
        }
      } catch (cause) {
        if (generation === version) setError(String(cause));
      }
    },
    async compact() {
      try {
        await client?.compact();
      } catch (cause) {
        setError(String(cause));
      }
    },
    clearMessages() {
      setSnapshot(null);
      setMessages([]);
      resetStreaming();
    },
    loadExistingMessages(value: StreamingMessage[]) {
      setMessages(value);
      resetStreaming();
    },
  };
}
