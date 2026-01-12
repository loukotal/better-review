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
  path: string;
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  html_url: string;
  user: GhUser;
  created_at: string;
  in_reply_to_id?: number;
  /** Whether the current user can edit/delete this comment */
  canEdit: boolean;
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
