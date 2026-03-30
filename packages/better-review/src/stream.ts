import type { Event as OpenCodeEvent, ToolState, ToolPart } from "@opencode-ai/sdk/v2";

// Type alias for error data with optional message
type ErrorData = { message?: string } | { [key: string]: unknown };

// =============================================================================
// Simplified Event Types for Frontend
// =============================================================================

export type StreamEvent =
  | {
      type: "text";
      sessionId: string;
      delta: string;
      messageId: string;
      partId: string;
    }
  | {
      type: "reasoning";
      sessionId: string;
      delta: string;
      messageId: string;
      partId: string;
    }
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
  | {
      type: "status";
      sessionId: string;
      status: "busy" | "idle" | "retry";
      message?: string;
    }
  | { type: "error"; sessionId: string; code: string; message: string }
  | { type: "done"; sessionId: string; messageId: string }
  | { type: "connected"; serverTime: number }
  | {
      type: "ping";
      serverTime: number;
      sequence: number;
      upstream: "Disconnected" | "Connecting" | "Connected" | "Reconnecting" | "Error";
      subscribers: number;
    };

// =============================================================================
// Delta Helpers
// =============================================================================

const lastPartText = new Map<string, string>();
const messageRoles = new Map<string, "user" | "assistant">();
const partKinds = new Map<string, string>();

function getDeltaFromFullText(partId: string, text: string): string | null {
  const previous = lastPartText.get(partId) ?? "";

  if (text.startsWith(previous)) {
    const delta = text.slice(previous.length);
    if (!delta) return null;
    lastPartText.set(partId, text);
    return delta;
  }

  lastPartText.set(partId, text);
  return text || null;
}

// =============================================================================
// Event Transformation
// =============================================================================

function transformToolState(
  sessionId: string,
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
        sessionId,
        tool,
        callId,
        input: state.input,
        messageId,
        partId,
      };
    case "running":
      return {
        type: "tool-running",
        sessionId,
        tool,
        callId,
        title: state.title,
        messageId,
        partId,
      };
    case "completed":
      return {
        type: "tool-done",
        sessionId,
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
        sessionId,
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
 * Extract sessionId from an OpenCode event.
 * Returns undefined for global events like server.connected.
 */
function extractSessionId(event: OpenCodeEvent): string | undefined {
  const props = event.properties as Record<string, unknown>;

  switch (event.type) {
    case "message.part.updated":
    case "message.part.removed":
      // sessionID is inside the part object
      return (props.part as { sessionID?: string })?.sessionID;
    case "message.updated":
    case "message.removed":
      // sessionID is inside the info/message object
      return (props.info as { sessionID?: string })?.sessionID;
    case "server.connected":
      // Global event, no sessionID
      return undefined;
    default:
      // Most events (session.status, session.idle, session.error, etc.) have sessionID at top level
      return props.sessionID as string | undefined;
  }
}

/**
 * Transform an OpenCode SDK event into a simplified StreamEvent for the frontend.
 * Returns null if the event should be filtered out (e.g., unknown event types).
 * Events now include sessionId so frontend can filter by session.
 */
export function transformEvent(event: OpenCodeEvent): StreamEvent | null {
  if ((event as { type: string }).type === "message.part.delta") {
    const deltaEvent = event as unknown as {
      properties: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
      };
    };
    const { sessionID, messageID, partID, field, delta } = deltaEvent.properties;
    if (!sessionID || !delta) return null;
    if (field !== "text") return null;

    const role = messageRoles.get(messageID);
    if (role === "user") return null;
    if (role !== "assistant" && role !== undefined) return null;

    const partKind = partKinds.get(partID);
    if (partKind === "reasoning") {
      return {
        type: "reasoning",
        sessionId: sessionID,
        delta,
        messageId: messageID,
        partId: partID,
      };
    }

    return {
      type: "text",
      sessionId: sessionID,
      delta,
      messageId: messageID,
      partId: partID,
    };
  }

  const sessionId = extractSessionId(event);

  switch (event.type) {
    case "message.part.updated": {
      const { part } = event.properties;
      const delta =
        "delta" in event.properties && typeof event.properties.delta === "string"
          ? event.properties.delta
          : undefined;
      partKinds.set(part.id, part.type);

      // Skip events without sessionId (shouldn't happen for message events)
      if (!sessionId) return null;

      const role = messageRoles.get(part.messageID);

      // Skip user message parts (we only stream assistant output)
      if (role === "user") {
        return null;
      }

      // Handle text parts with delta (streaming content)
      if (part.type === "text") {
        if (role !== "assistant" && role !== undefined) {
          return null;
        }
        const textDelta = delta ?? getDeltaFromFullText(part.id, part.text);
        if (delta && typeof part.text === "string") {
          lastPartText.set(part.id, part.text);
        }

        if (!textDelta) return null;
        return {
          type: "text",
          sessionId,
          delta: textDelta,
          messageId: part.messageID,
          partId: part.id,
        };
      }

      // Handle reasoning parts
      if (part.type === "reasoning") {
        if (role !== "assistant" && role !== undefined) {
          return null;
        }
        const textDelta = delta ?? getDeltaFromFullText(part.id, part.text);
        if (delta && typeof part.text === "string") {
          lastPartText.set(part.id, part.text);
        }

        if (!textDelta) return null;
        return {
          type: "reasoning",
          sessionId,
          delta: textDelta,
          messageId: part.messageID,
          partId: part.id,
        };
      }

      // Handle tool parts
      if (part.type === "tool") {
        const toolPart = part as ToolPart;
        return transformToolState(
          sessionId,
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
      if (!sessionId) return null;
      const { status } = event.properties;
      if (status.type === "busy") {
        return { type: "status", sessionId, status: "busy" };
      }
      if (status.type === "idle") {
        return { type: "status", sessionId, status: "idle" };
      }
      if (status.type === "retry") {
        return {
          type: "status",
          sessionId,
          status: "retry",
          message: status.message,
        };
      }
      return null;
    }

    case "session.idle": {
      if (!sessionId) return null;
      return { type: "status", sessionId, status: "idle" };
    }

    case "session.error": {
      if (!sessionId) return null;
      const { error } = event.properties;
      if (!error) {
        return {
          type: "error",
          sessionId,
          code: "unknown",
          message: "Unknown error",
        };
      }

      const errorData = error.data as ErrorData | undefined;
      const errorMessage: string =
        errorData && "message" in errorData && typeof errorData.message === "string"
          ? errorData.message
          : "Unknown error";

      return {
        type: "error",
        sessionId,
        code: error.name,
        message: errorMessage,
      };
    }

    case "message.updated": {
      if (!sessionId) return null;
      const { info } = event.properties;

      if (info?.id && (info.role === "assistant" || info.role === "user")) {
        messageRoles.set(info.id, info.role);
      }

      // When message is completed
      if (info.role === "assistant" && info.time.completed) {
        return { type: "done", sessionId, messageId: info.id };
      }
      return null;
    }

    case "message.removed": {
      const { messageID } = event.properties;
      if (typeof messageID === "string") {
        messageRoles.delete(messageID);
      }
      return null;
    }

    case "message.part.removed": {
      const { partID } = event.properties;
      if (typeof partID === "string") {
        lastPartText.delete(partID);
        partKinds.delete(partID);
      }
      return null;
    }

    case "server.connected": {
      return { type: "connected", serverTime: Date.now() };
    }

    default:
      return null;
  }
}
