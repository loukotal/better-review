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
