import { createSignal, Show } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import { Popover } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { CloseIcon } from "../icons/close-icon";
import { GitHubIcon } from "../icons/github-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { GithubOperationDetails } from "./GithubOperationDetails";

export type GithubSyncState = BrowserGithubOperation["status"] | "saving-local";

const labels: Record<GithubSyncState, string> = {
  "saving-local": "Saving on this device · not synced to GitHub",
  "local-pending": "Saved locally · awaiting app · not synced to GitHub",
  queued: "Queued · not synced to GitHub",
  inflight: "Syncing with GitHub · confirmation pending",
  "retry-failed": "Not synced · action needed",
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
  scope?: GithubPrScope;
  operations?: readonly BrowserGithubOperation[];
}) {
  const [open, setOpen] = createSignal(false);
  const warning = () => props.status === "uncertain" || props.status === "retry-failed";
  const animation = () =>
    props.status === "inflight"
      ? "animate-spin motion-reduce:animate-none"
      : ["saving-local", "local-pending", "queued"].includes(props.status)
        ? "animate-pulse motion-reduce:animate-none"
        : "";
  const icon = () => (
    <span aria-hidden="true" class="inline-flex shrink-0 items-center">
      <Show when={!warning()} fallback={<WarningIcon size={12} />}>
        <Show when={props.status !== "synced"} fallback={<CheckIcon size={12} />}>
          <Show when={props.status !== "cancelled"} fallback={<CloseIcon size={12} />}>
            <GitHubIcon size={12} class={`origin-center ${animation()}`} />
          </Show>
        </Show>
      </Show>
    </span>
  );
  return (
    <Show when={props.status !== "synced" || props.showSynced}>
      <span
        role={props.scope ? "group" : "status"}
        aria-label={labels[props.status]}
        title={labels[props.status]}
        data-github-sync-status={props.status}
        class={`inline-flex items-center gap-1 text-xs [&>button]:size-5 [&>button]:p-0 [&>button]:text-inherit ${warning() ? "text-warning" : "text-text-muted"}`}
      >
        <Show when={props.scope} fallback={icon()}>
          {(scope) => (
            <Popover
              label={labels[props.status]}
              trigger={icon()}
              triggerSize="icon"
              width={320}
              onOpenChange={setOpen}
            >
              <Show when={open()}>
                <p class="mb-2">{labels[props.status]}</p>
                <GithubOperationDetails scope={scope()} operations={props.operations ?? []} />
              </Show>
            </Popover>
          )}
        </Show>
        <Show when={!props.iconOnly && !props.scope}>
          <span aria-hidden="true">{labels[props.status]}</span>
        </Show>
      </span>
    </Show>
  );
}
