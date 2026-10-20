import { createSignal, Show } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import { Popover } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { CloseIcon } from "../icons/close-icon";
import { GitHubIcon } from "../icons/github-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { GithubOperationDetails } from "./GithubOperationDetails";

export type GithubSyncState = BrowserGithubOperation["status"] | "saving-local" | "retry-pending";

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
};

export function githubOperationSyncState(item: BrowserGithubOperation): GithubSyncState {
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
  if (states.includes("retry-failed")) return "retry-failed";
  return undefined;
}

/** Motion means outstanding sync, not necessarily active network traffic. */
export function githubSyncState(
  operations: readonly BrowserGithubOperation[],
): GithubSyncState | undefined {
  const states = operations.map(githubOperationSyncState);
  for (const state of ["inflight", "local-pending", "queued", "retry-pending"] as const)
    if (states.includes(state)) return state;
  return (
    githubSyncWarning(operations) ??
    states.find((state) => state === "synced" || state === "cancelled")
  );
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
  const warningState = () =>
    githubSyncWarning(props.operations ?? []) ??
    (props.status === "uncertain" || props.status === "retry-failed" ? props.status : undefined);
  const warning = () => !!warningState();
  const label = () =>
    labels[props.status] +
    (warningState() && warningState() !== props.status ? ` · ${labels[warningState()!]}` : "");
  const animation = () =>
    ["saving-local", "local-pending", "queued", "inflight", "retry-pending"].includes(props.status)
      ? "animate-spin motion-reduce:animate-none"
      : "";
  const icon = () => (
    <span aria-hidden="true" class="relative inline-flex shrink-0 items-center">
      <Show when={!warning() || animation()} fallback={<WarningIcon size={12} />}>
        <Show when={props.status !== "synced"} fallback={<CheckIcon size={12} />}>
          <Show when={props.status !== "cancelled"} fallback={<CloseIcon size={12} />}>
            <GitHubIcon
              size={12}
              class={`origin-center [animation-delay:0s] [animation-timing-function:linear] [animation-iteration-count:infinite] ${animation()}`}
            />
          </Show>
        </Show>
      </Show>
      <Show when={warning() && animation()}>
        <span data-github-sync-warning class="absolute -right-1 -top-1 text-warning">
          <WarningIcon size={8} />
        </span>
      </Show>
    </span>
  );
  return (
    <Show when={props.status !== "synced" || props.showSynced}>
      <span
        role={props.scope ? "group" : "status"}
        aria-label={label()}
        title={label()}
        data-github-sync-status={props.status}
        class={`inline-flex items-center gap-1 text-xs [&>button]:size-5 [&>button]:p-0 [&>button]:text-inherit ${warning() ? "text-warning" : "text-text-muted"}`}
      >
        <Show when={props.scope} fallback={icon()}>
          {(scope) => (
            <Popover
              label={label()}
              trigger={icon()}
              triggerSize="icon"
              width={320}
              onOpenChange={setOpen}
            >
              <Show when={open()}>
                <p class="mb-2">{label()}</p>
                <GithubOperationDetails scope={scope()} operations={props.operations ?? []} />
              </Show>
            </Popover>
          )}
        </Show>
        <Show when={!props.iconOnly && !props.scope}>
          <span aria-hidden="true">{label()}</span>
        </Show>
      </span>
    </Show>
  );
}
