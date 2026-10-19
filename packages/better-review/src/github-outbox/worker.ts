import type {
  GithubOutboxError,
  GithubOutboxOperation,
  GithubRemoteResult,
} from "@better-review/shared";
import { isGithubRemoteResult } from "@better-review/shared";

import { OutboxDatabase } from "./database.js";
import type {
  GithubDispatchOutcome,
  GithubOutboxAdapter,
  GithubReconcileOutcome,
} from "./types.js";
import { matches, resolved } from "./validation.js";

export const diagnostic = (
  code: GithubOutboxError["code"],
  message: string,
  retryable = false,
): GithubOutboxError => ({ code, message, retryable });

function sanitized(error: GithubOutboxError, message: string): GithubOutboxError {
  const retryAt = error.retryAt ? Date.parse(error.retryAt) : NaN;
  const httpStatus = error.httpStatus;
  const validStatus =
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 400 &&
    httpStatus <= 599;
  return {
    ...diagnostic(
      error.code,
      validStatus ? `${message} (HTTP ${httpStatus})` : message,
      error.retryable,
    ),
    ...(validStatus ? { httpStatus } : {}),
    ...(Number.isFinite(retryAt) ? { retryAt: new Date(retryAt).toISOString() } : {}),
  };
}

export interface WorkerOptions {
  adapter: GithubOutboxAdapter;
  now: () => number;
  pollMs: number;
  attemptTimeoutMs: number;
  closeTimeoutMs: number;
}

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval>;
  private running = new Map<string, Promise<void>>();
  private checking = new Set<string>();
  private slots = new Set<string>();
  private slotWaiters = new Set<() => void>();
  private stopped = false;
  private cancellations = new Set<() => void>();
  private stopWait(): void {
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    for (const resume of this.slotWaiters) resume();
    this.slotWaiters.clear();
  }
  private alive(): boolean {
    if (this.stopped) return false;
    if (!this.store.compromised) return true;
    this.stopped = true;
    clearInterval(this.timer);
    this.stopWait();
    return false;
  }
  private claim(scope: string): boolean {
    if (!this.alive() || this.slots.has(scope) || this.slots.size >= 2) return false;
    this.slots.add(scope);
    return true;
  }
  private release(scope: string): void {
    this.slots.delete(scope);
    for (const resume of this.slotWaiters) resume();
  }
  private async waitForSlot(scope: string): Promise<boolean> {
    while (!this.claim(scope)) {
      if (!this.alive()) return false;
      let resume!: () => void;
      try {
        await new Promise<void>((resolve) => {
          resume = resolve;
          this.slotWaiters.add(resolve);
        });
      } finally {
        this.slotWaiters.delete(resume);
      }
    }
    return true;
  }
  constructor(
    private store: OutboxDatabase,
    private options: WorkerOptions,
  ) {
    store.transaction(() => {
      for (const op of store.list())
        if (op.status === "inflight") {
          op.status = "uncertain";
          op.retryMode = "blocked";
          delete op.nextAttemptAt;
          op.error = diagnostic(
            "network",
            "The previous process stopped during a write. Check GitHub before retrying.",
          );
          this.save(op);
        }
      // Browser process leases must not survive a backend restart.
      store.db.exec("DELETE FROM leases");
    });
    this.timer = setInterval(() => this.wake(), options.pollMs);
    this.timer.unref();
  }
  private save(op: GithubOutboxOperation): void {
    op.revision++;
    op.updatedAt = new Date(this.options.now()).toISOString();
    this.store.save(op);
  }
  wake(): void {
    if (!this.alive()) return;
    const now = this.options.now();
    const scopes = this.store.db
      .prepare("SELECT DISTINCT scope FROM leases WHERE expires>?")
      .all(now);
    for (const row of scopes) {
      if (this.slots.size >= 2 || this.slotWaiters.size > 0) break;
      const scope = row.scope as string;
      if (this.running.has(scope) || this.checking.has(scope)) continue;
      const first = this.store
        .list(scope)
        .find((op) => op.status !== "synced" && op.status !== "cancelled");
      if (
        !first ||
        (first.status !== "queued" &&
          first.status !== "retry-failed" &&
          first.status !== "uncertain")
      )
        continue;
      if (first.nextAttemptAt && Date.parse(first.nextAttemptAt) > now) continue;
      if (
        first.status === "uncertain" &&
        !first.nextAttemptAt &&
        first.error &&
        ["auth", "identity-mismatch", "identity-unknown", "permission"].includes(first.error.code)
      )
        continue;
      if (
        first.status === "retry-failed" &&
        (first.retryMode !== "automatic" || !first.error?.retryable || !first.nextAttemptAt)
      )
        continue;
      if (!this.claim(scope)) continue;
      const task = (
        first.status === "uncertain" ? this.reconcileOperation(first) : this.attempt(first)
      )
        .catch(() => {
          // Ownership loss/database failure cannot authorize another network write.
          this.stopped = true;
          clearInterval(this.timer);
          this.stopWait();
        })
        .finally(() => {
          this.running.delete(scope);
          this.release(scope);
          this.wake();
        });
      this.running.set(scope, task);
    }
  }
  private active(op: GithubOutboxOperation): boolean {
    return !!this.store.db
      .prepare("SELECT 1 FROM leases WHERE scope=? AND expires>? LIMIT 1")
      .get(op.command.scope.url, this.options.now());
  }
  private async bounded<T>(
    fn: (signal: AbortSignal, beforeMutation: () => void) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const deadline = performance.now() + this.options.attemptTimeoutMs;
    const beforeMutation = () => {
      // Timers/polling cannot fence a synchronous preflight completion. Re-read
      // the durable token and monotonic deadline at the adapter's actual send.
      if (!this.alive() || controller.signal.aborted || performance.now() >= deadline) {
        controller.abort();
        throw new Error("GitHub mutation ownership or deadline fence failed");
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ownerTimer: ReturnType<typeof setInterval> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (!this.alive()) throw new Error("Worker stopped");
          return fn(controller.signal, beforeMutation);
        }),
        new Promise<never>((_, reject) => {
          cancel = () => {
            controller.abort();
            reject(new Error("Worker stopped"));
          };
          this.cancellations.add(cancel);
          ownerTimer = setInterval(() => {
            if (!this.alive()) cancel?.();
          }, 10);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Adapter deadline exceeded"));
          }, this.options.attemptTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (ownerTimer) clearInterval(ownerTimer);
      if (cancel) this.cancellations.delete(cancel);
    }
  }
  private async identity(op: GithubOutboxOperation): Promise<GithubOutboxError | undefined> {
    try {
      const identity = await this.bounded((signal) => this.options.adapter.identity({ signal }));
      if (identity.outcome !== "known")
        return sanitized(identity.error, "GitHub identity could not be verified.");
      if (identity.actor.id !== op.command.expectedActor.id)
        return diagnostic(
          "identity-mismatch",
          "The active GitHub account differs from this operation's author.",
        );
    } catch {
      return diagnostic("network", "GitHub identity could not be verified.", true);
    }
  }
  private count(id: string, column: "identity_failures" | "reconcile_attempts"): number {
    this.store.db
      .prepare("INSERT INTO schedules(operation_id) VALUES (?) ON CONFLICT DO NOTHING")
      .run(id);
    this.store.db
      .prepare(`UPDATE schedules SET ${column}=${column}+1 WHERE operation_id=?`)
      .run(id);
    return this.store.db
      .prepare(`SELECT ${column} AS count FROM schedules WHERE operation_id=?`)
      .get(id)!.count as number;
  }
  private backoff(count: number, retryAt?: string, base = 1_000): string {
    const remote = retryAt ? Date.parse(retryAt) : 0;
    return new Date(
      Math.max(
        this.options.now() + Math.min(300_000, base * 2 ** Math.min(count - 1, 9)),
        Number.isFinite(remote) ? remote : 0,
      ),
    ).toISOString();
  }
  private async attempt(initial: GithubOutboxOperation): Promise<void> {
    // Identity reads precede claiming a write; controls may run while this awaits.
    const identityError = await this.identity(initial);
    if (this.stopped || this.store.compromised) return;
    if (!identityError) await this.discoverThread(initial);
    if (this.stopped || this.store.compromised) return;
    let dispatched: GithubOutboxOperation | undefined;
    this.store.transaction(() => {
      const op = this.store.get(initial.command.operationId)!;
      if (op.revision !== initial.revision || !this.active(op)) return;
      if (identityError) {
        op.status = "retry-failed";
        op.error = identityError;
        delete op.nextAttemptAt;
        const count = this.count(op.command.operationId, "identity_failures");
        const transient =
          identityError.retryable &&
          ["network", "rate-limit", "unavailable"].includes(identityError.code);
        if (op.retryMode === "automatic" && transient && count < 8)
          op.nextAttemptAt = this.backoff(count, identityError.retryAt);
        else if (op.retryMode !== "manual") op.retryMode = "blocked";
        this.save(op);
        return;
      }
      for (const id of op.command.dependencies) {
        if (this.store.get(id)?.status !== "synced") {
          op.status = "retry-failed";
          op.retryMode = "blocked";
          op.error = diagnostic("dependency", "A prerequisite was not applied.");
          delete op.nextAttemptAt;
          this.save(op);
          return;
        }
      }
      dispatched = resolved(this.store, op);
      if (!dispatched) {
        op.status = "queued";
        op.retryMode = "blocked";
        op.error = diagnostic(
          "dependency",
          "Waiting to discover the prerequisite's actual GitHub thread ID.",
        );
        op.nextAttemptAt = new Date(this.options.now() + 5_000).toISOString();
        this.save(op);
        return;
      }
      op.status = "inflight";
      this.store.db
        .prepare("UPDATE schedules SET identity_failures=0 WHERE operation_id=?")
        .run(op.command.operationId);
      op.attempts++;
      op.lastAttemptAt = new Date(this.options.now()).toISOString();
      if (op.retryMode === "blocked") op.retryMode = "automatic";
      delete op.nextAttemptAt;
      delete op.error;
      this.save(op);
      const resolvedCommand = dispatched.command;
      dispatched = structuredClone(op);
      dispatched.command = resolvedCommand;
    });
    if (!dispatched) return;
    const sent = dispatched;
    let outcome: GithubDispatchOutcome;
    try {
      // Recheck durable ownership immediately before entering adapter preflight.
      outcome = await this.bounded((signal, beforeMutation) => {
        if (!this.alive() || signal.aborted) throw new Error("Worker stopped");
        return this.options.adapter.dispatch(sent, { signal, beforeMutation });
      });
    } catch {
      outcome = {
        outcome: "uncertain" as const,
        error: diagnostic(
          "network",
          "GitHub may have received the write. Check GitHub before retrying.",
        ),
      };
    }
    if (this.stopped || this.store.compromised) return;
    this.store.transaction(() => {
      const op = this.store.get(sent.command.operationId)!;
      if (op.status !== "inflight" || op.revision !== sent.revision) return;
      if (outcome.outcome === "accepted" && matches(sent, outcome.result, initial.command.action)) {
        op.status = "synced";
        op.retryMode = "blocked";
        op.result = outcome.result;
        delete op.error;
      } else if (outcome.outcome === "rejected") {
        op.status = "retry-failed";
        // Never persist arbitrary adapter messages; only safe, worker-owned diagnostics.
        const guidance: Partial<Record<GithubOutboxError["code"], string>> = {
          auth: "Check GitHub authentication, then retry.",
          permission: "Check GitHub write access and comment ownership, then retry.",
          "target-changed":
            "The comment changed. Recover saved content and review the latest version.",
          "head-changed": "The pull request head changed. Review the latest diff.",
          invalid: "Check the comment target and request format before retrying.",
          conflict: "Refresh GitHub and review the latest version before retrying.",
        };
        op.error = sanitized(
          outcome.error,
          `GitHub rejected the operation before applying it.${guidance[outcome.error.code] ? ` ${guidance[outcome.error.code]}` : ""}`,
        );
        const paused = [
          "auth",
          "identity-mismatch",
          "identity-unknown",
          "head-changed",
          "target-changed",
          "permission",
        ].includes(op.error.code);
        if (op.retryMode === "automatic" && op.error.retryable && !paused && op.attempts < 8) {
          const delay = Math.min(300_000, 1_000 * 2 ** Math.min(op.attempts - 1, 9));
          const remote = outcome.error.retryAt ? Date.parse(outcome.error.retryAt) : 0;
          op.nextAttemptAt = new Date(
            Math.max(this.options.now() + delay, Number.isFinite(remote) ? remote : 0),
          ).toISOString();
        } else if (op.retryMode !== "manual") op.retryMode = "blocked";
      } else {
        op.status = "uncertain";
        op.retryMode = "blocked";
        op.error = diagnostic(
          "network",
          "GitHub may have applied the operation. Check GitHub before retrying.",
        );
      }
      this.save(op);
    });
  }
  private async discoverThread(child: GithubOutboxOperation): Promise<void> {
    const action = child.command.action;
    if (
      !("target" in action) ||
      action.target.kind !== "thread" ||
      action.target.source !== "local"
    )
      return;
    const parent = this.store.get(action.target.operationId);
    if (
      !parent ||
      parent.status !== "synced" ||
      parent.result?.kind !== "review-comment" ||
      parent.result.threadId
    )
      return;
    let outcome: GithubReconcileOutcome;
    try {
      outcome = await this.bounded((signal) => this.options.adapter.reconcile(parent, { signal }));
    } catch {
      return;
    }
    if (this.stopped || this.store.compromised) return;
    if (
      outcome.outcome !== "matched" ||
      outcome.result.kind !== "review-comment" ||
      !outcome.result.threadId ||
      outcome.result.id !== parent.result.id ||
      !isGithubRemoteResult(outcome.result) ||
      outcome.result.author.id !== parent.result.author.id ||
      outcome.result.location.path !== parent.result.location.path ||
      outcome.result.location.side !== parent.result.location.side ||
      outcome.result.location.commitSha !== parent.result.location.commitSha
    )
      return;
    const enriched = outcome.result;
    this.store.transaction(() => {
      const current = this.store.get(parent.command.operationId)!;
      if (current.revision !== parent.revision || current.status !== "synced") return;
      if (current.result?.kind !== "review-comment") return;
      current.result = { ...current.result, threadId: enriched.threadId };
      this.save(current);
    });
  }
  async verifyApplied(
    op: GithubOutboxOperation,
    candidate: GithubRemoteResult,
  ): Promise<GithubReconcileOutcome> {
    const scope = op.command.scope.url;
    if (!(await this.waitForSlot(scope))) return { outcome: "absent" };
    try {
      const error = await this.identity(op);
      if (error) return { outcome: "auth", error };
      if (!this.alive()) return { outcome: "absent" };
      return await this.bounded((signal) =>
        this.options.adapter.verifyApplied(op, candidate, { signal }),
      );
    } catch {
      return { outcome: "absent" };
    } finally {
      this.release(scope);
      this.wake();
    }
  }
  async reconcile(id: string): Promise<void> {
    if (!this.alive()) return;
    const initial = this.store.get(id);
    if (!initial) return;
    const scope = initial.command.scope.url;
    if (!(await this.waitForSlot(scope))) return;
    this.checking.add(scope);
    try {
      await this.reconcileOperation(initial);
    } finally {
      this.checking.delete(scope);
      this.release(scope);
      this.wake();
    }
  }
  private async reconcileOperation(initial: GithubOutboxOperation): Promise<void> {
    const id = initial.command.operationId;
    const identityError = await this.identity(initial);
    if (this.stopped || this.store.compromised) return;
    const op = this.store.get(id)!;
    if (op.revision !== initial.revision || op.status !== "uncertain") return;
    const target = resolved(this.store, op);
    let outcome: GithubReconcileOutcome | undefined;
    if (!identityError && target) {
      try {
        outcome = await this.bounded((signal) =>
          this.options.adapter.reconcile(target, { signal }),
        );
      } catch {
        /* Still uncertain; absence/transport failure never authorizes replay. */
        outcome = {
          outcome: "conflict",
          error: diagnostic("network", "GitHub reconciliation could not be completed.", true),
        };
      }
    }
    if (this.stopped || this.store.compromised) return;
    this.store.transaction(() => {
      const current = this.store.get(id)!;
      if (current.revision !== initial.revision || current.status !== "uncertain") return;
      if (
        target &&
        outcome?.outcome === "matched" &&
        matches(target, outcome.result, initial.command.action)
      ) {
        current.status = "synced";
        current.retryMode = "blocked";
        current.result = outcome.result;
        delete current.error;
        delete current.nextAttemptAt;
      } else {
        current.error =
          identityError ??
          (outcome?.outcome === "auth" || outcome?.outcome === "conflict"
            ? sanitized(outcome.error, "GitHub reconciliation could not confirm this operation.")
            : undefined) ??
          diagnostic(
            "conflict",
            "GitHub has not provided unambiguous evidence. Explicit confirmation is required.",
          );
        const count = this.count(id, "reconcile_attempts");
        const authBlocked =
          current.error &&
          ["auth", "identity-mismatch", "identity-unknown", "permission"].includes(
            current.error.code,
          );
        if (authBlocked) delete current.nextAttemptAt;
        else current.nextAttemptAt = this.backoff(count, current.error.retryAt, 5_000);
      }
      this.save(current);
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.stopWait();
    // Abort adapter preflight, fence late completions, persist uncertainty,
    // and do not wait for an unbounded HTTP request to release the owner lock.
    if (!this.store.compromised)
      this.store.transaction(() => {
        for (const op of this.store.list())
          if (op.status === "inflight") {
            op.status = "uncertain";
            op.retryMode = "blocked";
            delete op.nextAttemptAt;
            op.error = diagnostic(
              "network",
              "The worker stopped while a write might be in progress.",
            );
            this.save(op);
          }
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.running.values()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.closeTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
