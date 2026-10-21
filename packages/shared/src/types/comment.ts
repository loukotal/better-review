/**
 * GitHub user info
 */
export interface GhUser {
  login: string;
  avatar_url: string;
}

/**
 * PR review comment (inline code comment)
 */
export interface PRComment {
  id: number;
  node_id: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  html_url: string;
  user: GhUser;
  created_at: string;
  /** GitHub REST modification time; absent in older cached review-comment records. */
  updated_at?: string;
  /** Comparison head recorded by GitHub, not an authoritative LEFT-side source SHA. */
  commit_id?: string;
  /** Original comparison head for outdated comments; does not record the original base. */
  original_commit_id?: string;
  in_reply_to_id?: number;
  /** Whether the current user can edit/delete this comment */
  canEdit: boolean;
  /** Whether the thread this comment belongs to is resolved */
  isResolved?: boolean;
  /** GraphQL thread node ID (for resolve/unresolve operations) */
  threadId?: string;
  /** Missing/unavailable membership or resolution must not be rendered as unresolved. */
  threadMetadataStatus?: "available" | "unknown";
}

/**
 * Issue comment (top-level PR conversation comment)
 */
export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  user: GhUser;
  created_at: string;
  updated_at: string;
  /** Whether the current user can edit/delete this comment */
  canEdit: boolean;
}
