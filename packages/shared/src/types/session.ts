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

export interface ReviewSessionDiffVariant {
  id: string;
  label: string;
  description?: string;
  baseRef?: string;
  commit?: { sha: string; message: string };
  /** Commits included in this comparison, newest first. */
  commits?: Array<{ sha: string; message: string }>;
  rawPatch: string;
  contentSource?:
    | { kind: "working-tree"; baseSha: string }
    | { kind: "unstaged"; headSha?: string | null }
    | { kind: "staged"; headSha?: string | null }
    | { kind: "commit"; baseSha: string; headSha: string }
    | { kind: "git-refs"; baseSha: string; headSha: string };
}

export type ReviewSessionPayload =
  | { kind: "markdown"; content: string }
  | { kind: "message"; content: string }
  | {
      kind: "diff";
      rawPatch: string;
      label?: string;
      selectedVariantId?: string;
      variants?: ReviewSessionDiffVariant[];
    };

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
  /** Branch at creation time; null denotes a detached HEAD. */
  branch?: string | null;
  createdAt: number;
  status: ReviewSessionStatus;
  payload: ReviewSessionPayload;
  returnChannel?: ReviewSessionReturnChannel;
}

export interface ReviewSessionAnnotation {
  id: string;
  inReplyToId?: string;
  quote: string;
  comment: string;
  createdAt: number;
  kind?: "selection" | "file" | "line-range";
  startOffset?: number;
  endOffset?: number;
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
  /** The review ended without a verdict (for example, its tab was closed). */
  cancelled?: boolean;
  feedback: string;
  annotations: ReviewSessionAnnotation[];
  submittedAt: number;
}
