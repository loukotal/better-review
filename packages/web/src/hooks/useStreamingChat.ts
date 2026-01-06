import { createSignal, onCleanup, createEffect, batch } from "solid-js";

// =============================================================================
// Types (matches backend StreamEvent)
// =============================================================================

export type StreamEvent =
  | { type: "text"; delta: string; messageId: string; partId: string }
  | { type: "reasoning"; delta: string; messageId: string; partId: string }
  | {
      type: "tool-start";
      tool: string;
      callId: string;
      input: Record<string, unknown>;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-running";
      tool: string;
      callId: string;
      title?: string;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-done";
      tool: string;
      callId: string;
      output: string;
      title: string;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-error";
      tool: string;
      callId: string;
      error: string;
      messageId: string;
      partId: string;
    }
  | { type: "status"; status: "busy" | "idle" | "retry"; message?: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; messageId: string }
  | { type: "connected" };

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

// =============================================================================
// Hook
// =============================================================================

export interface UseStreamingChatOptions {
  /** Accessor function that returns the session ID (for reactivity) */
  getSessionId: () => string | null;
  onError?: (error: string) => void;
}

export function useStreamingChat(options: UseStreamingChatOptions) {
  const [messages, setMessages] = createSignal<StreamingMessage[]>([]);
  const [isConnected, setIsConnected] = createSignal(false);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streamingContent, setStreamingContent] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [activeTools, setActiveTools] = createSignal<ToolCall[]>([]);
  const [currentMessageId, setCurrentMessageId] = createSignal<string | null>(
    null,
  );

  let eventSource: EventSource | null = null;

  // Connect to SSE when sessionId changes
  createEffect(() => {
    const sessionId = options.getSessionId();

    // Cleanup previous connection
    if (eventSource) {
      eventSource.close();
      eventSource = null;
      setIsConnected(false);
    }

    if (!sessionId) {
      return;
    }

    console.log(`[useStreamingChat] Connecting to session: ${sessionId}`);

    const url = `/api/opencode/events?sessionId=${encodeURIComponent(sessionId)}`;
    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      console.log("[useStreamingChat] SSE connected");
      setIsConnected(true);
      setError(null);
    };

    eventSource.onerror = (err) => {
      console.error("[useStreamingChat] SSE error:", err);
      setIsConnected(false);

      // Don't set error immediately - EventSource will auto-reconnect
      if (eventSource?.readyState === EventSource.CLOSED) {
        setError("Connection lost");
        options.onError?.("Connection lost");
      }
    };

    let eventCount = 0;
    eventSource.onmessage = (msg) => {
      try {
        eventCount++;
        const event = JSON.parse(msg.data) as StreamEvent;

        // Log first 15 events with timing for debugging
        if (eventCount <= 15) {
          const now = performance.now().toFixed(1);
          console.log(
            `[useStreamingChat] Event #${eventCount} @${now}ms: type=${event.type}`,
            event.type === "text"
              ? `delta.len=${event.delta.length}`
              : event.type === "status"
                ? `status=${event.status}`
                : "",
          );
        }

        handleEvent(event);
      } catch (e) {
        console.error("[useStreamingChat] Failed to parse event:", e);
      }
    };
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  });

  function handleEvent(event: StreamEvent) {
    switch (event.type) {
      case "connected":
        console.log("[useStreamingChat] Connected to event stream");
        break;

      case "text":
        // Append streaming text
        setStreamingContent((prev) => {
          const newContent = prev + event.delta;
          // Log first text content for debugging
          if (prev.length === 0) {
            console.log(
              `[useStreamingChat] FIRST TEXT: "${event.delta.slice(0, 50)}..."`,
            );
          }
          return newContent;
        });
        if (!currentMessageId()) {
          console.log(
            `[useStreamingChat] Setting currentMessageId: ${event.messageId}`,
          );
          setCurrentMessageId(event.messageId);
        }
        break;

      case "reasoning":
        // Append reasoning text
        setStreamingReasoning((prev) => prev + event.delta);
        break;

      case "tool-start":
        setActiveTools((prev) => [
          ...prev,
          {
            id: event.partId,
            tool: event.tool,
            callId: event.callId,
            status: "pending",
            input: event.input,
          },
        ]);
        break;

      case "tool-running":
        setActiveTools((prev) =>
          prev.map((t) =>
            t.callId === event.callId
              ? { ...t, status: "running" as const, title: event.title }
              : t,
          ),
        );
        break;

      case "tool-done":
        setActiveTools((prev) =>
          prev.map((t) =>
            t.callId === event.callId
              ? {
                  ...t,
                  status: "completed" as const,
                  output: event.output,
                  title: event.title,
                }
              : t,
          ),
        );
        break;

      case "tool-error":
        setActiveTools((prev) =>
          prev.map((t) =>
            t.callId === event.callId
              ? { ...t, status: "error" as const, error: event.error }
              : t,
          ),
        );
        break;

      case "status":
        if (event.status === "busy") {
          console.log(`[useStreamingChat] STATUS: busy -> setIsStreaming(true)`);
          setIsStreaming(true);
        } else if (event.status === "idle") {
          console.log(
            `[useStreamingChat] STATUS: idle -> finalizeMessage (content.len=${streamingContent().length})`,
          );
          // Finalize the current message
          finalizeMessage();
        } else if (event.status === "retry") {
          console.log("[useStreamingChat] Retry:", event.message);
        }
        break;

      case "done":
        // Message completed - finalize it
        finalizeMessage();
        break;

      case "error":
        setError(event.message);
        options.onError?.(event.message);
        setIsStreaming(false);
        break;
    }
  }

  function finalizeMessage() {
    const content = streamingContent();
    const reasoning = streamingReasoning();
    const tools = activeTools();
    const msgId = currentMessageId();

    console.log(
      `[useStreamingChat] finalizeMessage: content.len=${content.length}, reasoning.len=${reasoning.length}, tools=${tools.length}, msgId=${msgId}`,
    );

    if (!content && !reasoning && tools.length === 0) {
      // Nothing to finalize
      console.log(`[useStreamingChat] Nothing to finalize, skipping`);
      setIsStreaming(false);
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

      // Reset streaming state
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setIsStreaming(false);
    });
  }

  async function sendMessage(
    message: string,
    agent?: string,
  ): Promise<boolean> {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      setError("No session");
      return false;
    }

    // Add user message immediately
    const userMessage: StreamingMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      toolCalls: [],
      isStreaming: false,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch("/api/opencode/prompt-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message,
          agent,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Success - streaming will happen via SSE
      return true;
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to send message";
      setError(errorMsg);
      setIsStreaming(false);
      options.onError?.(errorMsg);
      return false;
    }
  }

  async function abort(): Promise<void> {
    const sessionId = options.getSessionId();
    if (!sessionId) return;

    try {
      await fetch("/api/opencode/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch (err) {
      console.error("[useStreamingChat] Abort error:", err);
    }
  }

  function clearMessages() {
    setMessages([]);
    setStreamingContent("");
    setStreamingReasoning("");
    setActiveTools([]);
    setCurrentMessageId(null);
    setError(null);
  }

  /**
   * Load existing messages (e.g., when switching sessions)
   */
  function loadExistingMessages(msgs: StreamingMessage[]) {
    batch(() => {
      setMessages(msgs);
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setError(null);
    });
  }

  return {
    // State
    messages,
    isConnected,
    isStreaming,
    error,
    streamingContent,
    streamingReasoning,
    activeTools,

    // Actions
    sendMessage,
    abort,
    clearMessages,
    loadExistingMessages,
  };
}
