/**
 * A stored session for a PR review
 */
export interface StoredSession {
  /** OpenCode session ID */
  id: string;
  /** Git SHA at session creation */
  headSha: string;
  /** Unix timestamp in milliseconds */
  createdAt: number;
  /** Whether the session is hidden (soft-deleted) */
  hidden: boolean;
}

/**
 * Persistent data for a PR's review sessions
 */
export interface PrSessionData {
  owner: string;
  repo: string;
  number: number;
  url: string;
  sessions: StoredSession[];
  activeSessionId: string | null;
}

export type ReviewSessionMode = "plan" | "message" | "diff";

export type ReviewSessionStatus = "pending" | "approved" | "feedback" | "cancelled";

export type ReviewSessionPayload =
  | { kind: "markdown"; content: string }
  | { kind: "message"; content: string }
  | { kind: "diff"; rawPatch: string; label?: string };

export interface ReviewSessionReturnChannel {
  type: "stdout" | "http";
  endpoint?: string;
}

export interface ReviewSession {
  id: string;
  mode: ReviewSessionMode;
  origin: "pi" | "opencode" | "manual" | string;
  title: string;
  cwd?: string;
  repoRoot?: string;
  createdAt: number;
  status: ReviewSessionStatus;
  payload: ReviewSessionPayload;
  returnChannel?: ReviewSessionReturnChannel;
}

export interface ReviewSessionAnnotation {
  id: string;
  quote: string;
  comment: string;
  createdAt: number;
  kind?: "selection" | "file" | "line-range";
  filePath?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  side?: "LEFT" | "RIGHT";
}

export interface ReviewSessionResult {
  sessionId: string;
  mode: ReviewSessionMode;
  approved: boolean;
  feedback: string;
  annotations: ReviewSessionAnnotation[];
  submittedAt: number;
}
