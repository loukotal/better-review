import { createFlueClient, type AttachedAgentEvent, type FlueEventStream } from "@flue/sdk";
import { batch, createEffect, createSignal, onCleanup } from "solid-js";

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
}

export interface UseStreamingChatOptions {
  getSessionId: () => string | null;
  onError?: (error: string) => void;
}

export interface SendMessageOptions {
  reviewMode?: "full" | "commit";
  commitSha?: string;
}

const flueBaseUrl =
  (import.meta.env.VITE_FLUE_BASE_URL as string | undefined) ?? `${window.location.origin}/flue`;
const flueClient = createFlueClient({
  baseUrl: flueBaseUrl,
  // Chrome/Safari can throw "Illegal invocation" if a bare window.fetch
  // reference is called without Window as `this` through SDK indirection.
  fetch: globalThis.fetch.bind(globalThis),
});

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAssistantSnapshot(
  message: unknown,
): { content: string; reasoning?: string } | null {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
    return null;

  let content = "";
  let reasoning = "";
  for (const part of message.content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      content += part.text;
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      reasoning += part.thinking;
    }
  }

  return { content, reasoning: reasoning || undefined };
}

export function useStreamingChat(options: UseStreamingChatOptions) {
  const [messages, setMessages] = createSignal<StreamingMessage[]>([]);
  const [isConnected, setIsConnected] = createSignal(false);
  const [connectionStatus, setConnectionStatus] = createSignal<
    "offline" | "connecting" | "connected" | "degraded" | "reconnecting"
  >("offline");
  const [lastHeartbeatAt, setLastHeartbeatAt] = createSignal<number | null>(null);
  const [upstreamStatus, setUpstreamStatus] = createSignal<
    "Disconnected" | "Connecting" | "Connected" | "Reconnecting" | "Error" | null
  >(null);
  const [subscriberCount, setSubscriberCount] = createSignal(0);
  const [awaitingFirstToken, setAwaitingFirstToken] = createSignal(false);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streamingContent, setStreamingContent] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [activeTools, setActiveTools] = createSignal<ToolCall[]>([]);
  const [currentMessageId, setCurrentMessageId] = createSignal<string | null>(null);

  let activeStream: FlueEventStream<AttachedAgentEvent> | null = null;
  let activePromptAbort: AbortController | null = null;
  let isDisposed = false;
  let isConnecting = false;
  let socketFailed = false;
  let awaitingAssistantResponse = false;
  let abortingPrompt = false;

  function resetStreamingState() {
    batch(() => {
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setIsStreaming(false);
      setAwaitingFirstToken(false);
    });
    awaitingAssistantResponse = false;
  }

  function markConnected() {
    batch(() => {
      setIsConnected(true);
      setConnectionStatus("connected");
      setLastHeartbeatAt(Date.now());
      setUpstreamStatus("Connected");
      setSubscriberCount(1);
      setError(null);
    });
  }

  function cleanupSocket() {
    activePromptAbort?.abort();
    activePromptAbort = null;
    activeStream?.cancel("client cleanup");
    activeStream = null;
    isConnecting = false;
  }

  async function ensureSocket(): Promise<boolean> {
    const sessionId = options.getSessionId();
    if (!sessionId || isDisposed) {
      cleanupSocket();
      setIsConnected(false);
      setConnectionStatus("offline");
      return false;
    }

    isConnecting = true;
    setConnectionStatus("connecting");
    setUpstreamStatus("Connecting");
    markConnected();
    isConnecting = false;
    return true;
  }

  createEffect(() => {
    const sessionId = options.getSessionId();
    resetStreamingState();

    if (!sessionId) {
      cleanupSocket();
      setIsConnected(false);
      setConnectionStatus("offline");
      return;
    }

    if (!isConnecting) {
      void ensureSocket();
    }
  });

  onCleanup(() => {
    isDisposed = true;
    cleanupSocket();
  });

  function prepareAssistantMessage(requestId: string) {
    const messageId = `assistant-${requestId}`;
    const existing = currentMessageId();
    if (existing && existing !== messageId) {
      finalizeMessage({ keepStreaming: true });
    }
    setCurrentMessageId(messageId);
  }

  function acceptAssistantEvent(requestId: string) {
    prepareAssistantMessage(requestId);
    if (!isStreaming()) {
      setIsStreaming(true);
    }
    if (awaitingFirstToken()) {
      setAwaitingFirstToken(false);
    }
    awaitingAssistantResponse = true;
    markConnected();
  }

  function upsertTool(tool: ToolCall) {
    setActiveTools((prev) => {
      const existingIndex = prev.findIndex((item) => item.callId === tool.callId);
      if (existingIndex === -1) return [...prev, tool];

      const next = [...prev];
      next[existingIndex] = { ...next[existingIndex], ...tool };
      return next;
    });
  }

  function handleFlueEvent(event: AttachedAgentEvent, requestId: string) {
    switch (event.type) {
      case "text_delta":
        acceptAssistantEvent(requestId);
        setStreamingContent((prev) => prev + event.text);
        break;

      case "thinking_delta":
        acceptAssistantEvent(requestId);
        setStreamingReasoning((prev) => prev + event.delta);
        break;

      case "message_start": {
        const snapshot = extractAssistantSnapshot(event.message);
        if (snapshot) {
          acceptAssistantEvent(requestId);
          setStreamingContent(snapshot.content);
          setStreamingReasoning(snapshot.reasoning ?? "");
        }
        break;
      }

      case "message_end": {
        const snapshot = extractAssistantSnapshot(event.message);
        if (snapshot) {
          acceptAssistantEvent(requestId);
          setStreamingContent(snapshot.content);
          setStreamingReasoning(snapshot.reasoning ?? "");
        }
        finalizeMessage();
        break;
      }

      case "turn": {
        const snapshot = extractAssistantSnapshot(event.output);
        if (snapshot && !event.isError && awaitingAssistantResponse) {
          acceptAssistantEvent(requestId);
          setStreamingContent(snapshot.content);
          setStreamingReasoning(snapshot.reasoning ?? "");
        }
        break;
      }

      case "tool_start":
        acceptAssistantEvent(requestId);
        upsertTool({
          id: event.toolCallId,
          tool: event.toolName,
          callId: event.toolCallId,
          status: "pending",
          input: isRecord(event.args) ? event.args : {},
          title: event.toolName,
        });
        break;

      case "tool":
        acceptAssistantEvent(requestId);
        upsertTool({
          id: event.toolCallId,
          tool: event.toolName,
          callId: event.toolCallId,
          status: event.isError ? "error" : "completed",
          input: {},
          output: event.isError ? undefined : stringifyValue(event.result),
          error: event.isError ? stringifyValue(event.result) : undefined,
          title: `${event.toolName} (${Math.round(event.durationMs)}ms)`,
        });
        break;

      case "idle":
        finalizeMessage();
        break;

      case "operation":
        if (event.operationKind === "prompt" && event.isError) {
          const message = stringifyValue(event.error ?? "Prompt failed");
          const visibleMessage = `Prompt stopped before the assistant could finish: ${message}`;
          setError(message);
          options.onError?.(message);
          appendAssistantErrorMessage(visibleMessage);
        }
        break;
    }
  }

  function finalizeMessage(options?: { keepStreaming?: boolean }) {
    const content = streamingContent();
    const reasoning = streamingReasoning();
    const tools = activeTools();
    const msgId = currentMessageId();

    if (!content && !reasoning && tools.length === 0) {
      setIsStreaming(Boolean(options?.keepStreaming));
      setAwaitingFirstToken(false);
      awaitingAssistantResponse = false;
      return;
    }

    batch(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: msgId || `assistant-${Date.now()}`,
          role: "assistant",
          content,
          reasoning: reasoning || undefined,
          toolCalls: [...tools],
          isStreaming: false,
          timestamp: Date.now(),
        },
      ]);
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setIsStreaming(Boolean(options?.keepStreaming));
      setAwaitingFirstToken(false);
    });

    awaitingAssistantResponse = Boolean(options?.keepStreaming);
  }

  function appendAssistantErrorMessage(message: string) {
    const errorText = message.startsWith("⚠️") ? message : `⚠️ ${message}`;
    batch(() => {
      finalizeMessage();
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content: errorText,
          toolCalls: [],
          isStreaming: false,
          timestamp: Date.now(),
        },
      ]);
      setIsStreaming(false);
      setAwaitingFirstToken(false);
    });
    awaitingAssistantResponse = false;
  }

  async function sendMessage(message: string, _sendOptions?: SendMessageOptions): Promise<boolean> {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      setError("No session");
      return false;
    }

    // Open a fresh socket for each prompt. This avoids stale dev/HMR sockets and
    // Flue sockets left in a bad protocol state after an interrupted request.
    cleanupSocket();
    const connected = await ensureSocket();
    if (!connected) return false;

    const userMessage: StreamingMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      toolCalls: [],
      isStreaming: false,
      timestamp: Date.now(),
    };

    batch(() => {
      setMessages((prev) => [...prev, userMessage]);
      setIsStreaming(true);
      setAwaitingFirstToken(true);
      setError(null);
    });
    awaitingAssistantResponse = true;
    abortingPrompt = false;

    try {
      activePromptAbort = new AbortController();
      const sent = await flueClient.agents.send("pr-reviewer", sessionId, {
        message,
        signal: activePromptAbort.signal,
      });

      activeStream = flueClient.agents.stream("pr-reviewer", sessionId, {
        offset: sent.offset,
        live: true,
        signal: activePromptAbort.signal,
      });

      for await (const event of activeStream) {
        if (abortingPrompt || isDisposed) break;
        handleFlueEvent(event, sent.submissionId);
        if (event.type === "idle" || event.type === "submission_settled") break;
      }

      finalizeMessage();
      activeStream = null;
      activePromptAbort = null;
      return !abortingPrompt;
    } catch (err) {
      if (abortingPrompt) {
        abortingPrompt = false;
        return false;
      }

      const errorMessage = err instanceof Error ? err.message : "Failed to send message";
      const details =
        isRecord(err) && isRecord(err.error) && typeof err.error.details === "string"
          ? err.error.details
          : "";

      setError(details ? `${errorMessage}: ${details}` : errorMessage);
      setIsStreaming(false);
      setAwaitingFirstToken(false);
      awaitingAssistantResponse = false;
      setConnectionStatus("degraded");
      setUpstreamStatus("Error");
      options.onError?.(errorMessage);
      return false;
    }
  }

  async function abort(): Promise<void> {
    abortingPrompt = true;
    finalizeMessage();
    cleanupSocket();
    setIsConnected(false);
    setConnectionStatus("reconnecting");
    await ensureSocket();
  }

  function clearMessages() {
    setMessages([]);
    resetStreamingState();
    setError(null);
  }

  function loadExistingMessages(msgs: StreamingMessage[]) {
    batch(() => {
      setMessages(msgs);
      setError(null);
      resetStreamingState();
    });
  }

  return {
    messages,
    isConnected,
    connectionStatus,
    lastHeartbeatAt,
    upstreamStatus,
    subscriberCount,
    isStreaming,
    awaitingFirstToken,
    error,
    streamingContent,
    streamingReasoning,
    activeTools,
    sendMessage,
    abort,
    clearMessages,
    loadExistingMessages,
  };
}
