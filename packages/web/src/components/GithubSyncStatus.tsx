import { Show } from "solid-js";

import { CheckIcon } from "../icons/check-icon";
import { CloseIcon } from "../icons/close-icon";
import { GitHubIcon } from "../icons/github-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { BrowserGithubOperation } from "../lib/github-outbox";

export type GithubSyncState = BrowserGithubOperation["status"] | "saving-local";

const labels: Record<GithubSyncState, string> = {
  "saving-local": "Saving on this device · not synced to GitHub",
  "local-pending": "Saved locally · awaiting app · not synced to GitHub",
  queued: "Queued · not synced to GitHub",
  inflight: "Syncing with GitHub · confirmation pending",
  "retry-failed": "Not synced · action needed · check the GitHub pending writes panel",
  uncertain: "GitHub result uncertain · do not resend · check GitHub again",
  synced: "Synced to GitHub",
  cancelled: "Cancelled · no further GitHub sync",
};

/** Warnings win over activity; a waiting queue must never imply active network work. */
export function githubSyncState(
  operations: readonly BrowserGithubOperation[],
): GithubSyncState | undefined {
  if (operations.some((item) => item.status === "uncertain")) return "uncertain";
  if (operations.some((item) => item.admissionError || item.status === "retry-failed"))
    return "retry-failed";
  for (const state of ["inflight", "local-pending", "queued", "synced", "cancelled"] as const)
    if (operations.some((item) => item.status === state)) return state;
  return undefined;
}

/** Inline status, including a text equivalent when shown as an icon only. */
export function GithubSyncStatus(props: {
  status: GithubSyncState;
  iconOnly?: boolean;
  showSynced?: boolean;
}) {
  const warning = () => props.status === "uncertain" || props.status === "retry-failed";
  return (
    <Show when={props.status !== "synced" || props.showSynced}>
      <span
        role="status"
        aria-label={labels[props.status]}
        title={labels[props.status]}
        data-github-sync-status={props.status}
        class={`inline-flex items-center gap-1 text-xs ${warning() ? "text-warning" : "text-text-muted"}`}
      >
        <span aria-hidden="true" class="inline-flex shrink-0 items-center gap-0.5">
          <GitHubIcon
            size={12}
            class={props.status === "inflight" ? "animate-spin motion-reduce:animate-none" : ""}
          />
          <Show when={warning()}>
            <WarningIcon size={12} />
          </Show>
          <Show when={props.status === "synced"}>
            <CheckIcon size={12} />
          </Show>
          <Show when={props.status === "cancelled"}>
            <CloseIcon size={12} />
          </Show>
        </span>
        <Show when={!props.iconOnly}>
          <span aria-hidden="true">{labels[props.status]}</span>
        </Show>
      </span>
    </Show>
  );
}
