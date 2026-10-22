import type {
  GithubOutboxBatchReceipt,
  GithubOutboxControlReceipt,
  GithubOutboxControl,
  GithubOutboxOperation,
  GithubPrScope,
} from "@better-review/shared";

import {
  githubDeliveryCheckOutcome,
  type GithubDeliveryCheckOutcome,
} from "./github-delivery-check";
import type { BrowserGithubOperation, BrowserGithubState } from "./github-outbox";

export type GithubQueueDecision =
  | { kind: "retry-all"; timeoutMs: number }
  | { kind: "clear-all" }
  | { kind: "retry-admission"; scope: GithubPrScope; operationId: string; timeoutMs: number }
  | {
      kind: "retry" | "reconcile" | "cancel" | "allow-manual-retry";
      scope: GithubPrScope;
      operation: BrowserGithubOperation;
      timeoutMs?: number;
    };

export interface GithubRetryFacts {
  baselineAttempts?: number;
  attempts: number;
  advanced: boolean;
  status: BrowserGithubOperation["status"];
  admissionError?: string;
  timedOut: boolean;
  backendError?: GithubOutboxOperation["error"];
  acknowledgementFailed?: boolean;
}

export interface GithubDecisionSummary {
  confirmed: number;
  retryFailed: number;
  pending: number;
  admissionAttention: number;
  unavailableReads: number;
  requiresConfirmation: number;
  skipped: number;
  cancelled: number;
  archived: number;
}

type Receipt = GithubOutboxControlReceipt | GithubOutboxBatchReceipt;
export type GithubDecisionResult =
  | { kind: "acknowledged"; receipt?: Receipt; summary?: GithubDecisionSummary }
  | { kind: "rejected"; message: string }
  | { kind: "unavailable"; message?: string; receipt?: Receipt }
  | { kind: "ignored" }
  | { kind: "disposed" };

export interface GithubDecisionsState {
  busyKind?: GithubQueueDecision["kind"];
  checkingDelivery?: string;
  retries: Record<string, GithubRetryFacts>;
  deliveryChecks: Record<
    string,
    { ackRevision: number; outcome: GithubDeliveryCheckOutcome; at?: string }
  >;
  result?: GithubDecisionResult;
}

export interface GithubDecisions {
  getState(): GithubDecisionsState;
  subscribe(listener: () => void): () => void;
  run(input: GithubQueueDecision): Promise<GithubDecisionResult>;
  dispose(): void;
}

/** Internal distinction: a definitive rejection must never look like a lost ack. */
export class GithubDecisionRejected extends Error {}

const delays = [0, 150, 300, 600, 1200, 2400];

interface DecisionOutbox {
  getStates(): BrowserGithubState[];
  subscribe(listener: () => void): () => void;
  setQueueTimeoutMs(value: number): void;
  retryAdmission(scope: GithubPrScope, operationId: string): Promise<unknown>;
  control(scope: GithubPrScope, control: GithubOutboxControl): Promise<GithubOutboxControlReceipt>;
  retryAll(): Promise<GithubOutboxBatchReceipt>;
  clearAll(): Promise<GithubOutboxBatchReceipt>;
  snapshot(scope: GithubPrScope): Promise<BrowserGithubState>;
}

/** Created only by the outbox. No discovery, persistence, or independent transport. */
export function createGithubDecisions(
  outbox: DecisionOutbox,
  uuid: () => string,
  released: () => void,
): GithubDecisions {
  let state: GithubDecisionsState = { retries: {}, deliveryChecks: {} };
  let disposed = false;
  const listeners = new Set<() => void>();
  const waits = new Set<() => void>();
  let releaseRun!: (result: GithubDecisionResult) => void;
  const stopped = new Promise<GithubDecisionResult>((resolve) => {
    releaseRun = resolve;
  });
  const publish = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const all = () => outbox.getStates().flatMap((value) => value.operations);
  function track(item: BrowserGithubOperation, baselineAttempts: number) {
    const attempts = item.operation?.attempts ?? 0;
    state.retries[item.command.operationId] = {
      baselineAttempts,
      attempts,
      advanced: attempts > baselineAttempts,
      status: item.status,
      admissionError: item.admissionError,
      timedOut: !!(item.admissionTimedOut || item.operation?.timedOutAt),
      backendError: item.operation?.error,
    };
  }
  function observe() {
    if (disposed) return;
    for (const item of all()) {
      const id = item.command.operationId;
      const retry = state.retries[id];
      if (retry?.baselineAttempts !== undefined) track(item, retry.baselineAttempts);
      const check = state.deliveryChecks[id];
      if (check?.outcome === "pending") {
        const outcome = githubDeliveryCheckOutcome(check.ackRevision, item.operation);
        if (outcome !== "pending")
          state.deliveryChecks[id] = { ...check, outcome, at: item.operation?.updatedAt };
      }
    }
    // Fresh root for signal-based consumers; maps are never exposed by reference.
    state = { ...state };
    publish();
  }
  const unsubscribe = outbox.subscribe(observe);
  function sleep(ms: number) {
    if (!ms || disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waits.add(done);
    });
  }
  async function perform(input: GithubQueueDecision): Promise<GithubDecisionResult> {
    if (disposed) return { kind: "disposed" };
    if (state.busyKind) return { kind: "ignored" };
    const decision = structuredClone(input);
    if ("operation" in decision && !decision.operation.operation) return { kind: "ignored" };
    state = { ...state, busyKind: decision.kind, result: undefined };
    const initialIds = new Set<string>();
    let receipt: Receipt | undefined;
    const single = "operation" in decision ? decision.operation : undefined;
    const id = single?.command.operationId;
    const check = (ackRevision: number, outcome: GithubDeliveryCheckOutcome, at?: string) => {
      if (!disposed && id)
        state.deliveryChecks[id] = { ackRevision, outcome, ...(at ? { at } : {}) };
    };
    if (decision.kind === "retry-all") {
      // Feedback is narrower than batchAll's execution plan: only a failed
      // backend root, plus every unblocked local intent (even without an error).
      for (const value of outbox.getStates()) {
        const root = value.operations.find(
          (item) =>
            item.backendOwned &&
            !item.operation?.archivedAt &&
            !["synced", "cancelled"].includes(item.status),
        );
        if (root?.status === "retry-failed") {
          track(root, root.operation?.attempts ?? 0);
          initialIds.add(root.command.operationId);
        }
        for (const item of value.operations)
          if (!item.backendOwned && !item.blockedByOperationId) {
            track(item, 0);
            initialIds.add(item.command.operationId);
          }
      }
    }
    if (decision.kind === "retry" && single) track(single, single.operation!.attempts);
    if (decision.kind === "reconcile" && single) {
      state.checkingDelivery = id;
      check(single.operation!.revision, "pending");
    }
    publish();
    if (disposed) return { kind: "disposed" };
    let result: GithubDecisionResult;
    try {
      if (decision.kind === "retry-all") outbox.setQueueTimeoutMs(decision.timeoutMs);
      if (decision.kind === "retry-admission") {
        outbox.setQueueTimeoutMs(decision.timeoutMs);
        await outbox.retryAdmission(decision.scope, decision.operationId);
      } else if (decision.kind === "retry-all" || decision.kind === "clear-all") {
        receipt = await (decision.kind === "retry-all" ? outbox.retryAll() : outbox.clearAll());
      } else {
        receipt = await outbox.control(decision.scope, {
          ...(decision.kind === "allow-manual-retry"
            ? {
                kind: "resolve-uncertainty" as const,
                resolution: { kind: "confirm-not-applied" as const },
              }
            : decision.kind === "retry"
              ? {
                  kind: decision.kind,
                  ...(decision.timeoutMs !== undefined
                    ? { queueTimeoutMs: decision.timeoutMs }
                    : {}),
                }
              : { kind: decision.kind }),
          requestId: uuid(),
          operationId: decision.operation.command.operationId,
          expectedRevision: decision.operation.operation!.revision,
        });
      }
      if (disposed) return { kind: "disposed" };
      if (receipt?.outcome === "rejected") throw new GithubDecisionRejected(receipt.error.message);
      if (decision.kind === "clear-all") state.retries = {};
      if (
        (decision.kind === "retry" || decision.kind === "reconcile") &&
        receipt &&
        "operation" in receipt
      ) {
        const ackRevision = receipt.operation.revision;
        if (decision.kind === "reconcile") {
          // control() publishes its receipt against the supplied baseline first.
          // Reset afterwards: scheduling is not a completed GitHub read.
          check(ackRevision, "pending");
          publish();
        }
        let outcome: GithubDeliveryCheckOutcome = "pending";
        for (const delay of delays) {
          if (decision.kind === "reconcile" && outcome !== "pending") break;
          if (delay) await sleep(delay);
          if (disposed) return { kind: "disposed" };
          const fresh = await outbox.snapshot(decision.scope);
          if (disposed) return { kind: "disposed" };
          const operation = fresh.operations.find(
            (item) => item.command.operationId === id,
          )?.operation;
          if (decision.kind === "retry") {
            if (
              operation &&
              operation.attempts > single!.operation!.attempts &&
              !["queued", "inflight"].includes(operation.status)
            )
              break;
          } else {
            outcome = githubDeliveryCheckOutcome(ackRevision, operation);
            if (outcome !== "pending") {
              check(ackRevision, outcome, operation?.updatedAt);
              publish();
            }
          }
        }
        // Exhaustion leaves pending checks subscribed; read failures below are
        // sticky and cannot be revived by an unrelated later publication.
      }
      let summary: GithubDecisionSummary | undefined;
      if (receipt && "operations" in receipt) {
        const ids = new Set([
          ...initialIds,
          ...receipt.operations.map((item) => item.command.operationId),
        ]);
        const unread = new Set<string>();
        if (decision.kind === "retry-all") {
          const scopes = [
            ...new Map(
              all()
                .filter((item) => ids.has(item.command.operationId))
                .map((item) => [item.command.scope.url, item.command.scope]),
            ).values(),
          ];
          for (const delay of delays) {
            if (delay) await sleep(delay);
            if (disposed) return { kind: "disposed" };
            const reads = await Promise.allSettled(
              scopes.map((scope) => (disposed ? Promise.resolve() : outbox.snapshot(scope))),
            );
            if (disposed) return { kind: "disposed" };
            for (let index = 0; index < reads.length; index++) {
              if (reads[index]?.status === "rejected") unread.add(scopes[index]!.url);
              else unread.delete(scopes[index]!.url);
            }
            if (
              all()
                .filter((item) => ids.has(item.command.operationId))
                .every(
                  (item) =>
                    (item.operation?.attempts ?? 0) >
                      (state.retries[item.command.operationId]?.baselineAttempts ?? -1) &&
                    !["queued", "inflight"].includes(item.status),
                )
            )
              break;
          }
        }
        const latest = all().filter((item) => ids.has(item.command.operationId));
        summary = {
          confirmed: latest.filter((item) => item.status === "synced").length,
          retryFailed: latest.filter((item) => item.status === "retry-failed").length,
          pending: latest.filter(
            (item) =>
              !item.admissionError && ["queued", "inflight", "local-pending"].includes(item.status),
          ).length,
          admissionAttention: latest.filter((item) => !!item.admissionError).length,
          unavailableReads: unread.size,
          requiresConfirmation: receipt.requiresConfirmation.length,
          skipped: receipt.skipped.length,
          cancelled: receipt.operations.filter((item) => item.status === "cancelled").length,
          archived: receipt.operations.filter((item) => item.archivedAt).length,
        };
      }
      result = {
        kind: "acknowledged",
        ...(receipt ? { receipt } : {}),
        ...(summary ? { summary } : {}),
      };
    } catch (cause) {
      if (disposed) return { kind: "disposed" };
      if (decision.kind === "reconcile")
        check(state.deliveryChecks[id!]?.ackRevision ?? single!.operation!.revision, "failed");
      if (decision.kind === "retry-all") {
        for (const operationId of initialIds) {
          const facts = state.retries[operationId];
          if (facts)
            state.retries[operationId] = {
              ...facts,
              baselineAttempts: undefined,
              acknowledgementFailed: true,
            };
        }
      }
      result =
        cause instanceof GithubDecisionRejected
          ? { kind: "rejected", message: cause.message }
          : {
              kind: "unavailable",
              ...(cause instanceof Error ? { message: cause.message } : {}),
              ...(receipt ? { receipt } : {}),
            };
    } finally {
      if (!disposed) {
        state = { ...state, busyKind: undefined, checkingDelivery: undefined };
      }
    }
    state = { ...state, result };
    publish();
    return result;
  }
  return {
    getState: (): GithubDecisionsState => structuredClone(state),
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    run: (input) => Promise.race([perform(input), stopped]),
    dispose() {
      if (disposed) return;
      disposed = true;
      // Detach observation, not the already-started durable outbox action.
      releaseRun({ kind: "disposed" });
      unsubscribe();
      for (const done of waits) done();
      listeners.clear();
      released();
    },
  };
}
