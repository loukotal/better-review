import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";

import type { PrDetail, PrMergeAction, PrMergeAttempt, PrMergeInput } from "@better-review/shared";

import { Button, Popover } from "../design-system";
import { trpc } from "../lib/trpc";

const intentKey = (url: string) => `pr-merge-intent:${url}`;
const historyKey = (input: PrMergeInput) => `${intentKey(input.url)}:history:${input.requestId}`;
interface SavedMergeAttempt {
  input: PrMergeInput;
  outcome?: PrMergeAttempt;
}
const label = (action: PrMergeAction) =>
  action.kind === "enqueue"
    ? "Add to merge queue"
    : `${action.kind === "admin-merge" ? "Admin: " : ""}${action.method === "merge" ? "Create merge commit" : action.method === "squash" ? "Squash and merge" : "Rebase and merge"}`;
const actionKey = (action: PrMergeAction) =>
  action.kind === "enqueue" ? "enqueue" : `${action.kind}:${action.method}`;
const explanation = (action: PrMergeAction) =>
  action.kind === "enqueue"
    ? "Let the merge queue validate and merge this pull request."
    : action.method === "merge"
      ? "Keep all commits and add a merge commit."
      : action.method === "squash"
        ? "Combine all commits into one commit."
        : "Replay each commit onto the base branch.";

/** Browser storage records intent before dispatch. Reload only permits read-only reconciliation. */
export function PrMergePanel(props: {
  detail: PrDetail;
  pendingComments: number;
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = createSignal<string>();
  let methodMenu: HTMLDivElement | undefined;
  const [intent, setIntent] = createSignal<PrMergeInput>();
  const [result, setResult] = createSignal<PrMergeAttempt>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const metadata = () =>
    props.detail.metadata.status === "available" ? props.detail.metadata.data : undefined;
  const caps = () =>
    props.detail.mergeCapabilities.status === "available"
      ? props.detail.mergeCapabilities.data
      : undefined;
  const actions = () =>
    caps()?.actions.filter((entry) =>
      entry.action.kind === "enqueue"
        ? caps()?.queueRequired === true
        : caps()?.allowedMethods.includes(entry.action.method) &&
          (entry.action.kind !== "admin-merge" || caps()?.viewerCanMergeAsAdmin === true),
    ) ?? [];
  const choice = () => actions().find((entry) => actionKey(entry.action) === selected());
  createEffect(() => {
    if (selected() !== undefined || !actions().length) return;
    // Preserve the server's ordering, but never silently default to administrator bypass.
    const normal = actions().filter((entry) => entry.action.kind !== "admin-merge");
    const initial = normal.find((entry) => entry.enabled) ?? normal[0];
    if (initial) setSelected(actionKey(initial.action));
  });
  const blocked = () =>
    props.detail.metadata.status !== "available" ||
    !props.detail.metadata.complete ||
    props.detail.mergeCapabilities.status !== "available" ||
    !props.detail.mergeCapabilities.complete ||
    metadata()?.state !== "OPEN" ||
    metadata()?.draft ||
    !!caps()?.queueEntry ||
    !choice()?.enabled ||
    !metadata()?.head.sha ||
    props.detail.actor.status !== "available" ||
    !props.detail.actor.complete;
  let generation = 0;
  onCleanup(() => generation++);
  const identity = createMemo(() => props.detail.url);
  createEffect(
    on(identity, (url) => {
      generation++;
      setIntent(undefined);
      setResult(undefined);
      setError(undefined);
      setBusy(false);
      setSelected(undefined);
      try {
        const saved = localStorage.getItem(intentKey(url));
        if (saved) {
          const value = JSON.parse(saved) as PrMergeInput;
          if (value.url !== url || !value.requestId || !value.expectedHeadSha)
            throw new Error("Invalid merge intent");
          setIntent(value);
          const history = localStorage.getItem(historyKey(value));
          if (history) {
            const saved = JSON.parse(history) as SavedMergeAttempt;
            if (
              saved.input?.requestId === value.requestId &&
              saved.outcome?.requestId === value.requestId &&
              ["rejected", "uncertain", "succeeded"].includes(saved.outcome.status)
            )
              setResult(saved.outcome);
          }
        }
      } catch {
        setError("Cannot read saved merge intent. Merge is disabled until storage is available.");
      }
    }),
  );
  const rememberOutcome = (input: PrMergeInput, outcome: PrMergeAttempt) => {
    setResult(outcome);
    try {
      localStorage.setItem(
        historyKey(input),
        JSON.stringify({ input, outcome } satisfies SavedMergeAttempt),
      );
    } catch {
      setError(
        "Outcome received, but browser history storage is unavailable. Check outcome before continuing.",
      );
    }
  };
  const reconcile = async () => {
    const saved = intent();
    if (!saved || busy()) return;
    const token = generation;
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await trpc.prDetail.reconcileMerge.mutate({
        url: saved.url,
        requestId: saved.requestId,
      });
      if (token !== generation) return;
      rememberOutcome(saved, outcome);
      await props.onChanged();
    } catch (cause) {
      if (token === generation)
        setError(
          cause instanceof Error
            ? cause.message
            : "Outcome unavailable. Check again; do not resubmit.",
        );
    } finally {
      if (token === generation) setBusy(false);
    }
  };
  const merge = async () => {
    const head = metadata()?.head.sha;
    const actor = props.detail.actor;
    const action = choice()?.action;
    if (
      busy() ||
      intent() ||
      blocked() ||
      !head ||
      actor.status !== "available" ||
      !action ||
      error()
    )
      return;
    const token = generation;
    const input: PrMergeInput = {
      url: props.detail.url,
      requestId: crypto.randomUUID(),
      expectedActor: actor.data,
      expectedHeadSha: head,
      action,
    };
    // No retries, including network failures. Server owns durable outcome.
    try {
      localStorage.setItem(
        historyKey(input),
        JSON.stringify({ input } satisfies SavedMergeAttempt),
      );
      localStorage.setItem(intentKey(input.url), JSON.stringify(input));
    } catch {
      setError("Cannot persist merge intent. Nothing was sent.");
      return;
    }
    setIntent(input);
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await trpc.prDetail.merge.mutate(input);
      if (token !== generation) return;
      rememberOutcome(input, outcome);
      await props.onChanged();
    } catch {
      if (token === generation)
        setError("Merge outcome uncertain. Do not retry. Use Check outcome to read server state.");
    } finally {
      if (token === generation) setBusy(false);
    }
  };
  const newAttempt = async () => {
    const previous = intent(),
      outcome = result();
    if (busy() || !previous || outcome?.status !== "rejected") return;
    const token = generation;
    let ready = false;
    setBusy(true);
    setError(undefined);
    try {
      // This is a new explicit command, never a retry of an uncertain dispatch.
      // Revalidate current actor/head/action after the user's click, not at rejection time.
      await props.onChanged();
      if (token !== generation) return;
      if (blocked()) throw new Error("Fresh GitHub evidence does not permit a new merge attempt.");
      localStorage.setItem(
        historyKey(previous),
        JSON.stringify({ input: previous, outcome } satisfies SavedMergeAttempt),
      );
      setIntent(undefined);
      setResult(undefined);
      ready = true;
    } catch (cause) {
      if (token === generation)
        setError(
          cause instanceof Error
            ? cause.message
            : "Cannot prepare a fresh merge attempt. Nothing was sent.",
        );
    } finally {
      if (token === generation) setBusy(false);
    }
    if (ready && token === generation) await merge();
  };
  const state = () =>
    result()?.status === "uncertain" && result()?.observed?.state === "MERGED"
      ? "Observed merged"
      : metadata()?.state === "MERGED"
        ? "Merged"
        : metadata()?.state === "CLOSED"
          ? "Closed"
          : metadata()?.draft
            ? "Draft pull request"
            : caps()?.queueEntry
              ? "In merge queue"
              : caps()?.mergeable === "CONFLICTING"
                ? "Merge conflicts"
                : "Merge pull request";
  const actionLabel = () =>
    metadata()?.state === "MERGED"
      ? "Merged"
      : metadata()?.state === "CLOSED"
        ? "Closed"
        : metadata()?.draft
          ? "Draft: not ready to merge"
          : caps()?.queueEntry
            ? "Already queued"
            : caps()?.mergeable === "CONFLICTING"
              ? "Resolve conflicts to merge"
              : choice()
                ? label(choice()!.action)
                : "Merge unavailable";
  return (
    <section aria-label="Merge pull request" class="space-y-3 border border-border p-4">
      <h2 class="font-semibold">{state()}</h2>
      <p class="break-words text-xs text-text-muted">
        Head <code>{intent()?.expectedHeadSha ?? metadata()?.head.sha ?? "unavailable"}</code> ·
        Actor{" "}
        {intent()?.expectedActor.login ??
          (props.detail.actor.status === "available"
            ? props.detail.actor.data.login
            : "unavailable")}
      </p>
      <Show when={props.pendingComments}>
        <p class="text-xs text-text-muted">
          {props.pendingComments} pending comment/review operation(s). Not a GitHub merge
          requirement.
        </p>
      </Show>
      <Show when={props.detail.mergeCapabilities.status === "unavailable"}>
        <p role="alert">
          {props.detail.mergeCapabilities.status === "unavailable"
            ? props.detail.mergeCapabilities.message
            : ""}
        </p>
      </Show>
      <Show
        when={
          props.detail.mergeCapabilities.status === "available" &&
          !props.detail.mergeCapabilities.complete
        }
      >
        <p class="text-warning">Merge capability evidence is incomplete. Merge is disabled.</p>
      </Show>
      <Show
        when={!intent()}
        fallback={
          <>
            <p role="status">
              {result()?.message ??
                "A merge was requested from this browser. Check its outcome before taking further action."}
            </p>
            <Show when={result()}>
              <p>Outcome: {result()?.status}</p>
            </Show>
            <Show when={result()?.observed}>
              {(observed) => (
                <p class="text-sm text-text-muted">
                  Observed {observed().state.toLowerCase()} · Head <code>{observed().headSha}</code>{" "}
                  · Queue{" "}
                  {observed().queued === null
                    ? "unknown"
                    : observed().queued
                      ? "queued"
                      : "not queued"}
                </p>
              )}
            </Show>
            <Show when={result()?.status === "uncertain" && result()?.observed?.state === "MERGED"}>
              <p class="text-sm text-text-muted">
                This observation does not confirm that this attempt merged the pinned head.
              </p>
            </Show>
            <Button size="sm" disabled={busy()} onClick={reconcile}>
              Check outcome
            </Button>
            <Show when={result()?.status === "rejected"}>
              <p class="text-sm text-text-muted">
                The server definitively rejected this attempt. A new attempt refreshes current
                actor, head and permissions; previous history stays saved.
              </p>
              <Button size="sm" disabled={busy()} onClick={newAttempt}>
                New merge attempt
              </Button>
            </Show>
          </>
        }
      >
        <div class="inline-flex max-w-full items-stretch">
          <Button
            variant={choice()?.action.kind === "admin-merge" ? "danger" : "success"}
            class="min-w-0 whitespace-normal text-left"
            disabled={busy() || blocked() || !!error()}
            onClick={merge}
          >
            {actionLabel()}
          </Button>
          <div class="flex shrink-0 border-l border-white/25">
            <Popover
              label="Choose merge method"
              trigger={<span aria-hidden="true">▾</span>}
              triggerVariant="success"
              disabled={busy() || !actions().length}
              width={336}
              align="left"
              onOpenChange={(open) => {
                if (open)
                  requestAnimationFrame(() => {
                    const target =
                      methodMenu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
                      methodMenu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
                    target?.focus({ preventScroll: true });
                  });
              }}
            >
              {(close) => (
                <div
                  ref={(element) => {
                    methodMenu = element;
                  }}
                  role="menu"
                  aria-label="Merge method"
                  class="space-y-1"
                  onKeyDown={(event) => {
                    const items = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitemradio"]',
                      ),
                    );
                    const index = items.indexOf(document.activeElement as HTMLButtonElement);
                    const next =
                      event.key === "ArrowDown"
                        ? (index + 1) % items.length
                        : event.key === "ArrowUp"
                          ? (index - 1 + items.length) % items.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? items.length - 1
                              : undefined;
                    if (next === undefined) return;
                    event.preventDefault();
                    items[next]?.focus();
                  }}
                >
                  <For each={actions()}>
                    {(entry) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected() === actionKey(entry.action)}
                        aria-disabled={!entry.enabled}
                        tabIndex={selected() === actionKey(entry.action) ? 0 : -1}
                        class="flex w-full gap-2 rounded-sm p-2 text-left hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-primary aria-checked:bg-bg-elevated"
                        onClick={() => {
                          if (!entry.enabled) return;
                          setSelected(actionKey(entry.action));
                          close();
                        }}
                      >
                        <span aria-hidden="true" class="w-4 shrink-0 text-success">
                          {selected() === actionKey(entry.action) ? "✓" : ""}
                        </span>
                        <span class="min-w-0 space-y-1">
                          <span class="block text-sm font-medium">{label(entry.action)}</span>
                          <span class="block text-xs text-text-muted">
                            {entry.action.kind === "admin-merge"
                              ? "Bypass branch protections. "
                              : ""}
                            {explanation(entry.action)}
                          </span>
                          <Show when={!entry.enabled}>
                            <span class="block text-xs text-warning">
                              {entry.reason ??
                                entry.reasonCode ??
                                "Unavailable in current GitHub capabilities."}
                            </span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </Popover>
          </div>
        </div>
        <Show when={choice()}>
          <p class="text-xs text-text-muted">
            {choice()?.action.kind === "admin-merge" ? "Administrator bypass selected. " : ""}
            {explanation(choice()!.action)}
          </p>
        </Show>
        <Show when={choice()?.reason}>
          <p class="text-text-muted">{choice()?.reason}</p>
        </Show>
        <Show when={choice()?.reasonCode}>
          <p class="text-xs text-text-muted">{choice()?.reasonCode}</p>
        </Show>
        <Show when={!actions().length}>
          <p>Merge capabilities unavailable.</p>
        </Show>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
