import { createFlueClient, type ConversationStreamChunk } from "@flue/sdk";
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
  (import.meta.env?.VITE_FLUE_BASE_URL as string | undefined) ?? `${window.location.origin}/flue`;
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

export function useStreamingChat(
  options: UseStreamingChatOptions,
  client: ReturnType<typeof createFlueClient> = flueClient,
) {
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

  let activePromptAbort: AbortController | null = null;
  let activeAssistantMessageId: string | null = null;
  let isDisposed = false;
  let isConnecting = false;

  function resetStreamingState() {
    batch(() => {
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setIsStreaming(false);
      setAwaitingFirstToken(false);
    });
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
    activeAssistantMessageId = null;
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

  function prepareAssistantMessage(requestId: string, messageId = `assistant-${requestId}`) {
    const existing = currentMessageId();
    if (existing && existing !== messageId) {
      finalizeMessage({ keepStreaming: true });
    }
    setCurrentMessageId(messageId);
  }

  function acceptAssistantEvent(requestId: string, messageId?: string) {
    prepareAssistantMessage(requestId, messageId);
    if (!isStreaming()) {
      setIsStreaming(true);
    }
    if (awaitingFirstToken()) {
      setAwaitingFirstToken(false);
    }
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

  function handleFlueEvent(event: ConversationStreamChunk, requestId: string) {
    switch (event.type) {
      case "message-started":
        if (event.submissionId !== requestId) break;
        activeAssistantMessageId = event.messageId;
        acceptAssistantEvent(requestId, event.messageId);
        break;

      case "message-delta":
        if (event.messageId !== activeAssistantMessageId) break;
        acceptAssistantEvent(requestId, event.messageId);
        if (event.kind === "text") {
          setStreamingContent((prev) => prev + event.delta);
        } else {
          setStreamingReasoning((prev) => prev + event.delta);
        }
        break;

      case "tool-input":
        if (event.messageId !== activeAssistantMessageId) break;
        acceptAssistantEvent(requestId, event.messageId);
        upsertTool({
          id: event.toolCallId,
          tool: event.toolName,
          callId: event.toolCallId,
          status: "running",
          input: isRecord(event.input) ? event.input : {},
          title: event.toolName,
        });
        break;

      case "tool-output": {
        const tool = activeTools().find((item) => item.callId === event.toolCallId);
        if (!tool) break;
        upsertTool({
          ...tool,
          status: "completed",
          output: stringifyValue(event.output),
        });
        break;
      }

      case "tool-output-error": {
        const tool = activeTools().find((item) => item.callId === event.toolCallId);
        if (!tool) break;
        upsertTool({
          ...tool,
          status: "error",
          error: event.errorText,
        });
        break;
      }

      case "message-completed":
        if (event.messageId !== activeAssistantMessageId) break;
        // The assistant message is complete, but the submission is still live until
        // `submission-settled`. Keep controls disabled so a new prompt cannot abort
        // the wait between those two events.
        finalizeMessage({ keepStreaming: true });
        activeAssistantMessageId = null;
        break;

      case "submission-settled":
        if (event.submissionId !== requestId || event.outcome === "completed") break;
        appendAssistantErrorMessage(
          `Prompt ${event.outcome}: ${stringifyValue(event.error ?? event.outcome)}`,
        );
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
    const promptAbort = new AbortController();
    activePromptAbort = promptAbort;
    try {
      const sent = await client.agents.send("pr-reviewer", sessionId, {
        message,
        signal: promptAbort.signal,
      });

      await client.agents.wait(sent, {
        signal: promptAbort.signal,
        onEvent: (event) => handleFlueEvent(event, sent.submissionId),
      });

      finalizeMessage();
      if (activePromptAbort === promptAbort) activePromptAbort = null;
      return true;
    } catch (err) {
      // Cleanup, session changes, a replacement prompt, and component disposal all
      // intentionally abort this request. Check the request's own signal rather
      // than shared mutable state, which races with the next request.
      if (promptAbort.signal.aborted || isDisposed) {
        if (activePromptAbort === promptAbort) activePromptAbort = null;
        return false;
      }

      if (activePromptAbort === promptAbort) activePromptAbort = null;

      const errorMessage = err instanceof Error ? err.message : "Failed to send message";
      const details =
        isRecord(err) && isRecord(err.error) && typeof err.error.details === "string"
          ? err.error.details
          : "";

      setError(details ? `${errorMessage}: ${details}` : errorMessage);
      setIsStreaming(false);
      setAwaitingFirstToken(false);
      setConnectionStatus("degraded");
      setUpstreamStatus("Error");
      options.onError?.(errorMessage);
      return false;
    }
  }

  async function abort(): Promise<void> {
    const sessionId = options.getSessionId();
    finalizeMessage();
    cleanupSocket();
    if (sessionId) {
      try {
        await client.agents.abort("pr-reviewer", sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to abort prompt";
        setError(message);
        options.onError?.(message);
      }
    }
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
