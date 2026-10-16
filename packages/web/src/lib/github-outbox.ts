import {
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
  type GithubOutboxReceipt,
  type GithubOutboxSnapshot,
  type GithubPrScope,
  type GithubWriteAction,
} from "@better-review/shared";

import {
  createIndexedDbGithubJournal,
  githubCommandFingerprint,
  normalizeGithubPrScope,
  type BrowserGithubJournal,
  type GithubAdmission,
} from "./github-outbox-journal";

export interface GithubOutboxTransport {
  enqueue(command: GithubOutboxCommand): Promise<GithubOutboxReceipt>;
  snapshot(scope: GithubPrScope): Promise<GithubOutboxSnapshot>;
  control(control: GithubOutboxControl): Promise<GithubOutboxControlReceipt>;
  heartbeat(value: GithubOutboxHeartbeat): Promise<void>;
}

export interface BrowserGithubOperation {
  command: GithubOutboxCommand;
  backendOwned: boolean;
  status: GithubOutboxOperation["status"] | "local-pending";
  operation?: GithubOutboxOperation;
  draftKey?: string;
  admissionError?: string;
}

export interface BrowserGithubState {
  scope: GithubPrScope;
  revision: number;
  operations: BrowserGithubOperation[];
  pendingCount: number;
  busy: boolean;
  error?: string;
}

interface ScopeState {
  scope: GithubPrScope;
  revision: number;
  operations: Map<string, GithubOutboxOperation>;
  admissions: GithubAdmission[];
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

/** Plain reactive store: subscribe + getState also works with Solid createSignal. */
export function createGithubOutbox(options: {
  transport: GithubOutboxTransport;
  journal?: BrowserGithubJournal;
  uuid?: () => string;
  clientId?: string;
  pollMs?: number;
  /** Injectable for tests; Web Locks avoid simultaneous admissions across tabs. */
  lock?: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}) {
  const journal = options.journal ?? createIndexedDbGithubJournal();
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  // Per instance/tab, NOT localStorage (which would make tabs share a lease).
  const clientId = options.clientId ?? uuid();
  const states = new Map<string, ScopeState>();
  const listeners = new Set<() => void>();
  const flights = new Map<string, Promise<unknown>>();
  let closed = false;
  let active: GithubPrScope | undefined;
  let visible = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let detachVisibility: (() => void) | undefined;
  let heartbeatChain: Promise<void> = Promise.resolve();

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
      };
      states.set(scope.url, value);
    }
    return value;
  }
  function getState(scope: GithubPrScope): BrowserGithubState {
    const value = state(scope);
    const operations = new Map<string, BrowserGithubOperation>();
    for (const entry of value.admissions) {
      const operation = value.operations.get(entry.command.operationId) ?? entry.operation;
      operations.set(entry.command.operationId, {
        command: operation?.command ?? entry.command,
        backendOwned: entry.backendOwned,
        status: operation?.status ?? "local-pending",
        operation,
        draftKey: entry.draftKey,
        admissionError: entry.admissionError,
      });
    }
    for (const operation of value.operations.values()) {
      const prior = operations.get(operation.command.operationId);
      operations.set(operation.command.operationId, {
        ...prior,
        command: operation.command,
        operation,
        backendOwned: prior?.backendOwned ?? true,
        status: operation.status,
      });
    }
    const list = [...operations.values()].sort(
      (a, b) =>
        (a.operation?.sequence ?? Number.MAX_SAFE_INTEGER) -
        (b.operation?.sequence ?? Number.MAX_SAFE_INTEGER),
    );
    return structuredClone({
      scope: value.scope,
      revision: value.revision,
      operations: list,
      pendingCount: list.filter((item) => item.status !== "synced" && item.status !== "cancelled")
        .length,
      busy: list.some((item) => ["local-pending", "queued", "inflight"].includes(item.status)),
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
  async function remember(operation: GithubOutboxOperation) {
    // Only claim ownership in the journal after this durable commit succeeds.
    await journal.acknowledge(operation);
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
      const entry = (await journal.entries(scope)).find(
        (item) => item.command.operationId === operationId,
      );
      if (!entry || entry.backendOwned || (entry.admissionError && !explicit)) return;
      try {
        const receipt = await options.transport.enqueue(structuredClone(entry.command));
        if (receipt.outcome === "rejected") {
          await journal.admissionFailed(operationId, receipt.error.message);
        } else {
          if (
            receipt.operation.command.operationId !== operationId ||
            receipt.operation.command.scope.url !== scope.url
          )
            throw new Error("Invalid receipt");
          await remember(receipt.operation);
        }
        state(scope).error = undefined;
      } catch {
        // Ack may have been lost: leave backendOwned false and replay SAME command/ID.
        state(scope).error =
          "GitHub admission is not yet acknowledged; your work is saved locally.";
      }
      await load(scope);
    });
  }
  async function sendControl(scope: GithubPrScope, control: GithubOutboxControl) {
    return single(`control:${control.requestId}`, async () => {
      const receipt = await options.transport.control(structuredClone(control));
      if (receipt.outcome !== "rejected") await remember(receipt.operation);
      await journal.removeControl(control.requestId);
      return receipt;
    });
  }
  async function snapshot(scope: GithubPrScope) {
    const captured = normalizeGithubPrScope(scope);
    return single(`snapshot:${captured.url}`, async () => {
      const remote = await options.transport.snapshot(captured);
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
  function background(work: Promise<unknown>, scope: GithubPrScope) {
    void work.catch(() => {
      state(scope).error = "GitHub outbox is temporarily unavailable; saved work is retained.";
      emit();
    });
  }
  async function heartbeat(scope: GithubPrScope, isVisible: boolean) {
    const value = { clientId, scope: normalizeGithubPrScope(scope), visible: isVisible };
    // Navigation release cannot be overtaken by an earlier visibility heartbeat.
    const next = heartbeatChain.catch(() => {}).then(() => options.transport.heartbeat(value));
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
    // Short polling, never SSE; only the active, visible PR gets a lease/poll.
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

  return {
    journal,
    getState,
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
            (entry) => entry.command.operationId === draft.submittedOperationId,
          );
          if (
            !saved ||
            githubCommandFingerprint({ ...command, operationId: saved.command.operationId }) !==
              githubCommandFingerprint(saved.command)
          )
            throw new Error("Draft already submitted; use a new draft key.");
          background(admit(command.scope, saved.command.operationId), command.scope);
          return { operationId: saved.command.operationId, command: saved.command };
        }
      }
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
        if (!value.admissions.some((entry) => entry.command.operationId === command.operationId)) {
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
    },
    retryAdmission(scope: GithubPrScope, operationId: string) {
      return admit(normalizeGithubPrScope(scope), operationId, true);
    },
    async control(scope: GithubPrScope, control: GithubOutboxControl) {
      if (closed) throw new Error("GitHub outbox is closed");
      const captured = normalizeGithubPrScope(scope);
      const request = structuredClone(control);
      if (!isGithubOutboxControl(request)) throw new Error("Invalid GitHub outbox control");
      await load(captured);
      const tracked = getState(captured).operations.find(
        (item) => item.command.operationId === request.operationId,
      );
      if (!tracked) throw new Error("Operation does not belong to this pull request");
      // Never locally cancel a possibly admitted write. Backend decides safe cancellation.
      if (!tracked.backendOwned) await admit(captured, request.operationId, true);
      const current = getState(captured).operations.find(
        (item) => item.command.operationId === request.operationId,
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
      const entry = getState(captured).operations.find(
        (item) => item.command.operationId === operationId,
      );
      if (!entry) return undefined;
      const draft = entry.draftKey ? await journal.draft(entry.draftKey) : undefined;
      return {
        body:
          draft?.body ?? ("body" in entry.command.action ? entry.command.action.body : undefined),
        draftKey: entry.draftKey,
        submittedOperationId: operationId,
        status: entry.status,
        // Cancellation is authoritative only after the backend confirms it.
        canRestore: entry.backendOwned && entry.status === "cancelled",
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
      detachVisibility?.();
      if (active) await heartbeat(active, false).catch(() => {});
      await Promise.allSettled(flights.values());
      listeners.clear();
      await journal.close();
    },
  };
}

export type BrowserGithubOutbox = ReturnType<typeof createGithubOutbox>;
