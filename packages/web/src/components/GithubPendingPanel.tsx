import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { GithubOutboxControl } from "@better-review/shared";

import { Button } from "../design-system";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import type { GithubDraft } from "../lib/github-outbox-journal";
import {
  githubPrScope,
  githubWrites,
  githubJournal,
  refreshGithubActor,
} from "../lib/github-writes";
import { refreshPrListAfterReview } from "../lib/query";
import { legacyGithubDraftRecovery } from "../lib/recoverable-drafts";
import { trpc } from "../lib/trpc";
import { GithubSyncStatus, githubSyncState } from "./GithubSyncStatus";

/** Compact transport/recovery controls. Comment bodies belong to discussion/diff views. */
export function GithubPendingPanel(props: {
  prUrl: string | null;
  onRemoteSync: (url: string) => Promise<void>;
}) {
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [drafts, setDrafts] = createSignal<GithubDraft[]>([]);
  const scope = createMemo(() => (props.prUrl ? githubPrScope(props.prUrl) : undefined));
  const legacyDrafts = createMemo(() => {
    version();
    const current = scope();
    return current ? legacyGithubDraftRecovery(current.url) : [];
  });
  const state = createMemo(() => {
    version();
    const current = scope();
    return current ? githubWrites.getState(current) : undefined;
  });
  const pending = createMemo(
    () =>
      state()?.operations.filter(
        (item) => item.status !== "synced" && item.status !== "cancelled",
      ) ?? [],
  );
  const refreshed = new Set<string>();
  let draftRead = 0;
  createEffect(() => {
    version();
    const current = scope(),
      serial = ++draftRead;
    if (!current) {
      setDrafts([]);
      return;
    }
    void githubJournal
      .editorDrafts(current)
      .then((items) => {
        if (serial === draftRead) setDrafts(items);
      })
      .catch(() => {});
  });
  const unsubscribe = githubWrites.subscribe(() => setVersion((value) => value + 1));
  onCleanup(() => {
    unsubscribe();
    githubWrites.activate();
  });
  createEffect(() => {
    const current = scope();
    githubWrites.activate(current);
    if (current) {
      void trpc.githubOutbox.capability.query().catch(() => {});
      void refreshGithubActor().catch(() => {});
      const timer = setInterval(() => {
        if (document.visibilityState === "visible") void refreshGithubActor().catch(() => {});
      }, 15_000);
      onCleanup(() => clearInterval(timer));
    }
  });
  createEffect(() => {
    const current = state();
    if (!current) return;
    for (const item of current.operations) {
      if (item.status !== "synced" || refreshed.has(item.command.operationId)) continue;
      refreshed.add(item.command.operationId);
      void Promise.allSettled([props.onRemoteSync(current.scope.url), refreshPrListAfterReview()]);
    }
  });
  const control = async (item: BrowserGithubOperation, kind: "retry" | "reconcile" | "cancel") => {
    const current = scope();
    if (!current || !item.operation) return;
    setError(undefined);
    try {
      const request: GithubOutboxControl = {
        kind,
        requestId: crypto.randomUUID(),
        operationId: item.command.operationId,
        expectedRevision: item.operation.revision,
      };
      const receipt = await githubWrites.control(current, request);
      if (receipt?.outcome === "rejected") setError(receipt.error.message);
    } catch {
      setError("Control not acknowledged. Saved work is retained; reconnect to check again.");
    }
  };
  return (
    <Show when={state()?.operations.length || drafts().length || legacyDrafts().length}>
      <section
        aria-label="GitHub pending writes"
        class="border-b border-border bg-bg-surface px-3 py-1 text-xs"
      >
        <details>
          <summary>
            <Show when={githubSyncState(pending())}>
              {(status) => <GithubSyncStatus status={status()} iconOnly />}
            </Show>
            GitHub ·{" "}
            {pending().length
              ? `${pending().length} saved locally, not synced`
              : drafts().length
                ? `${drafts().length} unsubmitted drafts (not queued)`
                : legacyDrafts().length
                  ? `${legacyDrafts().length} legacy drafts available for recovery`
                  : "All writes synced or cancelled"}
            {pending().some(
              (item) =>
                item.status === "uncertain" ||
                item.status === "retry-failed" ||
                item.admissionError,
            )
              ? " · action needed"
              : ""}
          </summary>
          <Show when={legacyDrafts().length}>
            <details>
              <summary>Recover legacy editor text</summary>
              <p>
                This older localStorage text may already have been submitted. Compare the
                outbox/GitHub before manually reusing it; it is never restored as a new intent
                automatically.
              </p>
              <For each={legacyDrafts()}>
                {(draft) => (
                  <details>
                    <summary>{draft.key}</summary>
                    <pre class="whitespace-pre-wrap break-words">{draft.body}</pre>
                  </details>
                )}
              </For>
            </details>
          </Show>
          <Show when={drafts().length}>
            <details>
              <summary>{drafts().length} unsubmitted drafts saved on this device</summary>
              <For each={drafts()}>
                {(draft) => (
                  <details>
                    <summary>{draft.editorSlot}</summary>
                    <p>
                      Unsubmitted editor content. Reopen the matching editor to continue; this is
                      not a queued write.
                    </p>
                    <pre class="whitespace-pre-wrap break-words">{draft.body}</pre>
                  </details>
                )}
              </For>
            </details>
          </Show>
          <Show when={state()?.error || error()}>
            <p role="alert">{error() ?? state()?.error}</p>
          </Show>
          <For each={pending()}>
            {(item) => (
              <div
                data-operation-id={item.command.operationId}
                class="flex flex-wrap items-center gap-2 py-1"
              >
                <span>{item.command.action.kind}</span>
                <GithubSyncStatus status={item.admissionError ? "retry-failed" : item.status} />
                <Show when={item.operation?.error || item.admissionError}>
                  <span role="alert">{item.operation?.error?.message ?? item.admissionError}</span>
                </Show>
                <Show when={!item.backendOwned}>
                  <Button
                    size="sm"
                    onClick={() => {
                      const current = scope();
                      if (current)
                        void githubWrites.retryAdmission(current, item.command.operationId);
                    }}
                  >
                    Check admission again
                  </Button>
                </Show>
                <Show
                  when={item.status === "retry-failed" && item.operation?.retryMode !== "blocked"}
                >
                  <Button size="sm" onClick={() => void control(item, "retry")}>
                    Retry
                  </Button>
                </Show>
                <Show when={item.status === "uncertain"}>
                  <Button size="sm" onClick={() => void control(item, "reconcile")}>
                    Check GitHub again (no resend)
                  </Button>
                </Show>
                <Show when={item.status === "queued" || item.status === "retry-failed"}>
                  <Button size="sm" onClick={() => void control(item, "cancel")}>
                    Cancel queued write
                  </Button>
                </Show>
              </div>
            )}
          </For>
          <details>
            <summary>Recover original saved content ({state()?.operations.length})</summary>
            <For each={state()?.operations}>
              {(item) => (
                <details>
                  <summary>
                    {item.command.action.kind} ·{" "}
                    <GithubSyncStatus status={item.status} showSynced />
                  </summary>
                  <pre class="whitespace-pre-wrap break-words">
                    {"body" in item.command.action
                      ? item.command.action.body
                      : "expectedBody" in item.command.action
                        ? item.command.action.expectedBody
                        : "Thread state change"}
                  </pre>
                </details>
              )}
            </For>
          </details>
        </details>
      </section>
    </Show>
  );
}
