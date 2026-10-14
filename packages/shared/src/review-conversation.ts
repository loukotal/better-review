/** App-owned wire format. Durable engine details stay on the server. */
export type ReviewPart =
  | { type: "text" | "reasoning"; text: string }
  | {
      type: "dynamic-tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      state: "input-available" | "output-available" | "output-error";
      output?: string;
      errorText?: string;
    };

export type ReviewMessage = {
  id: string;
  role: "user" | "assistant";
  submissionId?: string;
  parts: ReviewPart[];
  metadata: { timestamp: string; revision?: string };
};

export type ReviewSettlement = {
  submissionId: string;
  outcome: "completed" | "failed" | "aborted";
  error?: string;
};

export type ReviewSnapshot = {
  sessionId: string;
  messages: ReviewMessage[];
  settlements: ReviewSettlement[];
  running: boolean;
  compacting: boolean;
  revision?: string;
  usage?: { input: number; output: number; cost: number };
};

/** Ordered patch; reconnects always begin with a complete snapshot. */
export type ReviewUpdate = {
  baseVersion: number;
  version: number;
  state: Omit<ReviewSnapshot, "messages">;
  messages: { start: number; deleteCount: number; items: ReviewMessage[] };
};

export function applyReviewUpdate(
  current: ReviewSnapshot,
  version: number,
  update: ReviewUpdate,
): ReviewSnapshot {
  const { start, deleteCount, items } = update.messages;
  if (
    update.baseVersion !== version ||
    update.version !== version + 1 ||
    update.state.sessionId !== current.sessionId ||
    !Number.isInteger(start) ||
    !Number.isInteger(deleteCount) ||
    start < 0 ||
    deleteCount < 0 ||
    start + deleteCount > current.messages.length
  )
    throw new Error("Review stream is out of sync; reconnecting…");
  return {
    ...update.state,
    messages: [
      ...current.messages.slice(0, start),
      ...items,
      ...current.messages.slice(start + deleteCount),
    ],
  };
}
