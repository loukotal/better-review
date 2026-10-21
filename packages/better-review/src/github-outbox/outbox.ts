import {
  DEFAULT_GITHUB_QUEUE_TIMEOUT_MS,
  MAX_GITHUB_QUEUE_TIMEOUT_MS,
  isGithubOutboxBatchControl,
  isGithubOutboxAdmissionCycle,
  type GithubOutboxAdmissionCycle,
  type GithubOutboxBatchControl,
  isGithubOutboxCommand,
  isGithubOutboxControl,
  isGithubOutboxHeartbeat,
  isGithubPrScope,
  isGithubWriteAction,
  type GithubActor,
  type GithubOutboxCommand,
  type GithubOutboxControl,
  type GithubOutboxControlReceipt,
  type GithubOutboxHeartbeat,
  type GithubOutboxError,
  type GithubOutboxOperation,
  type GithubOutboxReceipt,
  type GithubOutboxPendingScope,
  type GithubPrScope,
} from "@better-review/shared";

import { applyBatchControl } from "./batch";
import { canonical, OutboxDatabase } from "./database.js";
import { expireOperation } from "./lifecycle";
import type { GithubOutbox, GithubOutboxAdapter } from "./types.js";
import { matches, resolved } from "./validation.js";
import { diagnostic, OutboxWorker } from "./worker.js";

export interface GithubOutboxOptions {
  databasePath: string;
  adapter: GithubOutboxAdapter;
  getCachedActor: () => GithubActor | undefined;
  /** Cached failure only; admission must never start an identity/network lookup. */
  getCachedIdentityError?: () => GithubOutboxError | undefined;
  now?: () => number;
  /** UI-presence telemetry only. Admitted work never waits for a browser lease. */
  leaseMs?: number;
  pollMs?: number;
  attemptTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export async function createGithubOutbox(options: GithubOutboxOptions): Promise<GithubOutbox> {
  for (const key of ["leaseMs", "pollMs", "attemptTimeoutMs", "closeTimeoutMs"] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) ||
        value < (key === "closeTimeoutMs" ? 0 : 1) ||
        value > 2_147_483_647)
    )
      throw new Error(`Invalid GitHub outbox ${key}`);
  }
  const store = await OutboxDatabase.open(options.databasePath);
  const now = options.now ?? Date.now;
  let worker: OutboxWorker;
  try {
    worker = new OutboxWorker(store, {
      adapter: options.adapter,
      now,
      pollMs: options.pollMs ?? 1_000,
      attemptTimeoutMs: options.attemptTimeoutMs ?? 30_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 1_000,
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  function assertOpen() {
    if (closed || store.compromised)
      throw new Error("GitHub outbox is closed or ownership was lost");
  }
  function change(op: GithubOutboxOperation) {
    op.revision++;
    op.updatedAt = new Date(now()).toISOString();
    store.save(op);
  }
  return {
    async enqueue(
      command: GithubOutboxCommand,
      cycle?: GithubOutboxAdmissionCycle,
    ): Promise<GithubOutboxReceipt> {
      assertOpen();
      const reject = (
        code: Parameters<typeof diagnostic>[0],
        message: string,
        retryable = false,
      ): GithubOutboxReceipt => ({
        outcome: "rejected",
        operationId: command?.operationId,
        error: diagnostic(code, message, retryable),
      });
      if (!isGithubOutboxCommand(command))
        return reject("invalid", "Invalid GitHub outbox command.");
      if (cycle !== undefined && !isGithubOutboxAdmissionCycle(cycle))
        return reject("invalid", "Invalid explicit queue retry cycle.");
      const receipt = store.transaction((): GithubOutboxReceipt => {
        const fingerprint = canonical(command);
        const cycleFingerprint = cycle
          ? canonical({ commandId: command.operationId, ...cycle })
          : undefined;
        const priorCycle = cycle
          ? store.db
              .prepare("SELECT fingerprint FROM admission_cycles WHERE id=?")
              .get(cycle.requestId)
          : undefined;
        if (priorCycle && priorCycle.fingerprint !== cycleFingerprint)
          return reject("conflict", "Queue retry cycle ID was reused with different content.");
        const cycleDeadline = cycle
          ? Math.min(Date.parse(cycle.queueDeadlineAt), now() + cycle.queueTimeoutMs)
          : undefined;
        const applyCycle = (op: GithubOutboxOperation) => {
          if (!cycle || priorCycle) return;
          if (op.status === "retry-failed") {
            const manual = store.db
              .prepare(
                "SELECT 1 FROM audit WHERE operation_id=? AND json_valid(event) AND json_extract(event,'$.resolution.kind')='confirm-not-applied' LIMIT 1",
              )
              .get(op.command.operationId);
            op.status = "queued";
            op.retryMode = op.retryMode === "manual" || manual ? "manual" : "automatic";
            op.queueDeadlineAt = new Date(cycleDeadline!).toISOString();
            delete op.timedOutAt;
            delete op.archivedAt;
            delete op.error;
            delete op.nextAttemptAt;
            store.db
              .prepare("UPDATE schedules SET identity_failures=0 WHERE operation_id=?")
              .run(op.command.operationId);
            expireOperation(op, now());
            change(op);
          } else if (op.status === "queued" && cycleDeadline! < Date.parse(op.queueDeadlineAt!)) {
            op.queueDeadlineAt = new Date(cycleDeadline!).toISOString();
            expireOperation(op, now());
            change(op);
          }
          store.db
            .prepare("INSERT INTO admission_cycles(id,fingerprint) VALUES (?,?)")
            .run(cycle.requestId, cycleFingerprint!);
        };
        const prior = store.db
          .prepare(
            "SELECT fingerprint FROM operations WHERE id=? UNION ALL SELECT fingerprint FROM aliases WHERE id=?",
          )
          .get(command.operationId, command.operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            return reject("conflict", "Operation ID was already used for different content.");
          const op = store.get(command.operationId)!;
          if (expireOperation(op, now())) change(op);
          applyCycle(op);
          return { outcome: "duplicate", operation: op };
        }
        const actor = options.getCachedActor();
        if (!actor) {
          const error = options.getCachedIdentityError?.();
          if (error)
            return {
              outcome: "rejected",
              operationId: command.operationId,
              error: structuredClone(error),
            };
          return reject(
            "identity-unknown",
            "A known GitHub identity is required before admission.",
            true,
          );
        }
        if (actor.id !== command.expectedActor.id)
          return reject("identity-mismatch", "The operation belongs to another GitHub account.");
        const admittedId = command.operationId;
        command = store.normalize(command);
        for (const id of command.dependencies) {
          const dependency = store.get(id);
          // Requiring already-admitted parents makes cycles and forward edges impossible.
          if (
            !dependency ||
            dependency.archivedAt ||
            dependency.command.scope.url !== command.scope.url ||
            dependency.command.expectedActor.id !== command.expectedActor.id
          )
            return reject(
              "dependency",
              "Dependencies must be earlier operations for this PR and account.",
            );
        }
        const action = command.action;
        if ("target" in action && action.target.source === "local") {
          const parent = store.get(action.target.operationId)!;
          const kind = parent.command.action.kind;
          const valid =
            action.target.kind === "issue-comment"
              ? kind === "issue-comment"
              : action.target.kind === "thread"
                ? kind === "inline-comment"
                : kind === "inline-comment" || kind === "reply";
          if (!valid)
            return reject(
              "dependency",
              "The local reference does not name a creation of the required kind.",
            );
        }
        const match = store.contentDuplicate(command, now());
        if (match) {
          const duplicate = match.operation;
          if (duplicate.archivedAt)
            return reject(
              "conflict",
              "An earlier cleared action still has unknown delivery. Check GitHub before submitting it again.",
            );
          // A fresh approval intent must not become a permanent alias of an older review.
          // Keep the content safety window, but let this UUID be admitted after it expires.
          if (
            (action.kind === "approve" ||
              action.kind === "request-changes" ||
              action.kind === "review-comment") &&
            duplicate.status === "synced" &&
            match.retryAt
          ) {
            return {
              outcome: "rejected",
              operationId: admittedId,
              error: {
                code: action.kind === "approve" ? "approval-cooldown" : "review-cooldown",
                message:
                  action.kind === "approve"
                    ? "This approval is saved locally. Retry after the approval cooldown."
                    : "This review is saved locally. Retry after the review cooldown.",
                retryable: true,
                retryAt: match.retryAt,
              },
            };
          }
          store.db
            .prepare("INSERT INTO aliases(id,operation_id,fingerprint) VALUES (?,?,?)")
            .run(admittedId, duplicate.command.operationId, fingerprint);
          applyCycle(duplicate);
          return { outcome: "duplicate", operation: duplicate };
        }
        store.db
          .prepare(
            "INSERT INTO scopes(scope,revision,sequence) VALUES (?,0,0) ON CONFLICT DO NOTHING",
          )
          .run(command.scope.url);
        store.db
          .prepare("UPDATE scopes SET sequence=sequence+1,revision=revision+1 WHERE scope=?")
          .run(command.scope.url);
        const row = store.db
          .prepare("SELECT sequence FROM scopes WHERE scope=?")
          .get(command.scope.url)!;
        const stamp = new Date(now()).toISOString();
        const operation: GithubOutboxOperation = {
          command: structuredClone(command),
          revision: 1,
          sequence: row.sequence as number,
          status: "queued",
          retryMode: "automatic",
          attempts: 0,
          createdAt: stamp,
          updatedAt: stamp,
          queueDeadlineAt: new Date(
            Math.min(
              cycleDeadline ??
                (command.queueDeadlineAt
                  ? Date.parse(command.queueDeadlineAt)
                  : now() + (command.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS)),
              now() +
                (cycle?.queueTimeoutMs ?? command.queueTimeoutMs ?? MAX_GITHUB_QUEUE_TIMEOUT_MS),
            ),
          ).toISOString(),
        };
        if (Date.parse(operation.queueDeadlineAt!) <= now()) {
          operation.status = "retry-failed";
          operation.retryMode = "blocked";
          operation.timedOutAt = stamp;
          operation.error = diagnostic(
            "timeout",
            "Queue time limit reached before delivery. Retry explicitly to start a new timed cycle.",
          );
        }
        store.db
          .prepare(
            "INSERT INTO operations(id,scope,sequence,fingerprint,data,content_key) VALUES (?,?,?,?,?,?)",
          )
          .run(
            command.operationId,
            command.scope.url,
            operation.sequence,
            fingerprint,
            JSON.stringify(operation),
            store.semantic(command).key,
          );
        for (const id of command.dependencies)
          store.db.prepare("INSERT INTO dependencies VALUES (?,?)").run(command.operationId, id);
        if (cycle && !priorCycle)
          store.db
            .prepare("INSERT INTO admission_cycles(id,fingerprint) VALUES (?,?)")
            .run(cycle.requestId, cycleFingerprint!);
        return { outcome: "accepted", operation };
      });
      // Admission itself never invokes adapter/network, even if a PR is active.
      setImmediate(() => worker.wake());
      return receipt;
    },
    async listPending() {
      assertOpen();
      const summaries = new Map<string, GithubOutboxPendingScope>();
      for (const op of store.list()) {
        if (op.status === "synced" || op.status === "cancelled" || op.archivedAt) continue;
        const scope = op.command.scope;
        let summary = summaries.get(scope.url);
        if (!summary) {
          const row = store.db.prepare("SELECT revision FROM scopes WHERE scope=?").get(scope.url);
          summary = {
            scope: structuredClone(scope),
            revision: (row?.revision as number) ?? 0,
            pendingCount: 0,
            counts: { queued: 0, inflight: 0, "retry-failed": 0, uncertain: 0 },
            updatedAt: op.updatedAt,
          };
          if (
            op.status === "uncertain" ||
            (op.status === "retry-failed" &&
              !(op.retryMode === "automatic" && op.error?.retryable && op.nextAttemptAt))
          )
            summary.blockedByOperationId = op.command.operationId;
          summaries.set(scope.url, summary);
        }
        summary.pendingCount++;
        summary.counts[op.status]++;
        if (op.updatedAt > summary.updatedAt) summary.updatedAt = op.updatedAt;
      }
      return [...summaries.values()];
    },
    async snapshot(scope: GithubPrScope) {
      assertOpen();
      if (!isGithubPrScope(scope)) throw new Error("Invalid GitHub PR scope");
      const row = store.db.prepare("SELECT revision FROM scopes WHERE scope=?").get(scope.url);
      return {
        scope: structuredClone(scope),
        revision: (row?.revision as number | undefined) ?? 0,
        operations: store.list(scope.url),
      };
    },
    async batchControl(control: GithubOutboxBatchControl) {
      assertOpen();
      if (!isGithubOutboxBatchControl(control))
        return {
          outcome: "rejected" as const,
          error: diagnostic("invalid", "Invalid GitHub queue batch."),
        };
      const receipt = store.transaction(() =>
        applyBatchControl(store, structuredClone(control), now()),
      );
      setImmediate(() => worker.wake());
      return receipt;
    },
    async heartbeat(heartbeat: GithubOutboxHeartbeat) {
      assertOpen();
      if (!isGithubOutboxHeartbeat(heartbeat)) throw new Error("Invalid GitHub outbox heartbeat");
      store.transaction(() => {
        store.db.prepare("DELETE FROM leases WHERE expires<=?").run(now());
        if (heartbeat.visible)
          store.db
            .prepare(
              "INSERT INTO leases(client,scope,expires) VALUES (?,?,?) ON CONFLICT(client) DO UPDATE SET scope=excluded.scope,expires=excluded.expires",
            )
            .run(heartbeat.clientId, heartbeat.scope.url, now() + (options.leaseMs ?? 30_000));
        else store.db.prepare("DELETE FROM leases WHERE client=?").run(heartbeat.clientId);
      });
      setImmediate(() => worker.wake());
    },
    async control(control: GithubOutboxControl): Promise<GithubOutboxControlReceipt> {
      assertOpen();
      const reject = (
        code: Parameters<typeof diagnostic>[0],
        message: string,
      ): GithubOutboxControlReceipt => ({
        outcome: "rejected",
        operationId: control?.operationId,
        error: diagnostic(code, message),
      });
      if (!isGithubOutboxControl(control)) return reject("invalid", "Invalid outbox control.");
      control = structuredClone(control);
      // Candidate evidence is never a client-authorized state transition. Verify
      // using authenticated reads outside the transaction, then compare revision.
      let verified: Awaited<ReturnType<OutboxWorker["verifyApplied"]>> | undefined;
      if (control.kind === "resolve-uncertainty" && control.resolution.kind === "confirm-applied") {
        const prior = store.db.prepare("SELECT id FROM controls WHERE id=?").get(control.requestId);
        const op = store.get(control.operationId);
        if (!prior && op?.status === "uncertain" && op.revision === control.expectedRevision) {
          const target = resolved(store, op);
          if (target) verified = await worker.verifyApplied(target, control.resolution.result);
          assertOpen();
        }
      }
      let reconcile = false;
      const receipt = store.transaction((): GithubOutboxControlReceipt => {
        const fingerprint = canonical(control);
        const prior = store.db
          .prepare("SELECT fingerprint,receipt FROM controls WHERE id=?")
          .get(control.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            return reject("conflict", "Control request ID was reused with different content.");
          const receipt: GithubOutboxControlReceipt = JSON.parse(prior.receipt as string);
          if (receipt.outcome === "rejected") return receipt;
          const operation = store.get(receipt.operation.command.operationId) ?? receipt.operation;
          if (expireOperation(operation, now())) change(operation);
          return { ...receipt, outcome: "duplicate", operation };
        }
        const apply = (): GithubOutboxControlReceipt => {
          const op = store.get(control.operationId);
          if (!op) return reject("invalid", "Unknown operation.");
          if (op.revision !== control.expectedRevision)
            return reject("conflict", "Operation changed; refresh before applying this control.");
          switch (control.kind) {
            case "cancel":
              if (op.status !== "queued" && op.status !== "retry-failed")
                return reject("conflict", "This operation cannot safely be cancelled.");
              op.status = "cancelled";
              op.retryMode = "blocked";
              delete op.timedOutAt;
              if (op.error?.code === "timeout") delete op.error;
              delete op.nextAttemptAt;
              break;
            case "revise": {
              if (op.status !== "queued" || op.attempts !== 0 || !("body" in op.command.action))
                return reject("conflict", "Only never-attempted queued text can be revised.");
              const action = { ...op.command.action, body: control.body };
              if (!isGithubWriteAction(action)) return reject("invalid", "Invalid revised body.");
              op.command.action = action;
              break;
            }
            case "retry": {
              if (op.status !== "retry-failed")
                return reject("conflict", "Only proven-not-applied failures can be retried.");
              op.status = "queued";
              // The override's duplicate-delivery risk survives later auth blocks,
              // uncertainty, restarts, and subsequent explicit retry decisions.
              const overridden = store.db
                .prepare(
                  "SELECT 1 FROM audit WHERE operation_id=? AND json_valid(event) AND json_extract(event,'$.resolution.kind')='confirm-not-applied' LIMIT 1",
                )
                .get(op.command.operationId);
              op.retryMode = op.retryMode === "manual" || overridden ? "manual" : "automatic";
              op.queueDeadlineAt = new Date(
                Math.min(
                  control.queueDeadlineAt ? Date.parse(control.queueDeadlineAt) : Infinity,
                  now() + (control.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
                ),
              ).toISOString();
              delete op.timedOutAt;
              delete op.archivedAt;
              store.db
                .prepare("UPDATE schedules SET identity_failures=0 WHERE operation_id=?")
                .run(op.command.operationId);
              delete op.error;
              delete op.nextAttemptAt;
              expireOperation(op, now());
              break;
            }
            case "reconcile":
              if (op.status !== "uncertain")
                return reject("conflict", "Only uncertain operations require reconciliation.");
              reconcile = true;
              op.nextAttemptAt = new Date(now()).toISOString();
              break;
            case "resolve-uncertainty": {
              if (op.status !== "uncertain")
                return reject("conflict", "Operation is not uncertain.");
              if (control.resolution.kind === "confirm-applied") {
                const target = resolved(store, op);
                if (
                  !target ||
                  verified?.outcome !== "matched" ||
                  !matches(target, verified.result, op.command.action)
                )
                  return reject(
                    "invalid",
                    "GitHub did not verify evidence matching this operation.",
                  );
                op.status = "synced";
                op.retryMode = "blocked";
                op.result = structuredClone(verified.result);
                delete op.error;
                delete op.timedOutAt;
              } else {
                op.status = "retry-failed";
                op.retryMode = "manual";
                delete op.nextAttemptAt;
                op.error = diagnostic(
                  "conflict",
                  "User confirmed this operation was not applied; retry requires a separate decision.",
                );
              }
              store.db
                .prepare("INSERT INTO audit(operation_id,at,event) VALUES (?,?,?)")
                .run(op.command.operationId, new Date(now()).toISOString(), canonical(control));
              break;
            }
          }
          change(op);
          return { outcome: "applied", operation: op };
        };
        const receipt = apply();
        store.db
          .prepare("INSERT INTO controls(id,fingerprint,receipt) VALUES (?,?,?)")
          .run(control.requestId, fingerprint, JSON.stringify(receipt));
        return receipt;
      });
      if (reconcile)
        setImmediate(() => {
          void worker.reconcile(control.operationId).catch(() => {
            /* Durable uncertainty is preserved on ownership/storage failure. */
          });
        });
      else setImmediate(() => worker.wake());
      return receipt;
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          try {
            await worker.close();
          } finally {
            await store.close();
          }
        })();
      }
      return closing;
    },
  };
}
