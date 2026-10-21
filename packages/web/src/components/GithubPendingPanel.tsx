import { A, useLocation, useSearchParams } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";

import { useGithubQueue } from "../context/GithubQueueContext";
import { Popover, Button } from "../design-system";
import { GitHubIcon } from "../icons/github-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import type { GithubDraft } from "../lib/github-outbox-journal";
import { revealGithubQueueContent } from "../lib/github-queue-layout";
import { githubJournal } from "../lib/github-writes";
import {
  prPageHref,
  prListReturnPath,
  prListLinkState,
  advancePrLinkState,
  rememberPrListScroll,
} from "../lib/pr-navigation";
import { legacyGithubDraftRecovery } from "../lib/recoverable-drafts";
import { GithubOperationDetails } from "./GithubOperationDetails";
import { GithubSyncStatus, githubSyncState, githubOperationSyncState } from "./GithubSyncStatus";

const actionLabels: Record<BrowserGithubOperation["command"]["action"]["kind"], string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  "review-comment": "Review comment",
  "issue-comment": "Comment",
  "inline-comment": "Inline comment",
  reply: "Reply",
  "edit-comment": "Edit comment",
  "delete-comment": "Delete comment",
  "resolve-thread": "Resolve thread",
  "unresolve-thread": "Reopen thread",
};
function shortStatus(item: BrowserGithubOperation) {
  switch (githubOperationSyncState(item)) {
    case "timed-out":
      return "Timed out";
    case "uncertain":
      return "Delivery unknown";
    case "blocked":
      return "Blocked";
    case "retry-failed":
      return "Needs attention";
    case "inflight":
      return "Sending";
    case "local-pending":
      return "Saved locally";
    case "verifying-account":
      return "Verify account";
    case "retry-pending":
      return "Retry scheduled";
    default:
      return "Queued";
  }
}

/** Compact global presentation. Recovery and completion reads belong to AppShell. */
export function GithubPendingPanel() {
  const queue = useGithubQueue();
  if (!queue) return null;
  const location = useLocation();
  const [params] = useSearchParams();
  const [open, setOpen] = createSignal(false);
  const [history, setHistory] = createSignal(false);
  const rows = new Map<string, HTMLDetailsElement>();
  const revealBlocker = (operationId: string) => {
    const row = rows.get(operationId);
    if (!row) return false;
    row.open = true;
    row.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    return true;
  };
  const [drafts, setDrafts] = createSignal<Record<string, GithubDraft[]>>({});
  const [draftError, setDraftError] = createSignal<string>();
  const [discovering, setDiscovering] = createSignal(false);
  const [discoveryError, setDiscoveryError] = createSignal<string>();
  const pending = createMemo(() =>
    queue
      .states()
      .flatMap((state) =>
        state.operations.filter(
          (item) =>
            !item.operation?.archivedAt && item.status !== "synced" && item.status !== "cancelled",
        ),
      ),
  );
  const saving = () => queue.states().reduce((total, state) => total + state.pendingSaving, 0);
  const count = () => pending().length + saving();
  const status = () => (saving() ? ("saving-local" as const) : githubSyncState(pending()));
  let read = 0;
  createEffect(() => {
    if (!open() || !history()) return;
    const states = queue.states(),
      token = ++read;
    void (async () => {
      const entries: [string, GithubDraft[]][] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, states.length) }, async () => {
          while (index < states.length && token === read) {
            const state = states[index++]!;
            entries.push([
              state.scope.url,
              (await githubJournal.editorDrafts(state.scope)).filter((draft) => draft.body.trim()),
            ]);
          }
        }),
      );
      return entries;
    })()
      .then((entries) => {
        if (token === read) {
          setDrafts(Object.fromEntries(entries));
          setDraftError(undefined);
        }
      })
      .catch(() => {
        if (token === read)
          setDraftError("Some drafts could not be read. Saved content is retained.");
      });
  });
  const toggleHistory = async () => {
    const show = !history();
    setHistory(show);
    if (!show || !queue.loadHistory) return;
    setDiscovering(true);
    setDiscoveryError(undefined);
    try {
      await queue.loadHistory();
    } catch {
      setDiscoveryError(
        "Saved history could not be loaded. Content is retained; reopen to try again.",
      );
    } finally {
      setDiscovering(false);
    }
  };
  const returnTo = () =>
    location.pathname === "/"
      ? `${location.pathname}${location.search}`
      : prListReturnPath(params.returnTo);
  const scopeLink = (url: string, label: string) => (
    <A
      class="min-w-0 truncate font-medium text-accent hover:underline"
      href={prPageHref(url, { tab: "overview", returnTo: returnTo() })}
      onClick={() => {
        if (location.pathname === "/")
          rememberPrListScroll(`${location.pathname}${location.search}`);
      }}
      state={
        location.pathname === "/"
          ? prListLinkState(returnTo(), location.state)
          : advancePrLinkState(location.state)
      }
    >
      {label}
    </A>
  );
  const visible = createMemo(() =>
    queue
      .states()
      .filter((state) =>
        history()
          ? state.operations.some(
              (item) =>
                item.operation?.archivedAt ||
                item.status === "synced" ||
                item.status === "cancelled",
            ) ||
            drafts()[state.scope.url]?.length ||
            legacyGithubDraftRecovery(state.scope.url).length
          : state.operations.some(
              (item) =>
                !item.operation?.archivedAt &&
                item.status !== "synced" &&
                item.status !== "cancelled",
            ) || state.pendingSaving,
      )
      .map((state) => state.scope.url),
  );
  return (
    <div
      aria-label="GitHub pending writes"
      class="fixed bottom-3 left-3 z-20 text-xs"
      data-global-github-queue
    >
      <Popover
        label="GitHub queue"
        width={320}
        maxHeight="min(60dvh, 420px)"
        triggerSize="icon"
        open={open()}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setHistory(false);
        }}
        trigger={
          <span class="inline-flex items-center gap-1">
            <Show when={status()} fallback={<GitHubIcon size={12} />}>
              {(value) => <GithubSyncStatus status={value()} operations={pending()} iconOnly />}
            </Show>
            <Show when={queue.error()}>
              <span class="text-warning" aria-label="Queue needs attention">
                <WarningIcon size={8} />
              </span>
            </Show>
            <Show when={count()}>
              <span aria-hidden="true">{count()}</span>
            </Show>
          </span>
        }
      >
        <Show when={open()}>
          <div class="mb-2 flex items-center justify-between gap-2">
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={history()}
              onClick={() => void toggleHistory()}
            >
              {history() ? "Pending actions" : "Drafts & history"}
            </Button>
            <div class="flex items-center gap-1">
              <Button
                data-github-queue-batch="retry"
                size="xs"
                variant="ghost"
                disabled={!!queue.batchBusy?.() || !count() || !queue.retryAll}
                onClick={() => void queue.retryAll?.()}
              >
                {queue.batchBusy?.() === "retry" ? "Retrying…" : "Retry"}
              </Button>
              <Button
                data-github-queue-batch="clear"
                size="xs"
                variant="ghost"
                disabled={!!queue.batchBusy?.() || !!saving() || !count() || !queue.clearAll}
                title={
                  saving()
                    ? "Wait for the current local save to finish"
                    : "Cancel unsent actions; archive unknown delivery without resending"
                }
                onClick={() => void queue.clearAll?.()}
              >
                {queue.batchBusy?.() === "clear" ? "Clearing…" : "Clear"}
              </Button>
            </div>
          </div>
          <div
            data-github-queue-scroll
            class="overflow-y-auto overscroll-contain"
            style={{ "max-height": "max(80px, calc(min(60dvh, 420px) - 110px))" }}
            tabindex="0"
            aria-label={history() ? "Saved drafts and history" : "Pending GitHub actions"}
          >
            <Show when={queue.batchFeedback?.()}>
              <p role="status" class="mb-2 text-text-muted">
                {queue.batchFeedback?.()}
              </p>
            </Show>
            <Show when={queue.error() || (history() && (draftError() || discoveryError()))}>
              <p role="alert" class="mb-2 text-warning">
                {queue.error() ?? discoveryError() ?? draftError()}
              </p>
            </Show>
            <Show when={!history() && !count()}>
              <p class="py-2 text-text-muted">No pending actions</p>
            </Show>
            <Show when={history() && discovering()}>
              <p role="status" class="py-2 text-text-muted">
                Loading saved content…
              </p>
            </Show>
            <Show when={history() && !discovering() && !visible().length}>
              <p class="py-2 text-text-muted">No saved drafts or history</p>
            </Show>
            <For each={visible()}>
              {(url) => {
                const state = () => queue.states().find((entry) => entry.scope.url === url)!;
                const operations = () =>
                  state().operations.filter((item) =>
                    history()
                      ? item.operation?.archivedAt ||
                        item.status === "synced" ||
                        item.status === "cancelled"
                      : !item.operation?.archivedAt &&
                        item.status !== "synced" &&
                        item.status !== "cancelled",
                  );
                return (
                  <section
                    class="border-t border-border py-2"
                    aria-label={`GitHub actions for ${state().scope.owner}/${state().scope.repo}#${state().scope.number}`}
                  >
                    <div class="mb-1 flex items-center gap-2">
                      {scopeLink(url, `${state().scope.repo}#${state().scope.number}`)}
                      <Show when={state().pendingSaving && !history()}>
                        <span class="text-text-muted">Saving…</span>
                      </Show>
                    </div>
                    <Show when={!history()}>
                      <For each={operations().map((item) => item.command.operationId)}>
                        {(id) => {
                          const item = () =>
                            state().operations.find((entry) => entry.command.operationId === id)!;
                          const [expanded, setExpanded] = createSignal(false);
                          let row!: HTMLDetailsElement;
                          createEffect(() => {
                            const visible = expanded() && item().status;
                            if (!visible) return;
                            const frame = requestAnimationFrame(() => {
                              const controls = row.querySelector<HTMLElement>(
                                "[data-github-primary-controls]",
                              );
                              if (controls) revealGithubQueueContent(controls);
                            });
                            onCleanup(() => cancelAnimationFrame(frame));
                          });
                          onCleanup(() => rows.delete(id));
                          return (
                            <details
                              ref={(element) => {
                                row = element;
                                rows.set(id, element);
                              }}
                              data-github-queue-action={id}
                              class="rounded py-1"
                              onToggle={(event) => setExpanded(event.currentTarget.open)}
                            >
                              <summary class="cursor-pointer text-xs">
                                <span class="inline-flex max-w-full items-center gap-2 align-middle">
                                  <GithubSyncStatus
                                    status={githubOperationSyncState(item())}
                                    iconOnly
                                  />
                                  <span>{actionLabels[item().command.action.kind]}</span>
                                  <span class="text-text-muted">
                                    {githubOperationSyncState(item()) === "timed-out"
                                      ? "Timed out"
                                      : (queue.operationFeedback?.()[id] ?? shortStatus(item()))}
                                  </span>
                                </span>
                              </summary>
                              <Show when={expanded()}>
                                <div class="mt-2 border-l border-border pl-2">
                                  <GithubOperationDetails
                                    compact
                                    onRevealBlocker={revealBlocker}
                                    scope={state().scope}
                                    operations={[item()]}
                                  />
                                </div>
                              </Show>
                            </details>
                          );
                        }}
                      </For>
                    </Show>
                    <Show when={history()}>
                      <Show when={drafts()[url]?.length}>
                        <details>
                          <summary class="cursor-pointer">
                            Unsubmitted drafts ({drafts()[url]!.length})
                          </summary>
                          <For each={drafts()[url]}>
                            {(draft) => (
                              <details>
                                <summary>{draft.editorSlot}</summary>
                                <pre class="whitespace-pre-wrap break-words">{draft.body}</pre>
                              </details>
                            )}
                          </For>
                        </details>
                      </Show>
                      <Show when={legacyGithubDraftRecovery(url).length}>
                        <details>
                          <summary>Legacy editor text</summary>
                          <p>May already be submitted. Compare GitHub before reusing.</p>
                          <For each={legacyGithubDraftRecovery(url)}>
                            {(draft) => (
                              <details>
                                <summary>{draft.key}</summary>
                                <pre class="whitespace-pre-wrap break-words">{draft.body}</pre>
                              </details>
                            )}
                          </For>
                        </details>
                      </Show>
                      <Show when={operations().length}>
                        <details>
                          <summary>Recover original saved content ({operations().length})</summary>
                          <p>Saved text only. Never resends.</p>
                          <For each={operations().map((item) => item.command.operationId)}>
                            {(id) => {
                              const item = () =>
                                state().operations.find(
                                  (entry) => entry.command.operationId === id,
                                )!;
                              const body = () => {
                                const action = item().command.action;
                                return "body" in action
                                  ? action.body
                                  : "expectedBody" in action
                                    ? action.expectedBody
                                    : "Thread state change";
                              };
                              return (
                                <details data-github-recovery-operation={id}>
                                  <summary>
                                    <Show when={item().operation?.archivedAt}>Archived · </Show>
                                    <Show
                                      when={
                                        item().operation?.archivedAt &&
                                        item().status === "uncertain"
                                      }
                                    >
                                      Delivery unknown ·{" "}
                                    </Show>
                                    {actionLabels[item().command.action.kind]} ·{" "}
                                    <GithubSyncStatus
                                      status={githubOperationSyncState(item())}
                                      showSynced
                                    />
                                  </summary>
                                  <pre class="whitespace-pre-wrap break-words">{body()}</pre>
                                </details>
                              );
                            }}
                          </For>
                        </details>
                      </Show>
                    </Show>
                  </section>
                );
              }}
            </For>
          </div>
        </Show>
      </Popover>
    </div>
  );
}
