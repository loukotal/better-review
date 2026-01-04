/**
 * GitHub user info
 */
export interface GhUser {
  login: string;
  avatar_url: string;
}

/**
 * PR review comment
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
}
