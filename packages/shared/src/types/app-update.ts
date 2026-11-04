export interface AppUpdateStatus {
  updateAvailable: boolean;
  currentRevision?: string;
  latestRevision?: string;
  checkoutRevision?: string;
  /** Advice based on the checkout now, not the immutable running revision. */
  updateAction?: "restart" | "fast-forward" | "diverged" | "unknown";
  oneClickUpdate?: boolean;
}

export type AppUpdatePhase =
  | "preparing"
  | "fetching"
  | "installing"
  | "building"
  | "restarting"
  | "ready"
  | "failed";

export interface AppUpdateJob {
  id: string;
  phase: AppUpdatePhase;
  startedAt: number;
  targetRevision: string;
  previousInstanceId?: string;
  error?: string;
}

export interface AppUpdateControl {
  supported: boolean;
  instanceId: string;
  job?: AppUpdateJob;
}
