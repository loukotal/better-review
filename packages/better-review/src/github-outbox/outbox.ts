import {
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
  type GithubOutboxOperation,
  type GithubOutboxReceipt,
  type GithubPrScope,
} from "@better-review/shared";

import { canonical, OutboxDatabase } from "./database.js";
import type { GithubOutbox, GithubOutboxAdapter } from "./types.js";
import { matches, resolved } from "./validation.js";
import { diagnostic, OutboxWorker } from "./worker.js";

export interface GithubOutboxOptions {
  databasePath: string;
  adapter: GithubOutboxAdapter;
  getCachedActor: () => GithubActor | undefined;
  now?: () => number;
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
    async enqueue(command: GithubOutboxCommand): Promise<GithubOutboxReceipt> {
      assertOpen();
      const reject = (
        code: Parameters<typeof diagnostic>[0],
        message: string,
      ): GithubOutboxReceipt => ({
        outcome: "rejected",
        operationId: command?.operationId,
        error: diagnostic(code, message),
      });
      if (!isGithubOutboxCommand(command))
        return reject("invalid", "Invalid GitHub outbox command.");
      const receipt = store.transaction((): GithubOutboxReceipt => {
        const fingerprint = canonical(command);
        const prior = store.db
          .prepare("SELECT fingerprint FROM operations WHERE id=?")
          .get(command.operationId);
        if (prior)
          return prior.fingerprint === fingerprint
            ? { outcome: "duplicate", operation: store.get(command.operationId)! }
            : reject("conflict", "Operation ID was already used for different content.");
        const actor = options.getCachedActor();
        if (!actor)
          return reject(
            "identity-unknown",
            "A known GitHub identity is required before admission.",
          );
        if (actor.id !== command.expectedActor.id)
          return reject("identity-mismatch", "The operation belongs to another GitHub account.");
        for (const id of command.dependencies) {
          const dependency = store.get(id);
          // Requiring already-admitted parents makes cycles and forward edges impossible.
          if (
            !dependency ||
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
        };
        store.db
          .prepare("INSERT INTO operations(id,scope,sequence,fingerprint,data) VALUES (?,?,?,?,?)")
          .run(
            command.operationId,
            command.scope.url,
            operation.sequence,
            fingerprint,
            JSON.stringify(operation),
          );
        for (const id of command.dependencies)
          store.db.prepare("INSERT INTO dependencies VALUES (?,?)").run(command.operationId, id);
        return { outcome: "accepted", operation };
      });
      // Admission itself never invokes adapter/network, even if a PR is active.
      setImmediate(() => worker.wake());
      return receipt;
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
          return receipt.outcome === "rejected" ? receipt : { ...receipt, outcome: "duplicate" };
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
              delete op.error;
              delete op.nextAttemptAt;
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
