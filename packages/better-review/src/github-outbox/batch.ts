import {
  DEFAULT_GITHUB_QUEUE_TIMEOUT_MS,
  type GithubOutboxBatchControl,
  type GithubOutboxBatchReceipt,
  type GithubOutboxOperation,
} from "@better-review/shared";

import { canonical, OutboxDatabase } from "./database";
import { expireOperation } from "./lifecycle";

/** Runs inside the owner's single SQLite transaction, before any worker wake. */
export function applyBatchControl(
  store: OutboxDatabase,
  input: GithubOutboxBatchControl,
  now: number,
): GithubOutboxBatchReceipt {
  const fingerprint = canonical(input);
  const prior = store.db
    .prepare("SELECT fingerprint,receipt FROM controls WHERE id=?")
    .get(input.requestId);
  const reject = (message: string): GithubOutboxBatchReceipt => ({
    outcome: "rejected",
    error: { code: "conflict", message, retryable: false },
  });
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      return reject("Batch request ID was reused with different content.");
    const receipt: GithubOutboxBatchReceipt = JSON.parse(prior.receipt as string);
    if (receipt.outcome === "rejected") return receipt;
    const operations = receipt.operations.map(
      (record) => store.get(record.command.operationId) ?? record,
    );
    for (const op of operations)
      if (expireOperation(op, now)) {
        op.revision++;
        op.updatedAt = new Date(now).toISOString();
        store.save(op);
      }
    return {
      ...receipt,
      outcome: "duplicate",
      operations,
      requiresConfirmation: receipt.requiresConfirmation.filter((id) =>
        ["uncertain", "inflight"].includes(store.get(id)?.status ?? ""),
      ),
    };
  }
  // Validate the whole snapshot before changing anything. Clear must not cancel
  // a root, yield to the worker, and only then cancel its queued followers.
  for (const item of input.operations) {
    const op = store.get(item.operationId);
    if (!op || op.revision !== item.expectedRevision)
      return reject("Queue changed; review the latest queue before trying again.");
  }
  for (const command of input.commands ?? []) {
    const prior = store.db
      .prepare(
        "SELECT fingerprint FROM operations WHERE id=? UNION ALL SELECT fingerprint FROM aliases WHERE id=?",
      )
      .get(command.operationId, command.operationId);
    if (prior && prior.fingerprint !== canonical(command))
      return reject("Saved operation ID belongs to different content.");
  }
  const stamp = new Date(now).toISOString();
  const operations = new Map<string, GithubOutboxOperation>();
  const aliases: Record<string, string> = {};
  const selected = new Set(input.operations.map((item) => store.originalId(item.operationId)));
  for (const command of input.commands ?? []) {
    let op = store.get(command.operationId);
    if (!op) {
      // Durable never-send receipt. A late/lost enqueue replay now sees this same
      // cancelled UUID, not a window in which a cleared local intent can POST.
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
      op = {
        command: structuredClone(command),
        sequence: row.sequence as number,
        revision: 1,
        status: "cancelled",
        retryMode: "blocked",
        attempts: 0,
        createdAt: stamp,
        updatedAt: stamp,
      };
      store.db
        .prepare(
          "INSERT INTO operations(id,scope,sequence,fingerprint,data,content_key) VALUES (?,?,?,?,?,?)",
        )
        .run(
          command.operationId,
          command.scope.url,
          op.sequence,
          canonical(command),
          JSON.stringify(op),
          store.semantic(command).key,
        );
      operations.set(op.command.operationId, op);
    }
    aliases[command.operationId] = op.command.operationId;
    operations.set(op.command.operationId, op);
    selected.add(op.command.operationId);
  }
  const requiresConfirmation: string[] = [];
  const skipped: string[] = [];
  const all = store.list();
  const cutoffs = new Map<string, number>();
  for (const id of selected) {
    const op = store.get(id)!;
    cutoffs.set(
      op.command.scope.url,
      Math.min(cutoffs.get(op.command.scope.url) ?? Infinity, op.sequence),
    );
  }
  for (const op of all) {
    if (["synced", "cancelled"].includes(op.status)) continue;
    if (input.kind === "clear") {
      if (op.sequence < (cutoffs.get(op.command.scope.url) ?? Infinity) || op.archivedAt) continue;
      if (op.status === "uncertain" || op.status === "inflight") {
        op.status = "uncertain";
        op.archivedAt = stamp;
      } else {
        op.status = "cancelled";
        delete op.timedOutAt;
        if (op.error?.code === "timeout") delete op.error;
      }
      op.retryMode = "blocked";
      delete op.nextAttemptAt;
    } else {
      if (!selected.has(op.command.operationId)) continue;
      const first = all.find(
        (item) =>
          item.command.scope.url === op.command.scope.url &&
          !item.archivedAt &&
          !["synced", "cancelled"].includes(item.status),
      );
      if (op.status === "uncertain" || op.status === "inflight") {
        requiresConfirmation.push(op.command.operationId);
        continue;
      }
      if (op.status !== "retry-failed" || first?.command.operationId !== op.command.operationId) {
        skipped.push(op.command.operationId);
        continue;
      }
      op.status = "queued";
      const manual = store.db
        .prepare(
          "SELECT 1 FROM audit WHERE operation_id=? AND json_valid(event) AND json_extract(event,'$.resolution.kind')='confirm-not-applied' LIMIT 1",
        )
        .get(op.command.operationId);
      op.retryMode = op.retryMode === "manual" || manual ? "manual" : "automatic";
      op.queueDeadlineAt = new Date(
        Math.min(
          input.queueDeadlineAt ? Date.parse(input.queueDeadlineAt) : Infinity,
          now + (input.queueTimeoutMs ?? DEFAULT_GITHUB_QUEUE_TIMEOUT_MS),
        ),
      ).toISOString();
      delete op.timedOutAt;
      delete op.archivedAt;
      delete op.error;
      delete op.nextAttemptAt;
      store.db
        .prepare("UPDATE schedules SET identity_failures=0 WHERE operation_id=?")
        .run(op.command.operationId);
      expireOperation(op, now);
    }
    op.revision++;
    op.updatedAt = stamp;
    store.save(op);
    operations.set(op.command.operationId, op);
  }
  const receipt: GithubOutboxBatchReceipt = {
    outcome: "applied",
    operations: [...operations.values()],
    requiresConfirmation,
    skipped,
    aliases,
  };
  store.db
    .prepare("INSERT INTO controls(id,fingerprint,receipt) VALUES (?,?,?)")
    .run(input.requestId, fingerprint, JSON.stringify(receipt));
  return receipt;
}
