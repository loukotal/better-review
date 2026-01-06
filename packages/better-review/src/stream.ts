import { Console, Effect, Stream, Queue, Data, Option, Fiber } from "effect";
import type {
  Event as OpenCodeEvent,
  ToolState,
  ToolPart,
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
  partId: string,
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
  sessionId: string,
): StreamEvent | null {
  // Filter events for this session
  const props = event.properties as Record<string, unknown>;

  // Check if event belongs to this session
  if ("sessionID" in props && props.sessionID !== sessionId) {
    console.log(
      `[transformEvent] FILTERED: sessionID mismatch (event: ${props.sessionID}, expected: ${sessionId})`,
    );
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
          part.id,
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
      const errorMessage: string =
        errorData &&
        "message" in errorData &&
        typeof errorData.message === "string"
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
// OpenCode Event Stream (Server-side with fetch)
// =============================================================================

/**
 * Creates an Effect Stream that connects to OpenCode's SSE endpoint
 * and emits transformed events for a specific session.
 */
export function createOpenCodeStream(
  baseUrl: string,
  sessionId: string,
): Stream.Stream<StreamEvent, StreamError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const eventUrl = `${baseUrl}/event`;
      yield* Effect.log(`[SSE] Connecting to OpenCode: ${eventUrl}`);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(eventUrl, { headers: { Accept: "text/event-stream" } }),
        catch: (cause) =>
          new StreamError({ cause, message: "Failed to connect to OpenCode" }),
      });

      if (!response.ok || !response.body) {
        return yield* Effect.fail(
          new StreamError({
            cause: null,
            message: `Failed to connect: ${response.status}`,
          }),
        );
      }

      yield* Effect.log(`[SSE] Connection established, starting stream`);

      // Create a stream from the response body
      const byteStream = Stream.fromReadableStream<Uint8Array, StreamError>(
        () => response.body!,
        (cause) => new StreamError({ cause, message: "Stream read error" }),
      );

      // Track which text messages we've logged (to avoid spam)
      const loggedTextMessages = new Set<string>();
      let eventCount = 0;

      const eventStream: Stream.Stream<StreamEvent, StreamError> =
        byteStream.pipe(
          // Decode bytes to text
          Stream.decodeText(),
          // Parse SSE lines
          Stream.mapAccum("", (buffer, chunk) => {
            const combined = buffer + chunk;
            const lines = combined.split("\n");
            // Keep the last incomplete line in the buffer
            const newBuffer = lines.pop() || "";
            return [newBuffer, lines] as const;
          }),
          Stream.flatMap((lines) => Stream.fromIterable(lines)),
          // Filter and parse data lines
          Stream.filter((line) => line.startsWith("data: ")),
          Stream.map((line) => line.slice(6)),
          Stream.filterMap((data) => {
            try {
              eventCount++;
              const event = JSON.parse(data) as OpenCodeEvent;

              // Log first 10 raw events for debugging
              if (eventCount <= 10) {
                console.log(
                  `[SSE] Raw event #${eventCount}: type=${event.type}`,
                  event.type === "message.part.updated"
                    ? `part.type=${(event.properties as { part?: { type?: string } })?.part?.type}, delta=${!!(event.properties as { delta?: string })?.delta}`
                    : "",
                );
              }

              const transformed = transformEvent(event, sessionId);

              if (!transformed && eventCount <= 10) {
                console.log(
                  `[SSE] Event #${eventCount} filtered out (returned null)`,
                );
              }

              return transformed ? Option.some(transformed) : Option.none();
            } catch (e) {
              console.error(`[SSE] Parse error:`, e);
              return Option.none();
            }
          }),
          // Log emitted events for debugging
          Stream.tap((event) => {
            // Skip reasoning entirely
            if (event.type === "reasoning") return Effect.void;

            // Log text only once per message
            if (event.type === "text") {
              if (loggedTextMessages.has(event.messageId)) return Effect.void;
              loggedTextMessages.add(event.messageId);
              return Console.log(
                `[SSE->FE] EMIT text started (message: ${event.messageId})`,
              );
            }

            // Log status events explicitly
            if (event.type === "status") {
              return Console.log(`[SSE->FE] EMIT status: ${event.status}`);
            }

            // Log errors with full details
            if (event.type === "error") {
              return Console.error("[SSE->FE] EMIT error:", event);
            }

            // Log everything else
            return Console.log(`[SSE->FE] EMIT ${event.type}`);
          }),
        );

      // Prepend connected event
      const connectedEvent: StreamEvent = { type: "connected" };
      return Stream.concat(Stream.make(connectedEvent), eventStream);
    }),
  );
}

// =============================================================================
// SSE Response Helper for Bun
// =============================================================================

/**
 * Converts an Effect Stream of events into an SSE Response.
 * Handles error events and cleanup automatically.
 */
export function streamToSSEResponse(
  stream: Stream.Stream<StreamEvent, StreamError>,
): Response {
  const encoder = new TextEncoder();

  // Convert the Effect Stream to a web ReadableStream
  const readable = Stream.toReadableStream(
    Stream.concat(
      // Start with connection comment
      Stream.make(encoder.encode(formatSSEComment("connected"))),
      // Then the actual events
      stream.pipe(
        // Format each event as SSE
        Stream.map((event) => encoder.encode(formatSSE(event))),
        // Handle errors by sending error event then ending
        Stream.catchAll((error) =>
          Stream.make(
            encoder.encode(
              formatSSE({
                type: "error",
                code: "stream_error",
                message: error.message,
              }),
            ),
          ),
        ),
      ),
    ),
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
