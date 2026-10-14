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
