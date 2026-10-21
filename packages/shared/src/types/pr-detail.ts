/** Missing evidence is never represented by an empty successful section. */
export type PrDetailSection<T> =
  | { status: "available"; data: T; complete: boolean }
  | { status: "unavailable"; message: string };
export interface PrDetailActor {
  id: string;
  login: string;
}
export type PrMergeMethod = "merge" | "squash" | "rebase";
export type PrMergeAction =
  | { kind: "merge"; method: PrMergeMethod }
  | { kind: "enqueue" }
  | { kind: "admin-merge"; method: PrMergeMethod };
export interface PrMergeInput {
  url: string;
  requestId: string;
  expectedActor: PrDetailActor;
  expectedHeadSha: string;
  action: PrMergeAction;
}
export interface PrDetailMetadata {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  head: { name: string; sha: string };
  base: { name: string; sha: string };
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: string | null;
}
export interface PrDetailCheck {
  id: string;
  kind: "check-run" | "status-context";
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  appId?: number | null;
}
export interface PrBranchRequirements {
  requiredStatusCheckContexts: string[];
  requiresApprovingReviews: boolean;
  requiresCodeOwnerReviews: boolean;
  requiresConversationResolution: boolean;
  requiredApprovingReviewCount?: number;
  requiredChecks?: { context: string; appId: number | null }[];
  queueRequired?: boolean;
  unsupportedRules?: string[];
  allowedMergeMethods?: PrMergeMethod[];
  requiresLinearHistory?: boolean;
}
export interface PrDetailReview {
  id: string;
  author: string | null;
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
  commitSha: string | null;
}
export interface PrDetailReviewRequest {
  kind: "user" | "team";
  name: string;
}
export interface PrMergeCapabilities {
  allowedMethods: PrMergeMethod[];
  viewerPermission: string | null;
  viewerCanMergeAsAdmin: boolean | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  queueRequired: boolean | null;
  queueEntry: { id: string; position: number | null } | null;
  autoMergeEnabled: boolean | null;
  branchRequirements: PrDetailSection<PrBranchRequirements | null>;
  actions: {
    action: PrMergeAction;
    enabled: boolean;
    reason: string | null;
    reasonCode?: string | null;
  }[];
}
export interface PrDetail {
  url: string;
  fetchedAt: string;
  actor: PrDetailSection<PrDetailActor>;
  metadata: PrDetailSection<PrDetailMetadata>;
  labels: PrDetailSection<{ name: string; color: string; description: string | null }[]>;
  checks: PrDetailSection<PrDetailCheck[]>;
  reviews: PrDetailSection<PrDetailReview[]>;
  reviewRequests: PrDetailSection<PrDetailReviewRequest[]>;
  mergeCapabilities: PrDetailSection<PrMergeCapabilities>;
}
/** Uncertain attempts can only be reconciled, never dispatched again. Observation is not attribution. */
export interface PrMergeAttempt {
  requestId: string;
  url: string;
  expectedHeadSha: string;
  action: PrMergeAction;
  status: "rejected" | "uncertain" | "succeeded";
  message: string;
  dispatched: boolean;
  updatedAt: string;
  observed?: { state: "OPEN" | "CLOSED" | "MERGED"; headSha: string; queued: boolean | null };
}
