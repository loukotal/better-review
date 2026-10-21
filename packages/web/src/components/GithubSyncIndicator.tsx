import { Show, type JSX } from "solid-js";

import { CheckIcon } from "../icons/check-icon";
import { CloseIcon } from "../icons/close-icon";
import { GitHubIcon } from "../icons/github-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { BrowserGithubOperation } from "../lib/github-outbox";

export type GithubSyncState =
  | BrowserGithubOperation["status"]
  | "saving-local"
  | "retry-pending"
  | "blocked"
  | "timed-out"
  | "verifying-account";
const labels: Record<GithubSyncState, string> = {
  "saving-local": "Saving on this device · not synced to GitHub",
  "local-pending": "Saved locally · awaiting app · not synced to GitHub",
  queued: "Queued · not synced to GitHub",
  inflight: "Syncing with GitHub · confirmation pending",
  "retry-pending": "Automatic retry pending · not synced to GitHub",
  "retry-failed": "Not synced · action needed",
  uncertain: "GitHub result uncertain · do not resend · check GitHub again",
  synced: "Synced to GitHub",
  cancelled: "Cancelled · no further GitHub sync",
  blocked: "Waiting for earlier action · not synced to GitHub",
  "timed-out": "Timed out · action needed · not confirmed on GitHub",
  "verifying-account":
    "Waiting for GitHub account verification · saved locally · not sent to GitHub",
};
export function githubOperationSyncState(item: BrowserGithubOperation): GithubSyncState {
  if (
    item.admissionTimedOut ||
    item.operation?.timedOutAt ||
    item.operation?.error?.code === "timeout"
  )
    return "timed-out";
  if (item.blockedByOperationId) return "blocked";
  if (item.admissionRetryAt) return "local-pending";
  if (item.admissionError && item.admissionRetryable) return "verifying-account";
  if (item.admissionError) return "retry-failed";
  if (
    item.status === "retry-failed" &&
    item.operation?.retryMode === "automatic" &&
    item.operation.error?.retryable &&
    item.operation.nextAttemptAt
  )
    return "retry-pending";
  return item.status;
}
export function githubSyncWarning(operations: readonly BrowserGithubOperation[]) {
  const states = operations.map(githubOperationSyncState);
  if (states.includes("uncertain")) return "uncertain";
  if (states.includes("timed-out")) return "timed-out";
  if (states.includes("retry-failed")) return "retry-failed";
  if (states.includes("blocked")) return "blocked";
  return undefined;
}
export function githubSyncState(
  operations: readonly BrowserGithubOperation[],
): GithubSyncState | undefined {
  const states = operations.map(githubOperationSyncState);
  for (const state of [
    "inflight",
    "local-pending",
    "queued",
    "retry-pending",
    "verifying-account",
  ] as const)
    if (states.includes(state)) return state;
  return (
    githubSyncWarning(operations) ??
    states.find((state) => state === "synced" || state === "cancelled")
  );
}
export function githubSyncLabel(
  status: GithubSyncState,
  operations: readonly BrowserGithubOperation[] = [],
) {
  const warning = githubSyncWarning(operations);
  return labels[status] + (warning && warning !== status ? ` · ${labels[warning]}` : "");
}

/** Pure status presentation. No queue lifecycle or operation-detail dependency. */
export function GithubSyncIndicator(props: {
  status: GithubSyncState;
  iconOnly?: boolean;
  showSynced?: boolean;
  operations?: readonly BrowserGithubOperation[];
  renderIcon?: (icon: JSX.Element) => JSX.Element;
}) {
  const warningState = () =>
    githubSyncWarning(props.operations ?? []) ??
    (["uncertain", "retry-failed", "blocked", "timed-out"].includes(props.status)
      ? props.status
      : undefined);
  const label = () => githubSyncLabel(props.status, props.operations);
  const animation = () =>
    ["saving-local", "local-pending", "queued", "inflight", "retry-pending"].includes(props.status)
      ? "github-sync-spin animate-spin"
      : "";
  const icon = () => (
    <span aria-hidden="true" class="relative inline-flex shrink-0 items-center">
      <Show when={!warningState() || animation()} fallback={<WarningIcon size={12} />}>
        <Show when={props.status !== "synced"} fallback={<CheckIcon size={12} />}>
          <Show when={props.status !== "cancelled"} fallback={<CloseIcon size={12} />}>
            <GitHubIcon
              size={12}
              class={`origin-center [animation-delay:0s] [animation-timing-function:linear] [animation-iteration-count:infinite] ${animation()}`}
            />
          </Show>
        </Show>
      </Show>
      <Show when={warningState() && animation()}>
        <span data-github-sync-warning class="absolute -right-1 -top-1 text-warning">
          <WarningIcon size={8} />
        </span>
      </Show>
    </span>
  );
  return (
    <Show when={props.status !== "synced" || props.showSynced}>
      <span
        role={props.renderIcon ? "group" : "status"}
        aria-label={label()}
        title={label()}
        data-github-sync-status={props.status}
        class={`inline-flex items-center gap-1 text-xs [&>button]:size-5 [&>button]:p-0 [&>button]:text-inherit ${warningState() ? "text-warning" : "text-text-muted"}`}
      >
        {props.renderIcon ? props.renderIcon(icon()) : icon()}
        <Show when={!props.iconOnly && !props.renderIcon}>
          <span aria-hidden="true">{label()}</span>
        </Show>
      </span>
    </Show>
  );
}
