import { DEFAULT_GITHUB_QUEUE_TIMEOUT_MS, type GithubOutboxOperation } from "@better-review/shared";

export function queueDeadline(op: GithubOutboxOperation): number {
  return Date.parse(
    op.queueDeadlineAt ??
      op.command.queueDeadlineAt ??
      new Date(
        (Date.parse(op.createdAt) || 0) +
          (op.command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
      ).toISOString(),
  );
}

/** Expiry stops activity, never infers that an inflight write was not applied. */
export function expireOperation(op: GithubOutboxOperation, now: number): boolean {
  if (
    op.archivedAt ||
    op.timedOutAt ||
    ["synced", "cancelled"].includes(op.status) ||
    queueDeadline(op) > now
  )
    return false;
  if (
    op.status === "retry-failed" &&
    !(op.retryMode === "automatic" && op.error?.retryable && op.nextAttemptAt)
  )
    return false;
  const unknown = op.status === "inflight" || op.status === "uncertain";
  op.status = unknown ? "uncertain" : "retry-failed";
  op.retryMode = "blocked";
  op.timedOutAt = new Date(now).toISOString();
  delete op.nextAttemptAt;
  op.error = {
    code: "timeout",
    retryable: false,
    message: unknown
      ? "Queue time limit reached. GitHub may have received this action; confirm delivery before retrying."
      : "Queue time limit reached before delivery. Retry explicitly to start a new timed cycle.",
  };
  return true;
}
