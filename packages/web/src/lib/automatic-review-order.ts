import type { ReviewSnapshot } from "@better-review/shared";

import { parseReviewTokens } from "../utils/parseReviewTokens";

export const AUTO_ORDER_PREFERENCE_KEY = "better-review:automatic-review-order";
const APPLIED_KEY = "better-review:applied-review-orders";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export function loadAutomaticReviewOrder(storage?: StorageAccess): boolean {
  try {
    const value = JSON.parse(
      (storage ?? localStorage).getItem(AUTO_ORDER_PREFERENCE_KEY) ?? "null",
    );
    return value?.version === 1 && value.enabled === true;
  } catch {
    return false;
  }
}

export function saveAutomaticReviewOrder(enabled: boolean, storage?: StorageAccess) {
  try {
    (storage ?? localStorage).setItem(
      AUTO_ORDER_PREFERENCE_KEY,
      JSON.stringify({ version: 1, enabled }),
    );
  } catch {}
}

export interface AvailableReviewOrder {
  prUrl: string;
  sessionId: string;
  revision: string;
  mode: "full" | "commit";
  messageId: string;
  files: string[];
}

export interface SavedReviewOrderScope {
  sessionId: string;
  mode: "full" | "commit";
  commitSha: string | null;
  /** null means conversion is saved but continuation admission is still pending. */
  afterSubmissionId?: string | null;
}

/** Never infer provenance from the displayed diff or consume the live assistant tail. */
export function availableReviewOrder(
  snapshot: ReviewSnapshot | null,
  scope: { prUrl: string; sessionId: string; revision: string; mode: "full" | "commit" },
  savedScope: SavedReviewOrderScope | null,
): AvailableReviewOrder | null {
  if (
    !savedScope ||
    savedScope.sessionId !== scope.sessionId ||
    savedScope.mode !== scope.mode ||
    (scope.mode === "commit"
      ? savedScope.commitSha !== scope.revision
      : savedScope.commitSha !== null)
  )
    return null;
  if (!snapshot || snapshot.sessionId !== scope.sessionId || snapshot.revision !== scope.revision)
    return null;
  let result: AvailableReviewOrder | null = null;
  let afterScopeBoundary = savedScope.afterSubmissionId === undefined;
  for (const [index, message] of snapshot.messages.entries()) {
    if (savedScope.afterSubmissionId && message.submissionId === savedScope.afterSubmissionId)
      afterScopeBoundary = true;
    if (!afterScopeBoundary) continue;
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (
      message.role === "user" &&
      content.startsWith("Pulled the latest full PR into this review session.")
    )
      result = null;
    if (message.role !== "assistant" || message.metadata.revision !== scope.revision) continue;
    if (snapshot.running && index === snapshot.messages.length - 1) continue;
    if (
      message.submissionId &&
      !snapshot.settlements.some(
        (item) => item.submissionId === message.submissionId && item.outcome === "completed",
      )
    )
      continue;
    const order: unknown = parseReviewTokens(content).reviewOrder;
    if (
      !Array.isArray(order) ||
      !order.length ||
      !order.every((file) => typeof file === "string" && file.length > 0) ||
      new Set(order).size !== order.length
    )
      continue;
    result = { ...scope, messageId: message.id, files: order };
  }
  return result;
}

/** Persist consumption, not just the preference: reload must not undo a manual override. */
export function createAutomaticOrderTracker(storage?: StorageAccess) {
  let applied: string[] = [];
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(APPLIED_KEY) ?? "null");
    if (
      value?.version === 1 &&
      Array.isArray(value.keys) &&
      value.keys.every((key: unknown) => typeof key === "string")
    )
      applied = value.keys.slice(-100);
  } catch {}
  return {
    take(order: AvailableReviewOrder, paths: string[]): string[] | null {
      if (!order.files.every((file) => paths.includes(file))) return null;
      const key = JSON.stringify([
        order.prUrl,
        order.sessionId,
        order.mode,
        order.revision,
        order.messageId,
        order.files,
      ]);
      if (applied.includes(key)) return null;
      applied = [...applied, key].slice(-100);
      try {
        (storage ?? localStorage).setItem(
          APPLIED_KEY,
          JSON.stringify({ version: 1, keys: applied }),
        );
      } catch {}
      return order.files;
    },
  };
}
