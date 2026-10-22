import { useSearchParams, useLocation } from "@solidjs/router";
import { replaceEqualDeep } from "@tanstack/solid-query";
import {
  createMemo,
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  type ParentComponent,
} from "solid-js";

import { GithubPendingPanel } from "./components/GithubPendingPanel";
import { GithubQueueContext } from "./context/GithubQueueContext";
import { getGithubSyncTimeoutMs } from "./lib/github-queue-settings";
import { createGithubSyncRefreshCoordinator } from "./lib/github-sync-refresh";
import { githubWrites, githubPrScope, refreshGithubActor } from "./lib/github-writes";
import {
  refreshPrExtras,
  refreshPrDetail,
  refreshPrListAfterReview,
  fencePrListAfterReview,
} from "./lib/query";

/** One queue/recovery/completion lifecycle, independent of page and PR tabs. */
export const AppShell: ParentComponent = (props) => {
  const location = useLocation();
  const [params] = useSearchParams();
  const [states, setStates] = createSignal(githubWrites.getStates());
  const [error, setError] = createSignal<string>();
  const [recoveryError, setRecoveryError] = createSignal<string>();
  const decisions = githubWrites.createDecisions();
  const [decisionState, setDecisionState] = createSignal(decisions.getState());
  const batchBusy = () =>
    decisionState().busyKind === "retry-all"
      ? ("retry" as const)
      : decisionState().busyKind === "clear-all"
        ? ("clear" as const)
        : undefined;
  const [batchFeedback, setBatchFeedback] = createSignal<string>();
  const [operationFeedback, setOperationFeedback] = createSignal<Record<string, string>>({});
  const selectedUrl = createMemo(() => {
    if (location.pathname !== "/review" || typeof params.prUrl !== "string") return;
    try {
      return githubPrScope(params.prUrl).url;
    } catch {
      return;
    }
  });
  const selectedScope = createMemo(() => {
    const url = selectedUrl();
    return url ? githubPrScope(url) : undefined;
  });
  const read = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError(undefined);
    } catch (cause) {
      setError(
        "An action may be synced, but its display could not be refreshed. Saved work is retained.",
      );
      throw cause;
    }
  };
  const coordinator = createGithubSyncRefreshCoordinator({
    global: true,
    onReviewCompletion: fencePrListAfterReview,
    refreshPr: (url) => read(() => refreshPrExtras(url)),
    refreshDetail: (url) => read(() => refreshPrDetail(url, { afterWrite: true })),
    refreshList: () => read(refreshPrListAfterReview),
  });
  const publishFeedback = () => {
    setOperationFeedback((previous) => {
      let result = previous;
      for (const [id, facts] of Object.entries(decisions.getState().retries)) {
        const message = facts.acknowledgementFailed
          ? "Retry not acknowledged"
          : facts.timedOut
            ? "Timed out"
            : facts.admissionError
              ? "Admission needs attention"
              : !facts.advanced
                ? "Retry requested"
                : facts.status === "inflight" || facts.status === "queued"
                  ? "Retrying…"
                  : facts.status === "retry-failed"
                    ? `Retry failed${facts.backendError?.httpStatus ? ` · HTTP ${facts.backendError.httpStatus}` : ""}`
                    : facts.status === "uncertain"
                      ? "Delivery unknown"
                      : facts.status === "synced"
                        ? "Confirmed on GitHub"
                        : "Retry state changed";
        if (previous[id] !== message) result = { ...result, [id]: message };
      }
      return result;
    });
  };
  const publish = () => {
    const next = githubWrites.getStates();
    setRecoveryError(githubWrites.getRecoveryError());
    // Observe synchronously: a pending journal load and its completion may share a UI batch.
    for (const state of next) coordinator.observe(state);
    setStates((previous) => replaceEqualDeep(previous, next));
  };
  publish();
  onCleanup(
    decisions.subscribe(() => {
      setDecisionState(decisions.getState());
      publishFeedback();
    }),
  );
  onCleanup(() => decisions.dispose());
  onCleanup(githubWrites.subscribe(publish));
  onCleanup(() => coordinator.dispose());
  createEffect(() => githubWrites.activate(selectedScope()));
  onCleanup(() => githubWrites.activate());
  onMount(() => {
    const stop = githubWrites.startRecovery();
    void refreshGithubActor().catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshGithubActor().catch(() => {});
    }, 15_000);
    onCleanup(() => {
      stop();
      clearInterval(timer);
    });
  });
  const refresh = async () => {
    await githubWrites.recoverAll();
    publish();
  };
  const batch = async (kind: "retry" | "clear") => {
    if (batchBusy()) return;
    setBatchFeedback(undefined);
    const result = await decisions.run(
      kind === "retry"
        ? { kind: "retry-all", timeoutMs: getGithubSyncTimeoutMs() }
        : { kind: "clear-all" },
    );
    if (result.kind === "acknowledged" && result.summary) {
      const summary = result.summary;
      if (kind === "clear") {
        setBatchFeedback(
          `Cleared ${summary.cancelled}${summary.archived ? ` · archived ${summary.archived} with delivery unknown` : ""}. Content saved in Drafts & history.`,
        );
      } else {
        const parts = [
          summary.confirmed ? `${summary.confirmed} confirmed` : "",
          summary.retryFailed ? `${summary.retryFailed} retry failed` : "",
          summary.pending ? `${summary.pending} retry pending` : "",
          summary.admissionAttention
            ? `${summary.admissionAttention} admission needs attention`
            : "",
          summary.unavailableReads ? `${summary.unavailableReads} status reads unavailable` : "",
          summary.requiresConfirmation
            ? `${summary.requiresConfirmation} delivery unknown · confirmation required`
            : "",
          summary.skipped ? `${summary.skipped} unchanged` : "",
        ].filter(Boolean);
        setBatchFeedback(parts.join(" · ") || "No eligible failed actions to retry.");
      }
    } else if (result.kind === "rejected" || result.kind === "unavailable") {
      setBatchFeedback(
        `${kind === "retry" ? "Retry" : "Clear"} not acknowledged: ${result.message ?? "saved work retained"}`,
      );
    }
  };
  return (
    <GithubQueueContext.Provider
      value={{
        states,
        selectedScope,
        error: () => error() ?? recoveryError(),
        refresh,
        loadHistory: () => githubWrites.discoverSavedScopes(),
        retryAll: () => batch("retry"),
        clearAll: () => batch("clear"),
        batchBusy,
        batchFeedback,
        operationFeedback,
      }}
    >
      {props.children}
      <GithubPendingPanel />
    </GithubQueueContext.Provider>
  );
};
