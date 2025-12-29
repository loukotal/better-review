import { Effect, Stream, Queue, Data, Option, Fiber } from "effect";
import type {
  Event as OpenCodeEvent,
  Part,
  ToolState,
  SessionStatus,
  TextPart,
  ToolPart,
  ReasoningPart,
} from "@opencode-ai/sdk";

// Type alias for error data with optional message
type ErrorData = { message?: string } | { [key: string]: unknown };

// =============================================================================
// Simplified Event Types for Frontend
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

// =============================================================================
// Error Types
// =============================================================================

export class StreamError extends Data.TaggedError("StreamError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly cause: unknown;
}> {}

// =============================================================================
// Event Transformation
// =============================================================================

function transformToolState(
  tool: string,
  callId: string,
  state: ToolState,
  messageId: string,
  partId: string
): StreamEvent | null {
  switch (state.status) {
    case "pending":
      return {
        type: "tool-start",
        tool,
        callId,
        input: state.input,
        messageId,
        partId,
      };
    case "running":
      return {
        type: "tool-running",
        tool,
        callId,
        title: state.title,
        messageId,
        partId,
      };
    case "completed":
      return {
        type: "tool-done",
        tool,
        callId,
        output: state.output,
        title: state.title,
        messageId,
        partId,
      };
    case "error":
      return {
        type: "tool-error",
        tool,
        callId,
        error: state.error,
        messageId,
        partId,
      };
    default:
      return null;
  }
}

export function transformEvent(
  event: OpenCodeEvent,
  sessionId: string
): StreamEvent | null {
  // Filter events for this session
  const props = event.properties as Record<string, unknown>;

  // Check if event belongs to this session
  if ("sessionID" in props && props.sessionID !== sessionId) {
    return null;
  }

  switch (event.type) {
    case "message.part.updated": {
      const { part, delta } = event.properties;

      // Handle text parts with delta (streaming content)
      if (part.type === "text" && delta) {
        return {
          type: "text",
          delta,
          messageId: part.messageID,
          partId: part.id,
        };
      }

      // Handle reasoning parts
      if (part.type === "reasoning" && delta) {
        return {
          type: "reasoning",
          delta,
          messageId: part.messageID,
          partId: part.id,
        };
      }

      // Handle tool parts
      if (part.type === "tool") {
        const toolPart = part as ToolPart;
        return transformToolState(
          toolPart.tool,
          toolPart.callID,
          toolPart.state,
          part.messageID,
          part.id
        );
      }

      return null;
    }

    case "session.status": {
      const { status } = event.properties;
      if (status.type === "busy") {
        return { type: "status", status: "busy" };
      }
      if (status.type === "idle") {
        return { type: "status", status: "idle" };
      }
      if (status.type === "retry") {
        return {
          type: "status",
          status: "retry",
          message: status.message,
        };
      }
      return null;
    }

    case "session.idle": {
      return { type: "status", status: "idle" };
    }

    case "session.error": {
      const { error } = event.properties;
      if (!error) {
        return { type: "error", code: "unknown", message: "Unknown error" };
      }

      const errorData = error.data as ErrorData | undefined;
      const errorMessage: string = (errorData && "message" in errorData && typeof errorData.message === "string") 
        ? errorData.message 
        : "Unknown error";
      
      return {
        type: "error",
        code: error.name,
        message: errorMessage,
      };
    }

    case "message.updated": {
      const { info } = event.properties;
      // When message is completed
      if (info.role === "assistant" && info.time.completed) {
        return { type: "done", messageId: info.id };
      }
      return null;
    }

    case "server.connected": {
      return { type: "connected" };
    }

    default:
      return null;
  }
}

// =============================================================================
// SSE Formatting
// =============================================================================

export function formatSSE(event: StreamEvent): string {
  const data = JSON.stringify(event);
  return `data: ${data}\n\n`;
}

export function formatSSEComment(comment: string): string {
  return `: ${comment}\n\n`;
}

// =============================================================================
// OpenCode Event Stream Connection
// =============================================================================

export interface OpenCodeEventSource {
  readonly subscribe: (
    sessionId: string
  ) => Stream.Stream<StreamEvent, StreamError>;
  readonly close: () => Effect.Effect<void>;
}

/**
 * Creates a persistent connection to OpenCode's event stream.
 * Returns a service that can be used to subscribe to events for specific sessions.
 */
export function createEventSource(
  baseUrl: string
): Effect.Effect<OpenCodeEventSource, ConnectionError> {
  return Effect.gen(function* () {
    // Create a queue to distribute events to multiple subscribers
    const subscribers = new Map<
      string,
      Queue.Queue<StreamEvent | null>
    >();

    let eventSource: EventSource | null = null;
    let connected = false;

    const connect = () =>
      Effect.async<void, ConnectionError>((resume) => {
        if (eventSource) {
          resume(Effect.void);
          return;
        }

        const url = `${baseUrl}/event`;
        console.log(`[Stream] Connecting to OpenCode events: ${url}`);

        eventSource = new EventSource(url);

        eventSource.onopen = () => {
          console.log("[Stream] Connected to OpenCode event stream");
          connected = true;
          resume(Effect.void);
        };

        eventSource.onerror = (err) => {
          console.error("[Stream] EventSource error:", err);
          if (!connected) {
            resume(Effect.fail(new ConnectionError({ cause: err })));
          }
          // If already connected, the browser will auto-reconnect
        };

        eventSource.onmessage = (msg) => {
          try {
            const event = JSON.parse(msg.data) as OpenCodeEvent;

            // Distribute to all subscribers
            for (const [sessionId, queue] of subscribers) {
              const transformed = transformEvent(event, sessionId);
              if (transformed) {
                // Fire and forget - don't block on slow consumers
                Effect.runPromise(Queue.offer(queue, transformed)).catch(() => {
                  // Queue might be full or closed
                });
              }
            }
          } catch (e) {
            console.error("[Stream] Failed to parse event:", e);
          }
        };
      });

    // Connect immediately
    yield* connect();

    const subscribe = (sessionId: string): Stream.Stream<StreamEvent, StreamError> => {
      return Stream.unwrapScoped(
        Effect.gen(function* () {
          // Create a queue for this subscriber
          const queue = yield* Queue.bounded<StreamEvent | null>(100);

          // Register subscriber
          subscribers.set(sessionId, queue);

          // Send initial connected event
          yield* Queue.offer(queue, { type: "connected" } as StreamEvent);

          // Cleanup on scope end
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subscribers.delete(sessionId);
              Effect.runSync(Queue.shutdown(queue));
            })
          );

          // Stream from queue until null
          return Stream.fromQueue(queue).pipe(
            Stream.takeWhile((event): event is StreamEvent => event !== null)
          );
        })
      );
    };

    const close = (): Effect.Effect<void> =>
      Effect.sync(() => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
          connected = false;
        }
        // Signal all subscribers to close
        for (const [_, queue] of subscribers) {
          Effect.runSync(Queue.offer(queue, null));
        }
        subscribers.clear();
      });

    return { subscribe, close };
  });
}

// =============================================================================
// SSE Response Helper for Bun
// =============================================================================

export function createSSEResponse(
  stream: Stream.Stream<StreamEvent, StreamError>,
  signal?: AbortSignal
): Response {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      // Send initial comment to establish connection
      controller.enqueue(encoder.encode(formatSSEComment("connected")));

      const fiber = Effect.runFork(
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              const data = formatSSE(event);
              controller.enqueue(encoder.encode(data));
            })
          ),
          Stream.runDrain,
          Effect.catchAll((error) =>
            Effect.sync(() => {
              const errorEvent: StreamEvent = {
                type: "error",
                code: "stream_error",
                message: error.message,
              };
              controller.enqueue(encoder.encode(formatSSE(errorEvent)));
              controller.close();
            })
          )
        )
      );

      // Handle abort signal
      if (signal) {
        signal.addEventListener("abort", () => {
          Effect.runFork(Fiber.interrupt(fiber));
          controller.close();
        });
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
