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

/**
 * Transform an OpenCode SDK event into a simplified StreamEvent for the frontend.
 * Returns null if the event should be filtered out.
 */
export function transformEvent(
  event: OpenCodeEvent,
  sessionId: string,
): StreamEvent | null {
  const props = event.properties as Record<string, unknown>;

  // Extract sessionID based on event type - it's nested differently for each
  let eventSessionId: string | undefined;

  switch (event.type) {
    case "message.part.updated":
    case "message.part.removed":
      // sessionID is inside the part object
      eventSessionId = (props.part as { sessionID?: string })?.sessionID;
      break;
    case "message.updated":
    case "message.removed":
      // sessionID is inside the info/message object
      eventSessionId = (props.info as { sessionID?: string })?.sessionID;
      break;
    case "server.connected":
      // Global event, no sessionID - let it through
      eventSessionId = undefined;
      break;
    default:
      // Most events (session.status, session.idle, session.error, etc.) have sessionID at top level
      eventSessionId = props.sessionID as string | undefined;
  }

  // Filter events that don't belong to this session
  if (eventSessionId && eventSessionId !== sessionId) {
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
