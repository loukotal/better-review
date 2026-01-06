import type { GhUser } from "./comment";

/**
 * PR commit info
 */
export interface PrCommit {
  sha: string;
  message: string;
  author: GhUser;
  date: string;
}
