import type { PrDetailCheck } from "@better-review/shared";

export type CheckGroup = "failed" | "pending" | "unknown" | "other" | "passed";
type CheckEvidence = Pick<PrDetailCheck, "status" | "conclusion">;
export const checkGroups: { key: CheckGroup; label: string }[] = [
  { key: "failed", label: "Failed" },
  { key: "pending", label: "In progress" },
  { key: "unknown", label: "Unknown" },
  { key: "other", label: "Skipped, neutral or cancelled" },
  { key: "passed", label: "Passed" },
];
const pending = ["PENDING", "QUEUED", "IN_PROGRESS", "RUNNING", "WAITING", "REQUESTED", "EXPECTED"];

/** Explicit normalization boundary for detail enums and the legacy review-header read model. */
export function checkPresentation(check: CheckEvidence): {
  group: CheckGroup;
  label: string;
  icon: string;
  tone: string;
} {
  const status = check.status.toUpperCase();
  const value = pending.includes(status)
    ? status
    : (check.conclusion ?? check.status).toUpperCase();
  if (value === "SUCCESS")
    return { group: "passed", label: "Passed", icon: "✓", tone: "text-success" };
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value))
    return {
      group: "failed",
      label: value.toLowerCase().replaceAll("_", " "),
      icon: "×",
      tone: "text-error",
    };
  if (pending.includes(value))
    return {
      group: "pending",
      label: value.toLowerCase().replaceAll("_", " "),
      icon: "◷",
      tone: "text-warning",
    };
  if (["NEUTRAL", "SKIPPED", "CANCELLED", "STALE"].includes(value))
    return { group: "other", label: value.toLowerCase(), icon: "−", tone: "text-text-muted" };
  return { group: "unknown", label: "Unknown", icon: "?", tone: "text-text-muted" };
}

export function summarizePrChecks(checks: readonly CheckEvidence[]) {
  const result: Record<CheckGroup, number> = {
    failed: 0,
    pending: 0,
    unknown: 0,
    other: 0,
    passed: 0,
  };
  for (const check of checks) result[checkPresentation(check).group]++;
  return { ...result, total: checks.length };
}

export function checkUrl(value: string | null): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return;
  }
}
