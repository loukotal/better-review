export interface AppUpdateStatus {
  updateAvailable: boolean;
  currentRevision?: string;
  latestRevision?: string;
  checkoutRevision?: string;
  /** Advice based on the checkout now, not the immutable running revision. */
  updateAction?: "restart" | "fast-forward" | "diverged" | "unknown";
}
