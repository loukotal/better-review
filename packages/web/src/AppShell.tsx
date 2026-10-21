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
  const [batchBusy, setBatchBusy] = createSignal<"retry" | "clear">();
  const [batchFeedback, setBatchFeedback] = createSignal<string>();
  const [operationFeedback, setOperationFeedback] = createSignal<Record<string, string>>({});
  const retries = new Map<string, number>();
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
  const publish = () => {
    const next = githubWrites.getStates();
    setOperationFeedback((previous) => {
      let result = previous;
      for (const state of next)
        for (const item of state.operations) {
          const before = retries.get(item.command.operationId);
          if (before === undefined) continue;
          const message =
            item.admissionTimedOut || item.operation?.timedOutAt
              ? "Timed out"
              : item.admissionError
                ? "Admission needs attention"
                : (item.operation?.attempts ?? 0) <= before
                  ? "Retry requested"
                  : item.status === "inflight" || item.status === "queued"
                    ? "Retrying…"
                    : item.status === "retry-failed"
                      ? `Retry failed${item.operation?.error?.httpStatus ? ` · HTTP ${item.operation.error.httpStatus}` : ""}`
                      : item.status === "uncertain"
                        ? "Delivery unknown"
                        : item.status === "synced"
                          ? "Confirmed on GitHub"
                          : "Retry state changed";
          if (previous[item.command.operationId] !== message)
            result = { ...result, [item.command.operationId]: message };
        }
      return result;
    });
    setRecoveryError(githubWrites.getRecoveryError());
    // Observe synchronously: a pending journal load and its completion may share a UI batch.
    for (const state of next) coordinator.observe(state);
    setStates((previous) => replaceEqualDeep(previous, next));
  };
  publish();
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
    setBatchBusy(kind);
    setBatchFeedback(undefined);
    const decisionIds = new Set<string>();
    if (kind === "retry") {
      githubWrites.setQueueTimeoutMs(getGithubSyncTimeoutMs());
      for (const state of githubWrites.getStates()) {
        const root = state.operations.find(
          (item) =>
            item.backendOwned &&
            !item.operation?.archivedAt &&
            !["synced", "cancelled"].includes(item.status),
        );
        if (root?.status === "retry-failed") {
          retries.set(root.command.operationId, root.operation?.attempts ?? 0);
          decisionIds.add(root.command.operationId);
        }
        for (const item of state.operations)
          if (!item.backendOwned && !item.blockedByOperationId) {
            retries.set(item.command.operationId, 0);
            decisionIds.add(item.command.operationId);
          }
      }
    }
    try {
      const receipt = await (kind === "retry" ? githubWrites.retryAll() : githubWrites.clearAll());
      if (receipt.outcome === "rejected") throw new Error(receipt.error.message);
      publish();
      if (kind === "clear") {
        retries.clear();
        const archived = receipt.operations.filter((item) => item.archivedAt).length;
        const cancelled = receipt.operations.filter((item) => item.status === "cancelled").length;
        setBatchFeedback(
          `Cleared ${cancelled}${archived ? ` · archived ${archived} with delivery unknown` : ""}. Content saved in Drafts & history.`,
        );
      } else {
        const ids = new Set([
          ...decisionIds,
          ...receipt.operations.map((item) => item.command.operationId),
        ]);
        const scopes = [
          ...new Map(
            githubWrites
              .getStates()
              .flatMap((state) => state.operations)
              .filter((item) => ids.has(item.command.operationId))
              .map((item) => [item.command.scope.url, item.command.scope]),
          ).values(),
        ];
        const unreadScopes = new Set<string>();
        for (const delay of [0, 150, 300, 600, 1200, 2400]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          const reads = await Promise.allSettled(
            scopes.map((scope) => githubWrites.snapshot(scope)),
          );
          for (let index = 0; index < reads.length; index++) {
            if (reads[index]?.status === "rejected") unreadScopes.add(scopes[index]!.url);
            else unreadScopes.delete(scopes[index]!.url);
          }
          const pending = githubWrites
            .getStates()
            .flatMap((state) => state.operations)
            .filter((item) => ids.has(item.command.operationId));
          if (
            pending.every(
              (item) =>
                (item.operation?.attempts ?? 0) > (retries.get(item.command.operationId) ?? -1) &&
                !["queued", "inflight"].includes(item.status),
            )
          )
            break;
        }
        publish();
        const latest = githubWrites
          .getStates()
          .flatMap((state) => state.operations)
          .filter((item) => ids.has(item.command.operationId));
        const failed = latest.filter((item) => item.status === "retry-failed").length;
        const confirmed = latest.filter((item) => item.status === "synced").length;
        const waiting = latest.filter(
          (item) =>
            !item.admissionError && ["queued", "inflight", "local-pending"].includes(item.status),
        ).length;
        const admissions = latest.filter((item) => !!item.admissionError).length;
        const parts = [
          confirmed ? `${confirmed} confirmed` : "",
          failed ? `${failed} retry failed` : "",
          waiting ? `${waiting} retry pending` : "",
          admissions ? `${admissions} admission needs attention` : "",
          unreadScopes.size ? `${unreadScopes.size} status reads unavailable` : "",
          receipt.requiresConfirmation.length
            ? `${receipt.requiresConfirmation.length} delivery unknown · confirmation required`
            : "",
          receipt.skipped.length ? `${receipt.skipped.length} unchanged` : "",
        ].filter(Boolean);
        setBatchFeedback(parts.join(" · ") || "No eligible failed actions to retry.");
      }
    } catch (cause) {
      if (kind === "retry") {
        for (const id of decisionIds) retries.delete(id);
        setOperationFeedback((previous) => ({
          ...previous,
          ...Object.fromEntries([...decisionIds].map((id) => [id, "Retry not acknowledged"])),
        }));
      }
      setBatchFeedback(
        `${kind === "retry" ? "Retry" : "Clear"} not acknowledged: ${cause instanceof Error ? cause.message : "saved work retained"}`,
      );
    } finally {
      setBatchBusy(undefined);
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
