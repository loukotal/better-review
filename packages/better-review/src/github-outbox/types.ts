import type {
  GithubActor,
  GithubOutboxCommand,
  GithubOutboxControl,
  GithubOutboxControlReceipt,
  GithubOutboxError,
  GithubOutboxHeartbeat,
  GithubOutboxOperation,
  GithubOutboxReceipt,
  GithubOutboxSnapshot,
  GithubPrScope,
  GithubRemoteResult,
} from "@better-review/shared";

/** No network on admission. Unknown cached identity rejects, never binds later. */
export interface GithubOutbox {
  enqueue(command: GithubOutboxCommand): Promise<GithubOutboxReceipt>;
  snapshot(scope: GithubPrScope): Promise<GithubOutboxSnapshot>;
  heartbeat(heartbeat: GithubOutboxHeartbeat): Promise<void>;
  control(control: GithubOutboxControl): Promise<GithubOutboxControlReceipt>;
  close(): Promise<void>;
}

export type GithubDispatchOutcome =
  | { outcome: "accepted"; result: GithubRemoteResult }
  /** Proven not applied. Only retryable rejections may be automatically retried. */
  | { outcome: "rejected"; error: GithubOutboxError }
  | { outcome: "uncertain"; error: GithubOutboxError };

export type GithubReconcileOutcome =
  | { outcome: "matched"; result: GithubRemoteResult }
  /** Absence is not permission to replay an uncertain write. */
  | { outcome: "absent" }
  | { outcome: "ambiguous"; candidates: GithubRemoteResult[] }
  | { outcome: "conflict" | "auth"; error: GithubOutboxError };

/** Direct GitHub API only; no browser calls and no gh CLI mutation fallback. */
export interface GithubOutboxAdapter {
  /** Dispatch/reconcile/verify bind expectedActor to the SAME credential snapshot used for HTTP. */
  /** Checks live credentials before every write/read; cached identity is admission-only. */
  identity(options?: {
    signal?: AbortSignal;
  }): Promise<
    { outcome: "known"; actor: GithubActor } | { outcome: "unavailable"; error: GithubOutboxError }
  >;
  /** Local target refs must be resolved by worker before dispatch. Never re-anchor. */
  dispatch(
    operation: GithubOutboxOperation,
    options?: {
      signal?: AbortSignal;
      /** Synchronous fence: invoke immediately before mutation fetch, without an intervening await. Throw to prevent sending. */
      beforeMutation?: () => void;
    },
  ): Promise<GithubDispatchOutcome>;
  reconcile(
    operation: GithubOutboxOperation,
    options?: { signal?: AbortSignal },
  ): Promise<GithubReconcileOutcome>;
  /** Client-supplied results are candidate identities, not trusted evidence of delivery. */
  verifyApplied(
    operation: GithubOutboxOperation,
    candidate: GithubRemoteResult,
    options?: { signal?: AbortSignal },
  ): Promise<GithubReconcileOutcome>;
}
