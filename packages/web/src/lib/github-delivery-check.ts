import type { GithubOutboxOperation } from "@better-review/shared";

export type GithubDeliveryCheckOutcome = "pending" | "confirmed" | "unconfirmed" | "failed";

/** A scheduling receipt carries the old error and an immediately-due attempt.
 * Only the worker's later revision and settled result describe this check. */
export function githubDeliveryCheckOutcome(
  ackRevision: number,
  operation?: GithubOutboxOperation,
): GithubDeliveryCheckOutcome {
  if (!operation || operation.revision <= ackRevision) return "pending";
  if (operation.status === "synced") return "confirmed";
  if (operation.status !== "uncertain") return "failed";
  if (
    operation.nextAttemptAt &&
    Date.parse(operation.nextAttemptAt) <= Date.parse(operation.updatedAt)
  )
    return "pending";
  return operation.error?.code === "conflict" ? "unconfirmed" : "failed";
}
