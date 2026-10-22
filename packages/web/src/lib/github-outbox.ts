import {
  DEFAULT_GITHUB_QUEUE_TIMEOUT_MS,
  isGithubQueueTimeoutMs,
  isGithubOutboxBatchControl,
  type GithubOutboxBatchControl,
  type GithubOutboxBatchReceipt,
  type GithubOutboxAdmissionCycle,
  isGithubActor,
  isGithubOutboxCommand,
  isGithubOutboxControl,
  isGithubPrScope,
  type GithubActor,
  type GithubOutboxCommand,
  type GithubOutboxControl,
  type GithubOutboxControlReceipt,
  type GithubOutboxHeartbeat,
  type GithubOutboxOperation,
  type GithubOutboxPendingScope,
  type GithubOutboxReceipt,
  type GithubOutboxSnapshot,
  type GithubPrScope,
  type GithubWriteAction,
} from "@better-review/shared";

import { createGithubDecisions, GithubDecisionRejected } from "./github-outbox-decisions";
import { createGithubDependencyGraph } from "./github-outbox-dependencies";
import {
  createIndexedDbGithubJournal,
  githubCommandFingerprint,
  isGithubAdmissionRetryable,
  normalizeGithubPrScope,
  type BrowserGithubJournal,
  type GithubAdmission,
} from "./github-outbox-journal";

export interface GithubOutboxTransport {
  enqueue(
    command: GithubOutboxCommand,
    cycle?: GithubOutboxAdmissionCycle,
  ): Promise<GithubOutboxReceipt>;
  snapshot(scope: GithubPrScope): Promise<GithubOutboxSnapshot>;
  control(control: GithubOutboxControl): Promise<GithubOutboxControlReceipt>;
  heartbeat(value: GithubOutboxHeartbeat): Promise<void>;
  listPending?(): Promise<GithubOutboxPendingScope[]>;
  batchControl?(control: GithubOutboxBatchControl): Promise<GithubOutboxBatchReceipt>;
}

export interface BrowserGithubOperation {
  /** Durable admission aliases that produced this canonical operation. */
  submittedOperationIds?: readonly string[];
  command: GithubOutboxCommand;
  backendOwned: boolean;
  status: GithubOutboxOperation["status"] | "local-pending";
  operation?: GithubOutboxOperation;
  draftKey?: string;
  admissionError?: string;
  admissionRetryAt?: string;
  admissionRetryable?: boolean;
  admissionTimedOut?: boolean;
  admissionDeadlineAt?: string;
  /** This PR's FIFO cannot advance until this earlier operation is resolved. */
  blockedByOperationId?: string;
}

export interface BrowserGithubState {
  scope: GithubPrScope;
  revision: number;
  operations: BrowserGithubOperation[];
  pendingCount: number;
  busy: boolean;
  /** Browser-only work before durable acknowledgement. Never a backend operation. */
  pendingSaving: number;
  error?: string;
}

interface ScopeState {
  scope: GithubPrScope;
  revision: number;
  operations: Map<string, GithubOutboxOperation>;
  admissions: GithubAdmission[];
  pendingSaving: number;
  error?: string;
}

export interface SubmitGithubWrite {
  scope: GithubPrScope;
  /** Must be known at submission time; never filled in after an await. */
  actor: GithubActor | undefined;
  action: GithubWriteAction;
  dependencies?: string[];
  operationId?: string;
  draftKey?: string;
}

// Custom/in-memory journals share this short fence across store instances. The
// IndexedDB journal additionally supplies its own cross-tab transaction fence.
const journalFences = new WeakMap<BrowserGithubJournal, Promise<void>>();
function withJournalFence<T>(journal: BrowserGithubJournal, work: () => Promise<T>): Promise<T> {
  const previous = journalFences.get(journal) ?? Promise.resolve();
  const result = previous.then(work);
  journalFences.set(
    journal,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}

/** Plain reactive store: subscribe + getState also works with Solid createSignal. */
export function createGithubOutbox(options: {
  transport: GithubOutboxTransport;
  journal?: BrowserGithubJournal;
  uuid?: () => string;
  clientId?: string;
  pollMs?: number;
  now?: () => number;
  /** HTTP acknowledgement bound, independent of the user-visible queue cycle. */
  requestTimeoutMs?: number;
  /** Injectable for tests; Web Locks avoid simultaneous admissions across tabs. */
  lock?: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}) {
  const journal = options.journal ?? createIndexedDbGithubJournal();
  const now = options.now ?? Date.now;
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1 ||
      options.requestTimeoutMs > 300_000)
  )
    throw new Error("Invalid GitHub acknowledgement timeout");
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  // Per instance/tab, NOT localStorage (which would make tabs share a lease).
  const clientId = options.clientId ?? uuid();
  const states = new Map<string, ScopeState>();
  const listeners = new Set<() => void>();
  const decisionOwners = new Set<{ dispose(): void }>();
  const flights = new Map<string, Promise<unknown>>();
  let closed = false;
  let active: GithubPrScope | undefined;
  let visible = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let detachVisibility: (() => void) | undefined;
  let heartbeatChain: Promise<void> = Promise.resolve();
  let stopRecovery: (() => void) | undefined;
  let recoveryError: string | undefined;
  let queueTimeoutMs = DEFAULT_GITHUB_QUEUE_TIMEOUT_MS;
  const cancelAdmissions = new Set<() => void>();
  async function boundedRequest<T>(
    work: () => Promise<T>,
    timeoutMs = options.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    if (timeoutMs <= 0) throw new Error("GitHub request cycle already expired");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new Error("GitHub request stopped before acknowledgement"));
          cancelAdmissions.add(cancel);
          timer = setTimeout(
            () => reject(new Error("GitHub request acknowledgement timed out")),
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) cancelAdmissions.delete(cancel);
    }
  }
  const pendingBatchCache = new Map<string, GithubOutboxBatchControl>();
  const clearHeldIds = new Set<string>();
  let planningClear = 0;
  function updateClearHolds() {
    clearHeldIds.clear();
    for (const request of pendingBatchCache.values())
      if (request.kind === "clear")
        for (const command of request.commands ?? []) clearHeldIds.add(command.operationId);
  }
  async function pendingBatches() {
    if (journal.batches) {
      const durable = await journal.batches();
      pendingBatchCache.clear();
      for (const request of durable) pendingBatchCache.set(request.requestId, request);
    }
    updateClearHolds();
    return [...pendingBatchCache.values()];
  }
  const localDeadline = (entry: GithubAdmission) =>
    Date.parse(
      entry.admissionDeadlineAt ??
        entry.command.queueDeadlineAt ??
        new Date(
          (entry.admittedAt ? Date.parse(entry.admittedAt) : now()) +
            (entry.command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
        ).toISOString(),
    );

  const emit = () => {
    for (const listener of listeners) listener();
  };
  function state(scope: GithubPrScope): ScopeState {
    scope = normalizeGithubPrScope(scope);
    if (!isGithubPrScope(scope)) throw new Error("Invalid canonical GitHub pull request");
    let value = states.get(scope.url);
    if (!value) {
      value = {
        scope: structuredClone(scope),
        revision: -1,
        operations: new Map(),
        admissions: [],
        pendingSaving: 0,
      };
      states.set(scope.url, value);
    }
    return value;
  }
  function getState(scope: GithubPrScope): BrowserGithubState {
    const value = state(scope);
    const operations = new Map<string, BrowserGithubOperation>();
    for (const entry of value.admissions) {
      const id = entry.operation?.command.operationId ?? entry.command.operationId;
      const cached = value.operations.get(id);
      const operation =
        entry.operation && (!cached || entry.operation.revision > cached.revision)
          ? entry.operation
          : (cached ?? entry.operation);
      const timedOut =
        !entry.backendOwned &&
        (entry.admissionTimedOut ||
          ((!entry.admissionError || isGithubAdmissionRetryable(entry)) &&
            localDeadline(entry) <= now()));
      operations.set(id, {
        command: operation?.command ?? entry.command,
        backendOwned: entry.backendOwned,
        status: operation?.status ?? "local-pending",
        operation,
        draftKey: entry.draftKey,
        admissionError:
          !entry.backendOwned && clearHeldIds.has(entry.command.operationId)
            ? "Clear is awaiting acknowledgement. This saved intent is paused; retry Clear if needed."
            : timedOut
              ? "Queue time limit reached before admission was acknowledged. Work is retained; retry the same saved intent or clear it."
              : entry.admissionError,
        admissionRetryAt: entry.admissionRetryAt,
        admissionRetryable:
          !timedOut &&
          !clearHeldIds.has(entry.command.operationId) &&
          isGithubAdmissionRetryable(entry),
        admissionTimedOut: !!timedOut,
        admissionDeadlineAt: new Date(localDeadline(entry)).toISOString(),
      });
    }
    for (const operation of value.operations.values()) {
      const prior = operations.get(operation.command.operationId);
      if (prior?.operation && prior.operation.revision > operation.revision) continue;
      operations.set(operation.command.operationId, {
        ...prior,
        command: operation.command,
        operation,
        backendOwned: prior?.backendOwned ?? true,
        status: operation.status,
      });
    }
    const aliases = new Map(
      value.admissions
        .filter((entry) => entry.operation)
        .map((entry) => [entry.command.operationId, entry.operation!.command.operationId]),
    );
    for (const [submitted, canonical] of aliases) {
      const item = operations.get(canonical);
      if (item) item.submittedOperationIds = [...(item.submittedOperationIds ?? []), submitted];
    }
    const canonicalGraph = createGithubDependencyGraph([...operations.values()], now(), aliases);
    for (const item of operations.values()) {
      item.command = structuredClone(item.command);
      item.command.dependencies = [
        ...new Set(item.command.dependencies.map(canonicalGraph.canonicalId)),
      ];
      if ("target" in item.command.action && item.command.action.target.source === "local")
        item.command.action.target.operationId = canonicalGraph.canonicalId(
          item.command.action.target.operationId,
        );
    }
    const list = [...operations.values()].sort(
      (a, b) =>
        (a.operation?.sequence ?? Number.MAX_SAFE_INTEGER) -
        (b.operation?.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    const first = list.find(
      (item) =>
        item.backendOwned &&
        !item.operation?.archivedAt &&
        !["synced", "cancelled"].includes(item.status),
    );
    const needsAttention =
      first &&
      (first.status === "uncertain" ||
        (first.status === "retry-failed" &&
          !(
            first.operation?.retryMode === "automatic" &&
            first.operation.error?.retryable &&
            first.operation.nextAttemptAt
          )));
    if (needsAttention)
      for (const item of list)
        if (item.backendOwned && item.status === "queued" && item !== first)
          item.blockedByOperationId = first.command.operationId;
    const graph = createGithubDependencyGraph(list, now(), aliases);
    for (const item of list) {
      if (item.status !== "local-pending") continue;
      const blocker = graph.blocker(item.command.operationId);
      if (blocker && blocker.kind !== "waiting") {
        if (blocker.operationId !== item.command.operationId || blocker.kind === "cycle")
          item.blockedByOperationId = blocker.operationId;
        if (blocker.kind === "cycle")
          item.admissionError = "Cyclic local GitHub dependency; saved work needs attention.";
      }
    }
    return structuredClone({
      scope: value.scope,
      revision: value.revision,
      operations: list,
      pendingCount: list.filter(
        (item) =>
          !item.operation?.archivedAt && item.status !== "synced" && item.status !== "cancelled",
      ).length,
      busy:
        value.pendingSaving > 0 ||
        list.some(
          (item) =>
            (!item.admissionError || item.admissionRetryable) &&
            !item.blockedByOperationId &&
            !item.operation?.archivedAt &&
            !item.operation?.timedOutAt &&
            !item.admissionTimedOut &&
            (["local-pending", "queued", "inflight"].includes(item.status) ||
              (item.status === "retry-failed" &&
                item.operation?.retryMode === "automatic" &&
                item.operation.error?.retryable &&
                !!item.operation.nextAttemptAt)),
        ),
      pendingSaving: value.pendingSaving,
      error: value.error,
    });
  }
  async function load(scope: GithubPrScope) {
    const entries = await journal.entries(scope);
    state(scope).admissions = entries;
    emit();
  }
  function merge(operation: GithubOutboxOperation) {
    const value = state(operation.command.scope);
    const previous = value.operations.get(operation.command.operationId);
    if (!previous || previous.revision <= operation.revision) {
      value.operations.set(operation.command.operationId, structuredClone(operation));
    }
  }
  async function remember(operation: GithubOutboxOperation, submittedOperationId?: string) {
    // Only claim ownership in the journal after this durable commit succeeds.
    await withJournalFence(journal, () => journal.acknowledge(operation, submittedOperationId));
    merge(operation);
    await load(operation.command.scope);
  }
  function single<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = flights.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      if (options.lock) return options.lock(key, work);
      if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(`better-review-github:${key}`, work);
      }
      return work();
    })();
    flights.set(key, promise);
    void promise
      .finally(() => {
        if (flights.get(key) === promise) flights.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  async function admit(scope: GithubPrScope, operationId: string, explicit = false) {
    return single(`admit:${operationId}`, async () => {
      if (closed) return;
      const entries = await journal.entries(scope);
      let entry = entries.find((item) => item.command.operationId === operationId);
      await pendingBatches();
      if (planningClear || clearHeldIds.has(operationId)) return;
      if (
        !entry ||
        entry.backendOwned ||
        (entry.admissionError && !isGithubAdmissionRetryable(entry) && !explicit)
      )
        return;
      if (localDeadline(entry) <= now()) {
        await journal.admissionFailed(
          operationId,
          "Queue time limit reached before admission acknowledgement. Retry explicitly or clear the saved action.",
          undefined,
          false,
          true,
        );
        await load(scope);
        return;
      }
      if (entry.admissionRetryAt && now() < Date.parse(entry.admissionRetryAt)) return;
      const graph = createGithubDependencyGraph(entries, now());
      // Check the entire graph before entering parent single-flights/HTTP. This
      // also prevents malformed cycles from deadlocking recursive admission.
      if (graph.blocker(operationId, explicit)) return;
      for (const dependency of entry.command.dependencies) {
        const parent = graph.entry(dependency);
        if (!parent || parent.backendOwned) continue;
        await admit(scope, parent.command.operationId);
        const updated = createGithubDependencyGraph(await journal.entries(scope), now());
        if (!updated.entry(dependency)?.backendOwned) return;
      }
      try {
        // Dependencies can await an arbitrarily late parent receipt. Re-read
        // ownership and Clear decisions atomically only after all such awaits.
        const start = (fresh: GithubAdmission[], batches: GithubOutboxBatchControl[]) => {
          const current = fresh.find((item) => item.command.operationId === operationId);
          const cleared = batches.some(
            (request) =>
              request.kind === "clear" &&
              ((request.commands ?? []).some((command) => command.operationId === operationId) ||
                request.operations.some(
                  (item) =>
                    item.operationId === operationId ||
                    item.operationId === current?.operation?.command.operationId,
                )),
          );
          if (
            closed ||
            planningClear ||
            clearHeldIds.has(operationId) ||
            cleared ||
            !current ||
            current.backendOwned ||
            (current.admissionError && !isGithubAdmissionRetryable(current) && !explicit) ||
            (current.admissionRetryAt && now() < Date.parse(current.admissionRetryAt))
          )
            return;
          const graph = createGithubDependencyGraph(fresh, now());
          if (
            graph.blocker(operationId, explicit) ||
            current.command.dependencies.some((id) => {
              const parent = graph.entry(id);
              return parent && !parent.backendOwned;
            })
          )
            return;
          // No await after this final guard and before starting transport. Keep
          // only a promise holder under the journal fence, never the HTTP wait.
          const flight = boundedRequest(
            () =>
              options.transport.enqueue(
                structuredClone(current.command),
                current.admissionRetryRequestId
                  ? {
                      requestId: current.admissionRetryRequestId,
                      queueTimeoutMs: current.admissionRetryTimeoutMs!,
                      queueDeadlineAt: current.admissionDeadlineAt!,
                    }
                  : undefined,
              ),
            Math.min(localDeadline(current) - now(), options.requestTimeoutMs ?? 30_000),
          );
          void flight.catch(() => {}); // Guard transaction may commit after an immediate rejection.
          return { entry: current, flight };
        };
        const started = journal.guardAdmission
          ? await journal.guardAdmission(scope, start)
          : await withJournalFence(journal, async () =>
              start(
                await journal.entries(scope),
                journal.batches ? await journal.batches() : [...pendingBatchCache.values()],
              ),
            );
        if (!started) {
          await load(scope);
          return;
        }
        entry = started.entry;
        const receipt = await started.flight;
        if (receipt.outcome === "rejected") {
          // No mutation was admitted. Replay the same actor-bound UUID after the
          // server's asynchronous identity cache initializes. Other rejections,
          // including review cooldowns, still require an explicit user decision.
          const automatic = receipt.error.code === "identity-unknown" && receipt.error.retryable;
          const retryAt = automatic
            ? new Date(
                Math.max(
                  now() + 15_000,
                  receipt.error.retryAt && Number.isFinite(Date.parse(receipt.error.retryAt))
                    ? Date.parse(receipt.error.retryAt)
                    : 0,
                ),
              ).toISOString()
            : (entry.command.action.kind === "approve" ||
                  entry.command.action.kind === "request-changes" ||
                  entry.command.action.kind === "review-comment") &&
                (receipt.error.code === "approval-cooldown" ||
                  receipt.error.code === "review-cooldown") &&
                receipt.error.retryAt &&
                Number.isFinite(Date.parse(receipt.error.retryAt))
              ? receipt.error.retryAt
              : undefined;
          await journal.admissionFailed(operationId, receipt.error.message, retryAt, automatic);
        } else {
          if (
            (receipt.outcome === "accepted" &&
              receipt.operation.command.operationId !== operationId) ||
            receipt.operation.command.scope.url !== scope.url ||
            receipt.operation.command.expectedActor.id !== entry.command.expectedActor.id ||
            receipt.operation.command.action.kind !== entry.command.action.kind
          )
            throw new Error("Invalid receipt");
          await remember(receipt.operation, operationId);
        }
        state(scope).error = undefined;
      } catch {
        // Ack may have been lost: leave backendOwned false and replay SAME command/ID.
        state(scope).error =
          "GitHub admission is not yet acknowledged; your work is saved locally.";
        if (localDeadline(entry) <= now())
          await journal.admissionFailed(
            operationId,
            "Queue time limit reached before admission acknowledgement. Delivery may already be in progress; retry the same saved ID or clear it.",
            undefined,
            false,
            true,
          );
      }
      await load(scope);
    });
  }
  async function sendControl(scope: GithubPrScope, control: GithubOutboxControl) {
    return single(`control:${control.requestId}`, async () => {
      const receipt = await boundedRequest(() =>
        options.transport.control(structuredClone(control)),
      );
      if (receipt.outcome !== "rejected") await remember(receipt.operation);
      await journal.removeControl(control.requestId);
      return receipt;
    });
  }
  async function snapshot(scope: GithubPrScope) {
    const captured = normalizeGithubPrScope(scope);
    return single(`snapshot:${captured.url}`, async () => {
      const remote = await boundedRequest(() => options.transport.snapshot(captured));
      if (remote.scope.url !== captured.url) throw new Error("Outbox snapshot scope mismatch");
      const value = state(captured);
      if (remote.revision < value.revision) return getState(captured);
      for (const operation of remote.operations) {
        if (operation.command.scope.url !== captured.url)
          throw new Error("Outbox operation scope mismatch");
        await remember(operation);
      }
      value.revision = remote.revision;
      // Don't drop receipt-confirmed operations absent from an older concurrent snapshot.
      value.error = undefined;
      await load(captured);
      return getState(captured);
    });
  }
  async function recover(scope: GithubPrScope) {
    const captured = normalizeGithubPrScope(scope);
    return single(`recover:${captured.url}`, async () => {
      await load(captured);
      for (const entry of await journal.entries(captured)) {
        if (closed) return;
        if (!entry.backendOwned) await admit(captured, entry.command.operationId);
      }
      for (const control of await journal.controls(captured)) {
        if (closed) return;
        await sendControl(captured, control);
      }
      if (!closed) await snapshot(captured);
    });
  }
  /** Recover only persisted explicit intents. No editors, generated reviews,
   * merge attempts, new UUIDs, or heartbeat leases are created by discovery. */
  async function recoverAll() {
    return single("recover-all", async () => {
      if (closed) return;
      let decisionFailed = false;
      for (const request of await pendingBatches()) {
        try {
          await sendBatch(request);
        } catch {
          decisionFailed = true;
          recoveryError =
            "A saved queue decision is not acknowledged; affected local intents remain paused.";
        }
      }
      const scopes = new Map<string, GithubPrScope>();
      for (const command of await journal.list()) scopes.set(command.scope.url, command.scope);
      for (const value of states.values())
        if (getState(value.scope).pendingCount) scopes.set(value.scope.url, value.scope);
      const remoteScopes = new Set<string>();
      try {
        for (const summary of options.transport.listPending
          ? await boundedRequest(() => options.transport.listPending!())
          : []) {
          scopes.set(summary.scope.url, summary.scope);
          remoteScopes.add(summary.scope.url);
        }
        if (!decisionFailed) recoveryError = undefined;
      } catch {
        // Backend discovery failure must not prevent local admission recovery.
        recoveryError = "GitHub queue discovery is unavailable; saved work is retained.";
      }
      const pending: GithubPrScope[] = [];
      for (const scope of scopes.values()) {
        const entries = await journal.entries(scope);
        if (
          remoteScopes.has(scope.url) ||
          getState(scope).pendingCount ||
          entries.some(
            (entry) =>
              !entry.operation?.archivedAt &&
              (!entry.backendOwned ||
                !["synced", "cancelled"].includes(entry.operation?.status ?? "queued")),
          ) ||
          (await journal.controls(scope)).length
        )
          pending.push(scope);
      }
      // A failed PR must not starve another; also bound client recovery fanout.
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, pending.length) }, async () => {
          while (!closed && index < pending.length) {
            const scope = pending[index++]!;
            try {
              await recover(scope);
            } catch {
              state(scope).error =
                "GitHub outbox is temporarily unavailable; saved work is retained.";
            }
          }
        }),
      );
      emit();
    });
  }
  async function sendBatch(request: GithubOutboxBatchControl): Promise<GithubOutboxBatchReceipt> {
    return single(`batch:${request.requestId}`, async () => {
      if (!options.transport.batchControl)
        throw new Error("This server does not support queue Retry/Clear yet");
      const receipt = await boundedRequest(() =>
        options.transport.batchControl!(structuredClone(request)),
      );
      if (receipt.outcome === "rejected") {
        // A definitive rejection means this decision did not apply. Keep only
        // transport/lost-ack uncertainty, never replay a stale rejected command.
        await journal.removeBatch?.(request.requestId);
        pendingBatchCache.delete(request.requestId);
        updateClearHolds();
        throw new GithubDecisionRejected(receipt.error.message);
      }
      for (const operation of receipt.operations) {
        const aliases = Object.entries(receipt.aliases)
          .filter(([, canonical]) => canonical === operation.command.operationId)
          .map(([id]) => id);
        if (!aliases.length) await remember(operation);
        else for (const id of aliases) await remember(operation, id);
      }
      pendingBatchCache.delete(request.requestId);
      await journal.removeBatch?.(request.requestId);
      updateClearHolds();
      // A later successful Clear can make an earlier stale Clear obsolete. Don't
      // retain an unfulfillable stale-CAS decision as a permanent recovery error.
      const settled = (id: string) =>
        [...states.values()].some((value) => {
          const op =
            value.operations.get(id) ??
            value.admissions.find((entry) => entry.command.operationId === id)?.operation;
          return op && (op.archivedAt || ["synced", "cancelled"].includes(op.status));
        });
      for (const prior of pendingBatchCache.values())
        if (
          prior.kind === "clear" &&
          prior.operations.every((item) => settled(item.operationId)) &&
          (prior.commands ?? []).every((command) => settled(command.operationId))
        ) {
          pendingBatchCache.delete(prior.requestId);
          await journal.removeBatch?.(prior.requestId);
          updateClearHolds();
        }
      return receipt;
    });
  }
  async function batchControl(input: GithubOutboxBatchControl) {
    if (closed) throw new Error("GitHub outbox is closed");
    const request = structuredClone(input);
    if (request.kind === "clear") planningClear++;
    try {
      if (request.kind === "retry") {
        request.queueTimeoutMs ??= queueTimeoutMs;
        request.queueDeadlineAt ??= new Date(now() + request.queueTimeoutMs).toISOString();
      } else {
        const scopes = new Set(request.commands?.map((command) => command.scope.url));
        for (const value of states.values())
          if (
            getState(value.scope).operations.some((item) =>
              request.operations.some((op) => op.operationId === item.command.operationId),
            )
          )
            scopes.add(value.scope.url);
        const commands = new Map(
          (request.commands ?? []).map((command) => [command.operationId, command]),
        );
        for (const scope of scopes)
          for (const entry of await journal.entries(stateFromUrl(scope)))
            if (!entry.backendOwned) commands.set(entry.command.operationId, entry.command);
        request.commands = [...commands.values()];
      }
      if (!isGithubOutboxBatchControl(request))
        throw new Error("Invalid queue Retry/Clear decision");
      await withJournalFence(journal, async () => {
        await journal.putBatch?.(request);
        pendingBatchCache.set(request.requestId, request);
        if (request.kind === "clear")
          for (const command of request.commands ?? []) clearHeldIds.add(command.operationId);
      });
      emit();
    } finally {
      if (request.kind === "clear") planningClear--;
    }
    return sendBatch(request);
  }
  function stateFromUrl(url: string): GithubPrScope {
    const known = states.get(url)?.scope;
    if (known) return known;
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    return { host: "github.com", owner: parts[1]!, repo: parts[2]!, number: Number(parts[4]), url };
  }
  async function batchAll(kind: "retry" | "clear"): Promise<GithubOutboxBatchReceipt> {
    const timeoutMs = queueTimeoutMs;
    const deadlineAt = new Date(now() + timeoutMs).toISOString();
    const requestId = uuid();
    if (kind === "clear") planningClear++;
    try {
      // Load persisted journal state without admitting it or replaying writes.
      const scopes = new Map([...states.values()].map((value) => [value.scope.url, value.scope]));
      for (const command of await journal.list()) scopes.set(command.scope.url, command.scope);
      for (const scope of scopes.values()) await load(scope);
      const operations: GithubOutboxBatchControl["operations"] = [];
      const commands: GithubOutboxCommand[] = [];
      const localOperations = new Map<string, GithubOutboxOperation>();
      const localUnknown = new Set<string>();
      let localPending = 0;
      for (const scope of scopes.values()) {
        const pending = getState(scope).operations.filter(
          (item) => !item.operation?.archivedAt && !["synced", "cancelled"].includes(item.status),
        );
        if (kind === "retry") {
          const root = pending.find((item) => item.backendOwned);
          if (root?.operation)
            operations.push({
              operationId: root.command.operationId,
              expectedRevision: root.operation.revision,
            });
          for (const item of pending)
            if (!item.backendOwned && (item.admissionError || item.admissionTimedOut)) {
              await retryAdmission(scope, item.command.operationId, {
                queueTimeoutMs: timeoutMs,
                queueDeadlineAt: deadlineAt,
              });
              const acknowledged = (await journal.entries(scope)).find(
                (entry) => entry.command.operationId === item.command.operationId,
              )?.operation;
              if (!acknowledged) localPending++;
              else if (acknowledged.status === "uncertain" || acknowledged.status === "inflight")
                localUnknown.add(acknowledged.command.operationId);
              else localOperations.set(acknowledged.command.operationId, acknowledged);
            }
        } else
          for (const item of pending) {
            if (item.backendOwned && item.operation)
              operations.push({
                operationId: item.command.operationId,
                expectedRevision: item.operation.revision,
              });
            else commands.push(item.command);
          }
      }
      const receipt = await batchControl({
        kind,
        requestId,
        operations,
        ...(kind === "clear"
          ? { commands }
          : { queueTimeoutMs: timeoutMs, queueDeadlineAt: deadlineAt }),
      });
      if (receipt.outcome === "rejected" || kind === "clear") return receipt;
      for (const operation of receipt.operations)
        localOperations.set(operation.command.operationId, operation);
      return {
        ...receipt,
        operations: [...localOperations.values()],
        localPending,
        requiresConfirmation: [...new Set([...receipt.requiresConfirmation, ...localUnknown])],
      };
    } finally {
      if (kind === "clear") planningClear--;
    }
  }
  async function retryAdmission(
    scope: GithubPrScope,
    operationId: string,
    policy?: { queueTimeoutMs: number; queueDeadlineAt: string },
  ) {
    const timeoutMs = policy?.queueTimeoutMs ?? queueTimeoutMs;
    const deadlineAt = policy?.queueDeadlineAt ?? new Date(now() + timeoutMs).toISOString();
    const requestId = uuid();
    const captured = normalizeGithubPrScope(scope);
    const entry = (await journal.entries(captured)).find(
      (item) => item.command.operationId === operationId,
    );
    if (
      entry &&
      !entry.backendOwned &&
      !(entry.admissionRetryAt && now() < Date.parse(entry.admissionRetryAt))
    ) {
      if (!journal.restartAdmissionCycle)
        throw new Error("Local storage cannot restart this saved queue cycle");
      await journal.restartAdmissionCycle(operationId, deadlineAt, requestId, timeoutMs);
    }
    return admit(captured, operationId, true);
  }
  /** Lazy local history discovery, independent of write recovery and PR leases. */
  async function discoverSavedScopes() {
    return single("discover-saved-scopes", async () => {
      if (closed) return;
      const scopes = new Map<string, GithubPrScope>();
      for (const command of await journal.list()) scopes.set(command.scope.url, command.scope);
      for (const scope of (await journal.draftScopes?.()) ?? []) scopes.set(scope.url, scope);
      // Local journal hydration only. Terminal history must not take the recover()
      // path, which can perform admissions, replay controls and request snapshots.
      let index = 0;
      const saved = [...scopes.values()];
      await Promise.all(
        Array.from({ length: Math.min(2, saved.length) }, async () => {
          while (!closed && index < saved.length) {
            const scope = saved[index++]!;
            state(scope).admissions = await journal.entries(scope);
          }
        }),
      );
      if (!closed) emit();
    });
  }
  /** App-shell lifecycle, independent of PR navigation and tab visibility.
   * Closing the browser before backend acknowledgement leaves work in IndexedDB
   * until this lifecycle runs on the next app open. */
  function startRecovery() {
    if (closed) throw new Error("GitHub outbox is closed");
    if (stopRecovery) return stopRecovery;
    const run = () => {
      emit(); // publish elapsed deadlines even while an admission HTTP request is held
      void recoverAll().catch(() => {
        recoveryError = "GitHub queue recovery is unavailable; saved work is retained.";
        emit();
      });
    };
    const timer = setInterval(run, options.pollMs ?? 2_000);
    if (typeof window !== "undefined") window.addEventListener("pageshow", run);
    const stop = () => {
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("pageshow", run);
      if (stopRecovery === stop) stopRecovery = undefined;
    };
    stopRecovery = stop;
    run();
    return stop;
  }
  function background(work: Promise<unknown>, scope: GithubPrScope) {
    void work.catch(() => {
      state(scope).error = "GitHub outbox is temporarily unavailable; saved work is retained.";
      emit();
    });
  }
  async function heartbeat(scope: GithubPrScope, isVisible: boolean) {
    const value = { clientId, scope: normalizeGithubPrScope(scope), visible: isVisible };
    // Navigation release cannot be overtaken by an earlier visibility heartbeat.
    const next = heartbeatChain
      .catch(() => {})
      .then(() => boundedRequest(() => options.transport.heartbeat(value)));
    heartbeatChain = next;
    await next;
  }
  function setVisible(next: boolean) {
    visible = next;
    if (!active || closed) return;
    background(heartbeat(active, visible), active);
    if (visible) background(recover(active), active);
  }
  function activate(
    scope?: GithubPrScope,
    isVisible = typeof document === "undefined" || document.visibilityState === "visible",
  ) {
    if (closed) throw new Error("GitHub outbox is closed");
    if (scope) state(scope);
    if (active) background(heartbeat(active, false), active);
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    detachVisibility?.();
    active = scope ? normalizeGithubPrScope(scope) : undefined;
    visible = isVisible;
    if (!active) return;
    const captured = active;
    background(load(captured), captured);
    background(heartbeat(captured, visible), captured);
    if (visible) background(recover(captured), captured);
    heartbeatTimer = setInterval(() => {
      if (visible) background(heartbeat(captured, true), captured);
    }, 15_000);
    // Active PR UI refresh. Global admission recovery has its own app lifecycle.
    pollTimer = setInterval(() => {
      if (visible) background(recover(captured), captured);
    }, options.pollMs ?? 2_000);
    if (typeof document !== "undefined") {
      const change = () => setVisible(document.visibilityState === "visible");
      const hide = () => setVisible(false);
      document.addEventListener("visibilitychange", change);
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", change);
      detachVisibility = () => {
        document.removeEventListener("visibilitychange", change);
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", change);
      };
    }
  }

  function beginSaving(scope: GithubPrScope) {
    const value = state(scope);
    value.pendingSaving++;
    emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      value.pendingSaving--;
      emit();
    };
  }

  const api = {
    createDecisions(): ReturnType<typeof createGithubDecisions> {
      const owner = createGithubDecisions(api, uuid, () => decisionOwners.delete(owner));
      decisionOwners.add(owner);
      if (closed) owner.dispose();
      return owner;
    },
    journal,
    getState,
    getStates: () => [...states.values()].map((value) => getState(value.scope)),
    getRecoveryError: () => recoveryError,
    recoverAll,
    discoverSavedScopes,
    startRecovery,
    batchControl,
    retryAll: () => batchAll("retry"),
    clearAll: () => batchAll("clear"),
    setQueueTimeoutMs(value: number) {
      if (!isGithubQueueTimeoutMs(value))
        throw new Error("Queue time limit must be between 1 and 60 minutes");
      queueTimeoutMs = value;
    },
    getQueueTimeoutMs: () => queueTimeoutMs,
    beginSaving,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async submit(
      input: SubmitGithubWrite,
    ): Promise<{ operationId: string; command: GithubOutboxCommand }> {
      if (closed) throw new Error("GitHub outbox is closed");
      if (!isGithubActor(input.actor))
        throw new Error("GitHub identity is unknown; keep your draft and sign in first.");
      // Capture ALL identity/scope/content before the first await.
      const command: GithubOutboxCommand = structuredClone({
        operationId: input.operationId ?? uuid(),
        scope: normalizeGithubPrScope(input.scope),
        expectedActor: input.actor,
        action: input.action,
        dependencies:
          input.dependencies ??
          ("target" in input.action && input.action.target.source === "local"
            ? [input.action.target.operationId]
            : []),
        queueDeadlineAt: new Date(now() + queueTimeoutMs).toISOString(),
        queueTimeoutMs,
      });
      const draftKey = input.draftKey;
      if (!isGithubOutboxCommand(command))
        throw new Error("Invalid GitHub write; your editor has not been submitted.");
      state(command.scope);
      async function reuseSubmittedDraft() {
        if (draftKey === undefined) return undefined;
        const draft = await journal.draft(draftKey);
        if (draft?.submittedOperationId) {
          const saved = (await journal.entries(command.scope)).find(
            (entry) =>
              entry.draftKey === draftKey &&
              (entry.command.operationId === draft.submittedOperationId ||
                entry.operation?.command.operationId === draft.submittedOperationId),
          );
          if (
            !saved ||
            githubCommandFingerprint({
              ...command,
              operationId: saved.command.operationId,
              queueDeadlineAt: saved.command.queueDeadlineAt,
              queueTimeoutMs: saved.command.queueTimeoutMs,
            }) !== githubCommandFingerprint(saved.command)
          )
            throw new Error("Draft already submitted; use a new draft key.");
          background(admit(command.scope, saved.command.operationId), command.scope);
          return { operationId: saved.command.operationId, command: saved.command };
        }
      }
      const finishSaving = beginSaving(command.scope);
      try {
        const prior = await reuseSubmittedDraft();
        if (prior) return prior;
        // Reject on journal failure: caller MUST leave the editor intact until this resolves.
        try {
          await journal.admit(command, draftKey);
        } catch (error) {
          // Another tab may have atomically claimed this draft while we were awaiting IDB.
          const concurrent = await reuseSubmittedDraft();
          if (concurrent) return concurrent;
          throw error;
        }
        try {
          await load(command.scope);
        } catch {
          // Admission already committed. A subsequent read failure must NOT invite a
          // second submission with a fresh UUID while leaving the first write alive.
          const value = state(command.scope);
          if (
            !value.admissions.some((entry) => entry.command.operationId === command.operationId)
          ) {
            value.admissions.push({
              command,
              backendOwned: false,
              draftKey,
              localOrder: Math.max(0, ...value.admissions.map((entry) => entry.localOrder)) + 1,
            });
          }
          value.error =
            "Your write is saved locally; the outbox view will refresh after storage recovers.";
          emit();
        }
        background(admit(command.scope, command.operationId), command.scope);
        return { operationId: command.operationId, command: structuredClone(command) };
      } finally {
        finishSaving();
      }
    },
    /** Explicit retry of an already saved intent; never construct a replacement UUID. */
    retryAdmission,
    async control(scope: GithubPrScope, control: GithubOutboxControl) {
      if (closed) throw new Error("GitHub outbox is closed");
      const captured = normalizeGithubPrScope(scope);
      const request = structuredClone(control);
      if (request.kind === "retry") {
        request.queueTimeoutMs ??= queueTimeoutMs;
        request.queueDeadlineAt ??= new Date(now() + request.queueTimeoutMs).toISOString();
      }
      if (!isGithubOutboxControl(request)) throw new Error("Invalid GitHub outbox control");
      await load(captured);
      const trackedId = () =>
        state(captured).admissions.find(
          (entry) => entry.command.operationId === request.operationId,
        )?.operation?.command.operationId ?? request.operationId;
      const tracked = getState(captured).operations.find(
        (item) => item.command.operationId === trackedId(),
      );
      if (!tracked) throw new Error("Operation does not belong to this pull request");
      // Never locally cancel a possibly admitted write. Backend decides safe cancellation.
      if (!tracked.backendOwned) await admit(captured, request.operationId, true);
      const current = getState(captured).operations.find(
        (item) => item.command.operationId === trackedId(),
      );
      if (!current?.backendOwned)
        throw new Error("Admission must be acknowledged before controlling this operation");
      await journal.putControl(request, captured);
      return sendControl(captured, request);
    },
    snapshot,
    recover,
    heartbeat,
    activate,
    setVisible,
    /** Explicit recovery UI only. Never auto-populate a second editor for submitted work. */
    async draftForOperation(scope: GithubPrScope, operationId: string) {
      const captured = normalizeGithubPrScope(scope);
      await load(captured);
      const canonicalId =
        state(captured).admissions.find((entry) => entry.command.operationId === operationId)
          ?.operation?.command.operationId ?? operationId;
      const entry = getState(captured).operations.find(
        (item) => item.command.operationId === canonicalId,
      );
      if (!entry) return undefined;
      const draft = entry.draftKey ? await journal.draft(entry.draftKey) : undefined;
      return {
        body:
          draft?.body ?? ("body" in entry.command.action ? entry.command.action.body : undefined),
        draftKey: entry.draftKey,
        submittedOperationId: canonicalId,
        status: entry.status,
        // Cancellation is authoritative only after the backend confirms it.
        canRestore: entry.backendOwned && entry.status === "cancelled",
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const owner of decisionOwners) owner.dispose();
      for (const cancel of cancelAdmissions) cancel();
      stopRecovery?.();
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
      detachVisibility?.();
      if (active) await heartbeat(active, false).catch(() => {});
      await Promise.allSettled(flights.values());
      listeners.clear();
      await journal.close();
    },
  };
  return api;
}

export type BrowserGithubOutbox = ReturnType<typeof createGithubOutbox>;
