import { createSignal, onCleanup, createEffect, batch } from "solid-js";

import { trpc } from "../lib/trpc";

// =============================================================================
// Types (matches backend StreamEvent)
// =============================================================================

export type StreamEvent =
  | { type: "text"; sessionId: string; delta: string; messageId: string; partId: string }
  | { type: "reasoning"; sessionId: string; delta: string; messageId: string; partId: string }
  | {
      type: "tool-start";
      sessionId: string;
      tool: string;
      callId: string;
      input: Record<string, unknown>;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-running";
      sessionId: string;
      tool: string;
      callId: string;
      title?: string;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-done";
      sessionId: string;
      tool: string;
      callId: string;
      output: string;
      title: string;
      messageId: string;
      partId: string;
    }
  | {
      type: "tool-error";
      sessionId: string;
      tool: string;
      callId: string;
      error: string;
      messageId: string;
      partId: string;
    }
  | { type: "status"; sessionId: string; status: "busy" | "idle" | "retry"; message?: string }
  | { type: "error"; sessionId: string; code: string; message: string }
  | { type: "done"; sessionId: string; messageId: string }
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
  const [currentMessageId, setCurrentMessageId] = createSignal<string | null>(null);

  let unsubscribe: (() => void) | null = null;

  // Single SSE connection - subscribe once on mount, filter by sessionId client-side
  // This avoids the cleanup issues with per-session subscriptions
  createEffect(() => {
    // Only subscribe once
    if (unsubscribe) return;

    console.log("[useStreamingChat] Connecting to event stream");

    // Subscribe to ALL events (no session filter)
    const subscription = trpc.opencode.events.subscribe(undefined, {
      onStarted: () => {
        console.log("[useStreamingChat] Subscription started");
      },
      onData: (event) => {
        handleEvent(event as StreamEvent);
      },
      onError: (err) => {
        console.error("[useStreamingChat] Subscription error:", err);
        setIsConnected(false);
        setError("Connection lost");
        options.onError?.("Connection lost");
      },
      onComplete: () => {
        console.log("[useStreamingChat] Subscription completed");
        setIsConnected(false);
      },
    });

    unsubscribe = subscription.unsubscribe;
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (unsubscribe) {
      console.log("[useStreamingChat] Disconnecting from event stream");
      unsubscribe();
      unsubscribe = null;
    }
  });

  // Reset streaming state when session changes
  createEffect(() => {
    const _sessionId = options.getSessionId();
    // Reset streaming state for new session
    batch(() => {
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTools([]);
      setCurrentMessageId(null);
      setIsStreaming(false);
    });
  });

  function handleEvent(event: StreamEvent) {
    // Handle global events (no sessionId filtering needed)
    if (event.type === "connected") {
      console.log("[useStreamingChat] Connected to event stream");
      setIsConnected(true);
      setError(null);
      return;
    }

    // Filter events by current sessionId (client-side filtering)
    const currentSessionId = options.getSessionId();
    if (!currentSessionId) return;

    // All other events have sessionId - filter by current session
    if ("sessionId" in event && event.sessionId !== currentSessionId) {
      return; // Event is for a different session, ignore it
    }

    switch (event.type) {
      case "text":
        // Append streaming text
        setStreamingContent((prev) => prev + event.delta);
        if (!currentMessageId()) {
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
            t.callId === event.callId ? { ...t, status: "error" as const, error: event.error } : t,
          ),
        );
        break;

      case "status":
        if (event.status === "busy") {
          setIsStreaming(true);
        } else if (event.status === "idle") {
          finalizeMessage();
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

    if (!content && !reasoning && tools.length === 0) {
      // Nothing to finalize
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

  /**
   * Wait for the SSE subscription to be connected with a timeout.
   * Returns true if connected, false if timed out.
   */
  async function waitForConnection(timeoutMs: number = 5000): Promise<boolean> {
    if (isConnected()) return true;

    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (isConnected()) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - startTime >= timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 50);
    });
  }

  async function sendMessage(message: string, agent?: string): Promise<boolean> {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      setError("No session");
      return false;
    }

    // Wait for SSE subscription to be ready before sending
    // This prevents a race condition where events are published before we're subscribed
    const connected = await waitForConnection(5000);
    if (!connected) {
      console.warn("[useStreamingChat] Timed out waiting for connection, proceeding anyway");
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
      await trpc.opencode.promptStart.mutate({
        sessionId,
        message,
        agent,
      });

      // Success - streaming will happen via subscription
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to send message";
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
      await trpc.opencode.abort.mutate({ sessionId });
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
