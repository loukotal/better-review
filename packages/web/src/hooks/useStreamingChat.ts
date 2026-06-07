import { createFlueClient, type AgentSocket, type AttachedAgentEvent } from "@flue/sdk";
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
const flueWebSocketBasePath = new URL(flueBaseUrl, window.location.origin).pathname;

const flueClient = createFlueClient({
  baseUrl: flueBaseUrl,
  websocketBasePath: flueWebSocketBasePath,
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

  let socket: AgentSocket | null = null;
  let socketSessionId: string | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
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

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing(activeSocket: AgentSocket) {
    stopPing();
    pingTimer = setInterval(() => {
      activeSocket
        .ping()
        .then(() => {
          if (activeSocket === socket) {
            markConnected();
          }
        })
        .catch(() => {
          if (activeSocket !== socket || isDisposed) return;
          socketFailed = true;
          setIsConnected(false);
          setConnectionStatus("degraded");
          setUpstreamStatus("Error");
          cleanupSocket();
        });
    }, 25_000);
  }

  function cleanupSocket() {
    stopPing();
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    if (socket) {
      socket.close(1000, "client cleanup");
      socket = null;
    }
    socketSessionId = null;
    isConnecting = false;
    socketFailed = false;
  }

  function markSocketFailed(activeSocket: AgentSocket | null = socket) {
    if (!activeSocket || activeSocket !== socket) return;
    socketFailed = true;
    cleanupSocket();
  }

  function isSocketConnectionError(message: string) {
    // Flue can report "Request is malformed" when a dev-server restart/HMR leaves
    // the browser holding a stale WebSocket. Treat it as reconnectable once.
    return /websocket|socket|connection|request is malformed/i.test(message);
  }

  async function ensureSocket(): Promise<AgentSocket | null> {
    const sessionId = options.getSessionId();
    if (!sessionId || isDisposed) {
      cleanupSocket();
      setIsConnected(false);
      setConnectionStatus("offline");
      return null;
    }

    if (socket && socketSessionId === sessionId && !socketFailed) {
      try {
        await socket.ready;
        return socket;
      } catch {
        markSocketFailed(socket);
      }
    }

    cleanupSocket();
    isConnecting = true;
    setConnectionStatus("connecting");
    setUpstreamStatus("Connecting");

    const nextSocket = flueClient.agents.connect("pr-reviewer", sessionId);
    socket = nextSocket;
    socketSessionId = sessionId;
    unsubscribeEvents = nextSocket.onEvent((event, context) => {
      handleFlueEvent(event, context.requestId);
    });

    try {
      await nextSocket.ready;
      if (nextSocket !== socket || isDisposed) return null;
      markConnected();
      startPing(nextSocket);
      return nextSocket;
    } catch (err) {
      if (nextSocket !== socket || isDisposed) return null;
      const message = err instanceof Error ? err.message : "Failed to connect to Flue";
      setIsConnected(false);
      setConnectionStatus("offline");
      setUpstreamStatus("Error");
      setError(message);
      options.onError?.(message);
      markSocketFailed(nextSocket);
      return null;
    } finally {
      if (nextSocket === socket) {
        isConnecting = false;
      }
    }
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

      case "message_start":
      case "message_update": {
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

      case "tool_execution_start":
        acceptAssistantEvent(requestId);
        upsertTool({
          id: event.toolCallId,
          tool: event.toolName,
          callId: event.toolCallId,
          status: "running",
          input: isRecord(event.args) ? event.args : {},
          title: event.toolName,
        });
        break;

      case "tool_execution_end":
        acceptAssistantEvent(requestId);
        upsertTool({
          id: event.toolCallId,
          tool: event.toolName,
          callId: event.toolCallId,
          status: event.isError ? "error" : "completed",
          input: {},
          output: event.isError ? undefined : stringifyValue(event.result),
          error: event.isError ? stringifyValue(event.result) : undefined,
          title: event.toolName,
        });
        break;

      case "tool_call":
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
    const activeSocket = await ensureSocket();
    if (!activeSocket) return false;

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

    let promptSocket = activeSocket;
    let didRetrySocket = false;

    while (promptSocket) {
      try {
        // The socket URL already carries the Flue agent instance/session id. Passing
        // `session` here makes Flue build a longer affinity key, which breaks
        // ChatGPT/Codex OAuth because its prompt_cache_key is limited to 64 chars.
        await promptSocket.prompt(message);
        finalizeMessage();
        return true;
      } catch (err) {
        if (abortingPrompt) {
          abortingPrompt = false;
          return false;
        }

        const message = err instanceof Error ? err.message : "Failed to send message";
        const details =
          isRecord(err) && isRecord(err.error) && typeof err.error.details === "string"
            ? err.error.details
            : "";
        if (!didRetrySocket && isSocketConnectionError(`${message} ${details}`)) {
          didRetrySocket = true;
          markSocketFailed(promptSocket);
          const reconnectedSocket = await ensureSocket();
          if (reconnectedSocket) {
            promptSocket = reconnectedSocket;
            continue;
          }
        }

        if (isSocketConnectionError(`${message} ${details}`)) {
          markSocketFailed(promptSocket);
        }

        setError(details ? `${message}: ${details}` : message);
        setIsStreaming(false);
        setAwaitingFirstToken(false);
        awaitingAssistantResponse = false;
        options.onError?.(message);
        return false;
      }
    }

    return false;
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
