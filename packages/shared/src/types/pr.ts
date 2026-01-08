/**
 * Basic PR identification info
 */
export interface PrInfo {
  owner: string;
  repo: string;
  number: string;
}

/**
 * PR state (open, closed, or merged)
 */
export type PrState = "open" | "closed" | "merged";

/**
 * Review state for a PR
 */
export type ReviewState =
  | "PENDING"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | null;

/**
 * CI check run status
 */
export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
}

/**
 * Full PR status including checks
 */
export interface PrStatus {
  state: PrState;
  draft: boolean;
  mergeable: boolean | null;
  title: string;
  body: string;
  author: string;
  url: string;
  headRef: string;
  checks: readonly CheckRun[];
}

/**
 * CI status summary
 */
export interface CiStatus {
  passed: number;
  total: number;
  state: "SUCCESS" | "FAILURE" | "PENDING" | "EXPECTED" | "ERROR" | "NEUTRAL";
}

/**
 * PR from search results
 */
export interface SearchedPr {
  number: number;
  title: string;
  url: string;
  repository: { name: string; nameWithOwner: string };
  author: { login: string };
  createdAt: string;
  isDraft: boolean;
  myReviewState: ReviewState;
  isAuthor: boolean;
  reviewRequested: boolean;
  additions: number;
  deletions: number;
  ciStatus: CiStatus | null;
}
