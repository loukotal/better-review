import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  GithubOutboxCommand,
  GithubOutboxOperation,
  GithubPrScope,
  GithubRemoteResult,
} from "@better-review/shared";

import { createGithubOutboxAdapter } from "../../../better-review/src/github-outbox/github";
import { createGithubOutboxRuntime } from "../../../better-review/src/github-outbox/runtime";
import {
  createGithubOutbox,
  type BrowserGithubState,
  type GithubOutboxTransport,
} from "./github-outbox";
import type { BrowserGithubJournal, GithubAdmission } from "./github-outbox-journal";
import {
  cleanGithubOutboxBody,
  createGithubOutboxProjection,
  stripRecognizedGithubMarkers,
  type GithubRemoteRead,
} from "./github-outbox-projection";

const scope: GithubPrScope = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
};
const actor = { id: 12, login: "author" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = (n = 1): GithubOutboxCommand => ({
  operationId: id(n),
  scope,
  expectedActor: actor,
  action: { kind: "issue-comment", body: "hello" },
  dependencies: [],
});
const result = (body = "hello"): GithubRemoteResult => ({
  kind: "issue-comment",
  id: 44,
  url: "https://github.com/owner/repo/issues/1#issuecomment-44",
  body,
  author: actor,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
function operation(
  cmd = command(),
  status: GithubOutboxOperation["status"] = "queued",
  revision = 1,
): GithubOutboxOperation {
  return {
    command: cmd,
    status,
    revision,
    sequence: Number(cmd.operationId.slice(-3)),
    attempts: 0,
    retryMode: "automatic",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...(status === "synced" ? { result: result() } : {}),
  };
}
function browserState(...operations: GithubOutboxOperation[]): BrowserGithubState {
  return {
    scope,
    revision: 1,
    operations: operations.map((op) => ({
      command: op.command,
      backendOwned: true,
      status: op.status,
      operation: op,
    })),
    busy: operations.some((op) => op.status === "queued"),
    pendingSaving: 0,
    pendingCount: operations.filter((op) => op.status !== "synced").length,
  };
}
const empty = (): GithubRemoteRead => ({ comments: [], threads: [], approvals: [] });

for (const kind of ["approve", "request-changes", "review-comment"] as const) {
  test(`${kind}: hydrated confirmed review yields to post-confirmation dismissal with stable identity`, () => {
    const cmd = {
      ...command(),
      action: { kind, expectedHeadSha: "a".repeat(40), body: "Review text" },
    };
    const originalState =
      kind === "approve"
        ? "APPROVED"
        : kind === "request-changes"
          ? "CHANGES_REQUESTED"
          : "COMMENTED";
    const confirmed: GithubRemoteResult =
      kind === "approve"
        ? { kind: "approval", id: 70, url: scope.url, commitSha: "a".repeat(40) }
        : {
            kind: "review",
            id: 70,
            url: scope.url,
            state: kind === "request-changes" ? "CHANGES_REQUESTED" : "COMMENTED",
            commitSha: "a".repeat(40),
            body: "Review text",
            author: actor,
            submittedAt: "2026-01-01T00:00:00Z",
          };
    const synced = { ...operation(cmd, "synced", 2), result: confirmed };
    const state = browserState(synced);
    // A new projector models hydration/reload before its very first remote read.
    const projection = createGithubOutboxProjection();
    const remote = (
      reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED",
      commitSha = confirmed.commitSha,
    ): GithubRemoteRead => ({
      ...empty(),
      reviews: [
        { id: 70, commitSha, state: reviewState, body: "Remote review text", author: actor },
      ],
    });
    const reloaded = createGithubOutboxProjection();
    reloaded.acceptRemote(reloaded.beginRead(state), remote("DISMISSED"));
    const firstRead = reloaded.project(state);
    assert.equal(firstRead.reviews[0].state, "DISMISSED");
    assert.equal(firstRead.reviews[0].operationIds.length, 0);
    assert.equal(firstRead.approvals.length, 0);
    const stale = projection.beginRead(browserState(operation(cmd)));
    projection.acceptRemote(stale, remote("DISMISSED"));
    let projected = projection.project(state);
    assert.equal(
      kind === "approve"
        ? projected.approvals[0].operationIds.length
        : projected.reviews[0].operationIds.length,
      1,
      "pre-confirmation fetch cannot retire overlay",
    );
    const wrongHead = projection.beginRead(state);
    projection.acceptRemote(wrongHead, remote("DISMISSED", "b".repeat(40)));
    projected = projection.project(state);
    assert.equal(
      kind === "approve"
        ? projected.approvals[0].operationIds.length
        : projected.reviews[0].operationIds.length,
      1,
      "different commit cannot retire overlay",
    );
    const fresh = projection.beginRead(state);
    projection.acceptRemote(fresh, remote("DISMISSED"));
    projected = projection.project(state);
    assert.equal(projected.reviews.length, 1);
    assert.equal(projected.reviews[0].state, "DISMISSED");
    assert.equal(projected.reviews[0].body, "Remote review text");
    assert.deepEqual(projected.reviews[0].operationIds, []);
    assert.equal(
      projected.reviews[0].key,
      `local:${kind === "approve" ? "approval" : "review"}:${cmd.operationId}`,
    );
    assert.equal(
      projected.approvals.length,
      0,
      "dismissed approval must not leave approval overlay",
    );
    assert.equal(projection.acceptRemote(stale, remote(originalState)), false);
    assert.equal(projection.project(state).reviews[0].state, "DISMISSED");
    for (const next of ["COMMENTED", "CHANGES_REQUESTED", "APPROVED", "DISMISSED"] as const) {
      projection.acceptRemote(projection.beginRead(state), remote(next));
      const view = projection.project(state).reviews[0];
      assert.equal(view.state, next);
      assert.equal(view.key, projected.reviews[0].key);
      assert.equal(view.operationIds.length, 0);
    }
    for (const status of ["queued", "uncertain"] as const) {
      const pending = browserState({ ...synced, status });
      const unconfirmed = createGithubOutboxProjection();
      unconfirmed.acceptRemote(unconfirmed.beginRead(pending), remote("DISMISSED"));
      const pendingView = unconfirmed.project(pending);
      assert.equal(
        kind === "approve" ? pendingView.approvals[0].pending : pendingView.reviews[0].pending,
        true,
      );
      assert.equal(
        kind === "approve"
          ? pendingView.approvals[0].operationIds.length
          : pendingView.reviews[0].operationIds.length,
        1,
      );
    }
  });
}
function memoryJournal(): BrowserGithubJournal {
  const entries = new Map<string, GithubAdmission>();
  const controls = new Map<
    string,
    { control: import("@better-review/shared").GithubOutboxControl; scope: GithubPrScope }
  >();
  const batches = new Map<string, import("@better-review/shared").GithubOutboxBatchControl>();
  return {
    async admit(cmd, draftKey) {
      const existing = entries.get(cmd.operationId);
      if (existing && JSON.stringify(existing.command) !== JSON.stringify(cmd))
        throw new Error("conflict");
      if (!existing)
        entries.set(cmd.operationId, {
          command: structuredClone(cmd),
          backendOwned: false,
          localOrder: entries.size + 1,
          draftKey,
          admittedAt: new Date().toISOString(),
          admissionDeadlineAt: cmd.queueDeadlineAt ?? new Date(Date.now() + 300_000).toISOString(),
        });
    },
    async put(cmd) {
      await this.admit(cmd);
    },
    async entries(pr) {
      return structuredClone(
        [...entries.values()].filter((entry) => entry.command.scope.url === pr.url),
      );
    },
    async list(pr) {
      return [...entries.values()]
        .filter((entry) => !pr || entry.command.scope.url === pr.url)
        .map((entry) => structuredClone(entry.command));
    },
    async acknowledge(op, submittedId = op.command.operationId) {
      const entry = entries.get(submittedId);
      if (entry && (!entry.operation || entry.operation.revision <= op.revision)) {
        entries.set(submittedId, {
          ...entry,
          backendOwned: true,
          operation: structuredClone(op),
          admissionError: undefined,
          admissionRetryAt: undefined,
          admissionRetryable: undefined,
          admissionTimedOut: undefined,
          admissionRetryRequestId: undefined,
          admissionRetryTimeoutMs: undefined,
        });
      }
    },
    async admissionFailed(
      operationId,
      admissionError,
      admissionRetryAt,
      admissionRetryable,
      admissionTimedOut,
    ) {
      const entry = entries.get(operationId)!;
      entries.set(operationId, {
        ...entry,
        admissionError,
        admissionRetryAt,
        admissionRetryable,
        admissionTimedOut,
      });
    },
    async remove(operationId) {
      entries.delete(operationId);
    },
    async close() {},
    async saveDraft() {},
    async draft() {
      return undefined;
    },
    async putControl(control, scope) {
      controls.set(control.requestId, { control, scope });
    },
    async controls(scope) {
      return [...controls.values()]
        .filter((item) => item.scope.url === scope.url)
        .map((item) => item.control);
    },
    async removeControl(id) {
      controls.delete(id);
    },
    async restartAdmissionCycle(id, deadline, requestId, timeoutMs) {
      const entry = entries.get(id)!;
      entries.set(id, {
        ...entry,
        admissionDeadlineAt: deadline,
        admissionError: undefined,
        admissionTimedOut: undefined,
        admissionRetryAt: undefined,
        admissionRetryable: undefined,
        admissionRetryRequestId: requestId,
        admissionRetryTimeoutMs: timeoutMs,
      });
    },
    async putBatch(control) {
      batches.set(control.requestId, structuredClone(control));
    },
    async batches() {
      return [...batches.values()];
    },
    async removeBatch(id) {
      batches.delete(id);
    },
  };
}

test("local admission timeout survives reopen and preference changes; explicit Retry preserves command and starts a separate cycle", async () => {
  const journal = memoryJournal();
  let now = Date.now();
  let online = false;
  const seen: GithubOutboxCommand[] = [];
  const cycles: import("@better-review/shared").GithubOutboxAdmissionCycle[] = [];
  const wire = transport({
    async enqueue(cmd, cycle) {
      seen.push(structuredClone(cmd));
      if (!online) throw new Error("offline fixture");
      assert.ok(cycle);
      cycles.push(cycle);
      return {
        outcome: "accepted",
        operation: { ...operation(cmd, "queued"), queueDeadlineAt: cycle.queueDeadlineAt },
      };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire, now: () => now });
  try {
    client.setQueueTimeoutMs(60_000);
    const submitted = await client.submit({
      scope,
      actor,
      operationId: id(1),
      action: command().action,
    });
    await client.recover(scope);
    const before = seen.length;
    now += 60_000;
    await client.recover(scope);
    assert.equal(client.getState(scope).busy, false);
    assert.equal(client.getState(scope).operations[0].admissionTimedOut, true);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire, now: () => now });
    client.setQueueTimeoutMs(15 * 60_000);
    await client.recover(scope);
    assert.equal(seen.length, before);
    assert.equal(
      (await journal.entries(scope))[0].command.queueDeadlineAt,
      submitted.command.queueDeadlineAt,
    );
    online = true;
    await client.retryAdmission(scope, id(1));
    assert.ok(seen.every((cmd) => JSON.stringify(cmd) === JSON.stringify(submitted.command)));
    assert.equal(cycles.length, 1);
    assert.equal(client.getState(scope).operations[0].status, "queued");
    assert.equal(
      client.getState(scope).operations[0].operation?.queueDeadlineAt,
      new Date(now + 15 * 60_000).toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("offline Clear is durable and suppresses admission before replaying its never-send receipt", async () => {
  const journal = memoryJournal();
  await journal.admit(command());
  let online = false;
  let admissions = 0;
  const wire = transport({
    async enqueue(cmd) {
      admissions++;
      return { outcome: "accepted", operation: operation(cmd) };
    },
    async batchControl(input) {
      if (!online) throw new Error("offline clear fixture");
      return {
        outcome: "applied",
        operations: input.commands!.map((cmd) => operation(cmd, "cancelled")),
        requiresConfirmation: [],
        skipped: [],
        aliases: Object.fromEntries(
          input.commands!.map((cmd) => [cmd.operationId, cmd.operationId]),
        ),
      };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire });
  try {
    await assert.rejects(client.clearAll());
    await client.recoverAll();
    assert.equal(admissions, 0);
    assert.equal(client.getState(scope).busy, false);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire });
    await client.recoverAll();
    assert.equal(admissions, 0);
    online = true;
    await client.recoverAll();
    assert.equal(admissions, 0);
    assert.equal(client.getState(scope).pendingCount, 0);
    assert.equal(client.getState(scope).operations[0].status, "cancelled");
    assert.deepEqual((await journal.entries(scope))[0].command, command());
  } finally {
    await client.close();
  }
});

test("archived uncertainty stays in history but not the active queue or optimistic comment projection", async () => {
  const archived = { ...operation(command(), "uncertain"), archivedAt: new Date().toISOString() };
  const client = createGithubOutbox({
    journal: memoryJournal(),
    transport: transport({
      async snapshot() {
        return { scope, revision: 1, operations: [archived] };
      },
    }),
  });
  try {
    await client.snapshot(scope);
    const view = client.getState(scope);
    assert.equal(view.operations.length, 1);
    assert.equal(view.pendingCount, 0);
    assert.equal(view.busy, false);
    assert.equal(createGithubOutboxProjection().project(view).comments.length, 0);
  } finally {
    await client.close();
  }
});

test("queue duration is validated and frozen per new intent, not silently extended by preference changes", async () => {
  const journal = memoryJournal();
  const now = Date.now();
  const client = createGithubOutbox({ journal, transport: transport(), now: () => now });
  try {
    for (const bad of [0, NaN, Infinity, 59_999, 3_600_001, 60_000.5])
      assert.throws(() => client.setQueueTimeoutMs(bad));
    client.setQueueTimeoutMs(15 * 60_000);
    const first = await client.submit({
      scope,
      actor,
      action: command().action,
      operationId: id(1),
    });
    client.setQueueTimeoutMs(60 * 60_000);
    const second = await client.submit({
      scope,
      actor,
      action: command().action,
      operationId: id(2),
    });
    assert.equal(first.command.queueDeadlineAt, new Date(now + 15 * 60_000).toISOString());
    assert.equal(second.command.queueDeadlineAt, new Date(now + 60 * 60_000).toISOString());
    assert.equal(
      (await journal.entries(scope))[0].command.queueDeadlineAt,
      first.command.queueDeadlineAt,
    );
  } finally {
    await client.close();
  }
});

test("Retry all freezes its duration/deadline before journal awaits and later preference changes", async () => {
  const journal = memoryJournal();
  await journal.admit(command());
  await journal.acknowledge(operation(command(), "retry-failed"));
  let now = Date.now();
  const started = now;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = journal.list.bind(journal);
  journal.list = async () => {
    await gate;
    return list();
  };
  let captured: import("@better-review/shared").GithubOutboxBatchControl | undefined;
  const client = createGithubOutbox({
    journal,
    now: () => now,
    transport: transport({
      async batchControl(input) {
        captured = input;
        return {
          outcome: "applied",
          operations: [
            { ...operation(command(), "queued", 2), queueDeadlineAt: input.queueDeadlineAt },
          ],
          requiresConfirmation: [],
          skipped: [],
          aliases: {},
        };
      },
    }),
  });
  try {
    const pending = client.retryAll();
    now += 120_000;
    client.setQueueTimeoutMs(30 * 60_000);
    release();
    await pending;
    assert.equal(captured?.queueTimeoutMs, 300_000);
    assert.equal(captured?.queueDeadlineAt, new Date(started + 300_000).toISOString());
  } finally {
    release();
    await client.close();
  }
});

test("definitively rejected saved Clear is removed, not replayed forever as a stale decision", async () => {
  const journal = memoryJournal();
  await journal.admit(command());
  let batchCalls = 0;
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async batchControl() {
        batchCalls++;
        return {
          outcome: "rejected",
          error: { code: "conflict", message: "Queue changed", retryable: false },
        };
      },
      async enqueue() {
        throw new Error("Fixture offline");
      },
    }),
  });
  try {
    await assert.rejects(client.clearAll(), /Queue changed/);
    assert.equal((await journal.batches!()).length, 0);
    await client.recoverAll();
    await client.recoverAll();
    assert.equal(batchCalls, 1);
    assert.ok(!client.getState(scope).operations[0].admissionError?.includes("Clear"));
  } finally {
    await client.close();
  }
});

test("held Clear acknowledgement times out, keeps the durable decision, then replays the same request without admission", async () => {
  const journal = memoryJournal();
  await journal.admit(command());
  let online = false;
  let admissions = 0;
  const ids: string[] = [];
  const wire = transport({
    async enqueue(cmd) {
      admissions++;
      return { outcome: "accepted", operation: operation(cmd) };
    },
    async batchControl(input) {
      ids.push(input.requestId);
      if (!online) return new Promise<never>(() => {});
      return {
        outcome: "duplicate",
        operations: input.commands!.map((cmd) => operation(cmd, "cancelled")),
        aliases: Object.fromEntries(
          input.commands!.map((cmd) => [cmd.operationId, cmd.operationId]),
        ),
        requiresConfirmation: [],
        skipped: [],
      };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire, requestTimeoutMs: 5 });
  try {
    await assert.rejects(client.clearAll(), /timed out/);
    assert.equal((await journal.batches!()).length, 1);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire, requestTimeoutMs: 5 });
    online = true;
    await client.recoverAll();
    assert.deepEqual(ids, [ids[0], ids[0]]);
    assert.equal(admissions, 0);
    assert.equal(client.getState(scope).pendingCount, 0);
  } finally {
    await client.close();
  }
});

test("a child waiting for its parent cannot enqueue after another client persists an unacknowledged Clear", async () => {
  for (const secondClient of [false, true]) {
    const journal = memoryJournal();
    await journal.admit(command(1));
    let parentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      parentStarted = resolve;
    });
    let releaseParent!: () => void;
    const parent = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let clearStarted!: () => void;
    const clearing = new Promise<void>((resolve) => {
      clearStarted = resolve;
    });
    let releaseClear!: () => void;
    const clear = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let childCalls = 0;
    const remote = new Map<string, GithubOutboxOperation>();
    const wire = transport({
      async enqueue(cmd) {
        if (cmd.operationId === id(1)) {
          parentStarted();
          await parent;
        } else childCalls++;
        const op = operation(cmd, "synced");
        remote.set(cmd.operationId, op);
        return { outcome: "accepted", operation: op };
      },
      async batchControl(input) {
        clearStarted();
        await clear;
        const operations = input.commands!.map((cmd) =>
          operation(cmd, cmd.operationId === id(1) ? "synced" : "cancelled", 2),
        );
        for (const op of operations) remote.set(op.command.operationId, op);
        return {
          outcome: "applied",
          operations,
          aliases: Object.fromEntries(
            input.commands!.map((cmd) => [cmd.operationId, cmd.operationId]),
          ),
          requiresConfirmation: [],
          skipped: [],
        };
      },
      async snapshot() {
        return { scope, revision: 2, operations: [...remote.values()] };
      },
    });
    const client = createGithubOutbox({ journal, transport: wire });
    const clearingClient = secondClient ? createGithubOutbox({ journal, transport: wire }) : client;
    let decision: Promise<unknown> | undefined;
    try {
      await client.submit({
        scope,
        actor,
        operationId: id(2),
        action: { kind: "issue-comment", body: "child" },
        dependencies: [id(1)],
      });
      await started;
      decision = clearingClient.clearAll();
      await clearing;
      assert.equal(
        (await journal.batches!()).length,
        1,
        "Clear is durable before releasing parent acknowledgement",
      );
      releaseParent();
      await client.recover(scope);
      assert.equal(childCalls, 0, "child entered transport while Clear was unacknowledged");
      releaseClear();
      await decision;
      await client.recover(scope);
      assert.equal(childCalls, 0);
      assert.equal(
        client.getState(scope).operations.find((item) => item.command.operationId === id(2))!
          .status,
        "cancelled",
      );
    } finally {
      releaseParent();
      releaseClear();
      await decision?.catch(() => {});
      await client.close();
      if (clearingClient !== client) await clearingClient.close();
    }
  }
});

test("reusing a submitted draft after timeout preserves its original deadline and UUID instead of restarting it", async () => {
  const journal = memoryJournal();
  let now = Date.now();
  let linked: string | undefined;
  let calls = 0;
  const admit = journal.admit.bind(journal);
  journal.admit = async (cmd, draftKey) => {
    await admit(cmd, draftKey);
    linked = cmd.operationId;
  };
  journal.draft = async (key) => ({ key, scope, body: "hello", submittedOperationId: linked });
  const client = createGithubOutbox({
    journal,
    now: () => now,
    transport: transport({
      async enqueue() {
        calls++;
        throw new Error("Fixture offline");
      },
    }),
  });
  try {
    const first = await client.submit({
      scope,
      actor,
      draftKey: "same-draft",
      operationId: id(1),
      action: command().action,
    });
    await client.recover(scope);
    const before = calls;
    now += 300_000;
    client.setQueueTimeoutMs(30 * 60_000);
    const reused = await client.submit({
      scope,
      actor,
      draftKey: "same-draft",
      operationId: id(2),
      action: command().action,
    });
    await client.recover(scope);
    assert.equal(reused.operationId, first.operationId);
    assert.equal(calls, before);
    assert.equal(reused.command.queueDeadlineAt, first.command.queueDeadlineAt);
    assert.equal(client.getState(scope).busy, false);
    assert.equal((await journal.entries(scope)).length, 1);
  } finally {
    await client.close();
  }
});

test("restart identity initialization and lost acknowledgement recover one durable write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-recovery-"));
  let release!: () => void;
  const initialized = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  let now = Date.now();
  const runtimeOptions = {
    databasePath: join(directory, "outbox.sqlite"),
    adapter: createGithubOutboxAdapter({
      token: async () => "fixture-only",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/user") {
          await initialized;
          return Response.json(actor);
        }
        assert.equal(path, "/repos/owner/repo/issues/1/comments");
        assert.equal(init?.method, "POST");
        posts++;
        return Response.json({
          id: 44,
          html_url: "https://github.com/owner/repo/issues/1#issuecomment-44",
          issue_url: "https://api.github.com/repos/owner/repo/issues/1",
          user: actor,
          body: JSON.parse(String(init?.body)).body,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        });
      },
    }),
  };
  let runtime = await createGithubOutboxRuntime(runtimeOptions);
  const journal = memoryJournal();
  let loseAck = true;
  let withholdSnapshot = false;
  let admissions = 0;
  const wire: GithubOutboxTransport = {
    async enqueue(cmd) {
      admissions++;
      const receipt = await runtime.outbox.enqueue(cmd);
      if (receipt.outcome !== "rejected" && loseAck) {
        loseAck = false;
        withholdSnapshot = true;
        throw new Error("connection lost after durable admission");
      }
      return receipt;
    },
    snapshot: (pr) => {
      if (withholdSnapshot) {
        withholdSnapshot = false;
        throw new Error("snapshot connection lost");
      }
      return runtime.outbox.snapshot(pr);
    },
    heartbeat: (value) => runtime.outbox.heartbeat(value),
    control: (value) => runtime.outbox.control(value),
  };
  let client = createGithubOutbox({ journal, transport: wire, now: () => now });
  try {
    await journal.admit(command());
    await client.recover(scope);
    assert.equal(admissions, 1);
    assert.equal(client.getState(scope).operations[0].backendOwned, false);
    release();
    await runtime.refreshIdentity();
    await client.recover(scope);
    assert.equal(admissions, 1, "honor retry deadline");
    now += 15_001;
    await assert.rejects(client.recover(scope)); // admission committed, both responses withheld
    assert.equal(admissions, 2, "identity initialization must not strand local work");
    assert.equal((await journal.entries(scope))[0].backendOwned, false);
    await client.close();
    await runtime.close();
    runtime = await createGithubOutboxRuntime(runtimeOptions);
    await runtime.refreshIdentity();
    client = createGithubOutbox({ journal, transport: wire, now: () => now });
    await client.recover(scope);
    assert.equal(client.getState(scope).operations[0].backendOwned, true);
    assert.equal((await runtime.outbox.snapshot(scope)).operations.length, 1);
    // Already admitted intents complete after restart without a UI heartbeat.
    for (let count = 0; count < 100; count++) {
      if ((await runtime.outbox.snapshot(scope)).operations[0].status === "synced") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await client.recover(scope);
    assert.equal(client.getState(scope).operations[0].status, "synced");
    assert.equal(posts, 1);
  } finally {
    release();
    await client.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("upgrade recovers only the legacy identity-initializing rejection; permanent errors stay local", async () => {
  for (const [message, expectedCalls] of [
    ["A known GitHub identity is required before admission.", 1],
    ["The operation belongs to another GitHub account.", 0],
    ["Invalid GitHub outbox command.", 0],
    ["Parent admission needs explicit attention", 0],
  ] as const) {
    const journal = memoryJournal();
    await journal.admit(command());
    await journal.admissionFailed(id(1), message);
    let calls = 0;
    const client = createGithubOutbox({
      journal,
      transport: transport({
        async enqueue(cmd) {
          calls++;
          return { outcome: "accepted", operation: operation(cmd) };
        },
      }),
    });
    try {
      await client.recover(scope);
      await client.recover(scope);
      assert.equal(calls, expectedCalls, message);
      assert.equal(client.getState(scope).operations[0].backendOwned, expectedCalls === 1);
      if (!expectedCalls) assert.equal(client.getState(scope).busy, false);
    } finally {
      await client.close();
    }
  }
});

test("queued followers expose their uncertain or permanent FIFO blocker without pretending to progress", async () => {
  for (const status of ["uncertain", "retry-failed"] as const) {
    const first = { ...operation(command(1), status), retryMode: "blocked" as const };
    const second = operation(command(2));
    const client = createGithubOutbox({
      journal: memoryJournal(),
      transport: transport({
        async snapshot() {
          return { scope, revision: 2, operations: [first, second] };
        },
      }),
    });
    try {
      await client.snapshot(scope);
      const view = client.getState(scope);
      assert.equal(view.operations[1].blockedByOperationId, id(1));
      assert.equal(view.pendingCount, 2);
      assert.equal(view.busy, false);
    } finally {
      await client.close();
    }
  }
});

test("transient identity admission honors the later server retryAt, including across client recreation", async () => {
  const journal = memoryJournal();
  let now = Date.now();
  const retryAt = now + 120_000;
  let calls = 0;
  const wire = transport({
    async enqueue(cmd) {
      calls++;
      if (calls === 1)
        return {
          outcome: "rejected",
          operationId: cmd.operationId,
          error: {
            code: "identity-unknown",
            message: "Fixture account verification unavailable",
            retryable: true,
            retryAt: new Date(retryAt).toISOString(),
          },
        };
      return { outcome: "accepted", operation: operation(cmd) };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire, now: () => now });
  try {
    await journal.admit(command());
    await client.recover(scope);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire, now: () => now });
    now += 15_001;
    await client.recover(scope);
    await client.retryAdmission(scope, id(1));
    assert.equal(calls, 1, "neither automatic nor explicit retries bypass remote deadline");
    now = retryAt;
    await client.recover(scope);
    assert.equal(calls, 2);
    assert.equal(client.getState(scope).operations[0].backendOwned, true);
  } finally {
    await client.close();
  }
});

test("local child behind rejected admission exposes its parent instead of silently retrying forever", async () => {
  const journal = memoryJournal();
  await journal.admit(command(1));
  await journal.admissionFailed(id(1), "The operation belongs to another GitHub account.");
  await journal.admit({ ...command(2), dependencies: [id(1)] });
  let calls = 0;
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async enqueue() {
        calls++;
        throw new Error("Must not admit before rejected parent");
      },
    }),
  });
  try {
    await client.recover(scope);
    await client.recover(scope);
    const view = client.getState(scope);
    assert.equal(calls, 0);
    assert.equal(view.operations[1].blockedByOperationId, id(1));
    assert.equal(view.busy, false);
    assert.equal(view.pendingCount, 2);
  } finally {
    await client.close();
  }
});

test("deep rejected admission blocks every descendant across reload, then admits each once in dependency order", async () => {
  const journal = memoryJournal();
  // Deliberately not topological: recovery must not depend on journal iteration order.
  for (const n of [4, 3, 2, 1])
    await journal.admit({ ...command(n), dependencies: n === 1 ? [] : [id(n - 1)] });
  await journal.admissionFailed(id(1), "The operation belongs to another GitHub account.");
  const calls: string[] = [];
  const wire = transport({
    async enqueue(cmd) {
      calls.push(cmd.operationId);
      for (const parent of cmd.dependencies) assert.ok(calls.indexOf(parent) < calls.length - 1);
      return { outcome: "accepted", operation: operation(cmd) };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire });
  try {
    for (let i = 0; i < 3; i++) await client.recover(scope);
    assert.deepEqual(calls, []);
    for (const item of client.getState(scope).operations)
      if (item.command.operationId !== id(1)) assert.equal(item.blockedByOperationId, id(1));
    assert.equal(client.getState(scope).busy, false);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire });
    await client.recover(scope);
    assert.equal(client.getState(scope).busy, false);
    assert.deepEqual(calls, []);
    await client.retryAdmission(scope, id(1));
    await client.recover(scope);
    await client.recover(scope);
    assert.deepEqual(calls, [id(1), id(2), id(3), id(4)]);
    assert.ok(
      client
        .getState(scope)
        .operations.every((item) => item.backendOwned && !item.blockedByOperationId),
    );
  } finally {
    await client.close();
  }
});

test("app-wide recovery on the list page replays lost acknowledgements across PRs without leases or account rebinding", async () => {
  const journal = memoryJournal();
  const otherScope = { ...scope, number: 2, url: "https://github.com/owner/repo/pull/2" };
  const own = command(1);
  const foreign = { ...command(2), scope: otherScope, expectedActor: { id: 99, login: "other" } };
  await journal.admit(own);
  await journal.admit(foreign);
  const calls: GithubOutboxCommand[] = [];
  let committed: GithubOutboxOperation | undefined;
  let loseSnapshot = false;
  let heartbeats = 0;
  const wire = transport({
    async enqueue(cmd) {
      calls.push(structuredClone(cmd));
      if (cmd.expectedActor.id !== actor.id)
        return {
          outcome: "rejected",
          operationId: cmd.operationId,
          error: {
            code: "identity-mismatch",
            message: "Saved operation belongs to another account",
            retryable: false,
          },
        };
      if (committed) return { outcome: "duplicate", operation: committed };
      committed = operation(cmd);
      loseSnapshot = true;
      throw new Error("Fixture lost durable admission acknowledgement");
    },
    async snapshot(pr) {
      if (pr.url === scope.url && loseSnapshot) {
        loseSnapshot = false;
        throw new Error("Fixture disconnected");
      }
      return {
        scope: pr,
        revision: committed && pr.url === scope.url ? 1 : 0,
        operations: committed && pr.url === scope.url ? [committed] : [],
      };
    },
    async heartbeat() {
      heartbeats++;
    },
  });
  const client = createGithubOutbox({ journal, transport: wire, pollMs: 5 });
  try {
    client.activate(); // list page: no active PR
    client.startRecovery();
    const deadline = Date.now() + 2_000;
    while (!client.getState(scope).operations[0]?.backendOwned) {
      assert.ok(Date.now() < deadline, "global recovery did not resume local work");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await client.recoverAll();
    await client.recoverAll();
    assert.equal(calls.filter((cmd) => cmd.operationId === own.operationId).length, 2);
    assert.equal(calls.filter((cmd) => cmd.operationId === foreign.operationId).length, 1);
    assert.ok(
      calls.every(
        (cmd) =>
          JSON.stringify(cmd) ===
          JSON.stringify(cmd.operationId === own.operationId ? own : foreign),
      ),
    );
    assert.equal(client.getState(otherScope).operations[0].backendOwned, false);
    assert.match(client.getState(otherScope).operations[0].admissionError!, /another account/);
    assert.equal(client.getState(otherScope).busy, false);
    assert.equal(heartbeats, 0);
    assert.equal(client.getStates().length, 2);
  } finally {
    await client.close();
  }
});

test("global backend discovery restores pending state on reload without creating an admission or lease", async () => {
  const pending = operation(command(10), "uncertain");
  let admissions = 0;
  let leases = 0;
  const client = createGithubOutbox({
    journal: memoryJournal(),
    transport: transport({
      async listPending() {
        return [
          {
            scope,
            revision: 1,
            pendingCount: 1,
            counts: { queued: 0, inflight: 0, uncertain: 1, "retry-failed": 0 },
            updatedAt: pending.updatedAt,
            blockedByOperationId: pending.command.operationId,
          },
        ];
      },
      async snapshot() {
        return { scope, revision: 1, operations: [pending] };
      },
      async enqueue(cmd) {
        admissions++;
        return { outcome: "accepted", operation: operation(cmd) };
      },
      async heartbeat() {
        leases++;
      },
    }),
  });
  try {
    await client.recoverAll();
    assert.equal(client.getStates()[0].operations[0].status, "uncertain");
    assert.equal(admissions, 0);
    assert.equal(leases, 0);
  } finally {
    await client.close();
  }
});

test("global recovery never auto-submits saved manual cooldowns, even after their deadline", async () => {
  const journal = memoryJournal();
  await journal.admit(command());
  await journal.admissionFailed(
    id(1),
    "Review cooldown requires explicit retry",
    "2020-01-01T00:00:00Z",
    false,
  );
  let admissions = 0;
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async enqueue(cmd) {
        admissions++;
        return { outcome: "accepted", operation: operation(cmd) };
      },
    }),
  });
  try {
    await client.recoverAll();
    await client.recoverAll();
    assert.equal(admissions, 0);
    assert.equal(client.getStates()[0].busy, false);
  } finally {
    await client.close();
  }
});

test("deep dependencies distinguish automatic identity waiting from manual cooldown after its deadline", async () => {
  for (const automatic of [true, false]) {
    const journal = memoryJournal();
    let now = Date.now();
    for (const n of [3, 2, 1])
      await journal.admit({ ...command(n), dependencies: n === 1 ? [] : [id(n - 1)] });
    await journal.admissionFailed(
      id(1),
      automatic ? "Fixture identity initializing" : "Review cooldown",
      new Date(now + 15_000).toISOString(),
      automatic,
    );
    const calls: string[] = [];
    const wire = transport({
      async enqueue(cmd) {
        calls.push(cmd.operationId);
        return { outcome: "accepted", operation: operation(cmd) };
      },
    });
    let client = createGithubOutbox({ journal, transport: wire, now: () => now });
    try {
      await client.recover(scope);
      await client.recover(scope);
      assert.deepEqual(calls, []);
      assert.equal(client.getState(scope).busy, automatic);
      const child = client
        .getState(scope)
        .operations.find((item) => item.command.operationId === id(3))!;
      assert.equal(child.blockedByOperationId, automatic ? undefined : id(1));
      await client.close();
      client = createGithubOutbox({ journal, transport: wire, now: () => now });
      now += 15_001;
      await client.recover(scope);
      if (!automatic) {
        assert.deepEqual(calls, [], "expired cooldown does not authorize automatic submission");
        assert.equal(client.getState(scope).busy, false);
        await client.retryAdmission(scope, id(1));
        await client.recover(scope);
      }
      assert.deepEqual(calls, [id(1), id(2), id(3)]);
    } finally {
      await client.close();
    }
  }
});

test("deep blockers resolve receipt aliases to the canonical root across reload", async () => {
  const journal = memoryJournal();
  await journal.admit(command(1));
  const canonical: GithubOutboxOperation = {
    ...operation(command(10), "retry-failed"),
    sequence: 1,
    retryMode: "blocked",
    error: { code: "auth", message: "Check authentication", retryable: false },
  };
  await journal.acknowledge(canonical, id(1));
  for (const n of [4, 3, 2]) await journal.admit({ ...command(n), dependencies: [id(n - 1)] });
  let calls = 0;
  const wire = transport({
    async enqueue() {
      calls++;
      throw new Error("Blocked alias chain must not admit");
    },
  });
  for (let reload = 0; reload < 2; reload++) {
    const client = createGithubOutbox({ journal, transport: wire });
    try {
      await client.recover(scope);
      await client.recover(scope);
      const view = client.getState(scope);
      assert.equal(view.busy, false);
      assert.equal(view.operations.length, 4);
      for (const item of view.operations)
        if (item.command.operationId !== id(10)) assert.equal(item.blockedByOperationId, id(10));
      assert.deepEqual(
        view.operations.find((item) => item.command.operationId === id(2))!.command.dependencies,
        [id(10)],
      );
      assert.equal(calls, 0);
    } finally {
      await client.close();
    }
  }
});

test("a secondary intermediate admission error does not hide the original prerequisite blocker", async () => {
  const journal = memoryJournal();
  for (const n of [1, 2, 3])
    await journal.admit({ ...command(n), dependencies: n === 1 ? [] : [id(n - 1)] });
  await journal.admissionFailed(id(1), "The operation belongs to another GitHub account.");
  await journal.admissionFailed(id(2), "A prerequisite was not admitted.");
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async enqueue() {
        throw new Error("Rejected graph must not reach HTTP");
      },
    }),
  });
  try {
    await client.recover(scope);
    const view = client.getState(scope);
    assert.equal(view.operations[1].blockedByOperationId, id(1));
    assert.equal(view.operations[2].blockedByOperationId, id(1));
    assert.equal(view.busy, false);
  } finally {
    await client.close();
  }
});

test("malformed dependency cycles and descendants stay visible and never enter admission flights", async () => {
  for (const length of [2, 3]) {
    const journal = memoryJournal();
    for (let n = 1; n <= length; n++)
      await journal.admit({ ...command(n), dependencies: [id(n === length ? 1 : n + 1)] });
    await journal.admit({ ...command(length + 1), dependencies: [id(length)] });
    let calls = 0;
    const client = createGithubOutbox({
      journal,
      transport: transport({
        async enqueue() {
          calls++;
          throw new Error("Cycle must not reach HTTP");
        },
      }),
    });
    try {
      await client.recover(scope);
      await client.recover(scope);
      await client.retryAdmission(scope, id(1));
      const view = client.getState(scope);
      assert.equal(calls, 0);
      assert.equal(view.busy, false);
      assert.equal(view.pendingCount, length + 1);
      for (const item of view.operations) assert.equal(item.blockedByOperationId, id(1));
      assert.match(
        view.operations.find((item) => item.command.operationId === id(1))!.admissionError!,
        /Cyclic/,
      );
    } finally {
      await client.close();
    }
  }
});

test("different UUID duplicate receipt acknowledges submitted journal entry and reload has no ghost", async () => {
  const journal = memoryJournal();
  const canonical = operation(command(1));
  const wire = transport({
    async enqueue(cmd) {
      if (cmd.action.kind === "edit-comment") throw new Error("offline child admission");
      return { outcome: "duplicate", operation: canonical };
    },
    async snapshot() {
      return { scope, revision: 1, operations: [canonical] };
    },
    async control(request) {
      assert.equal(request.operationId, id(2));
      return { outcome: "applied", operation: canonical };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire });
  await client.submit({ scope, actor, action: command().action, operationId: id(2) });
  await client.recover(scope);
  assert.equal((await journal.entries(scope))[0].backendOwned, true);
  assert.equal((await journal.entries(scope))[0].command.operationId, id(2));
  assert.equal(client.getState(scope).operations.length, 1);
  assert.equal(client.getState(scope).operations[0].command.operationId, id(1));
  assert.equal(client.getState(scope).pendingCount, 1);
  assert.equal((await client.draftForOperation(scope, id(2)))?.submittedOperationId, id(1));
  assert.equal(
    (
      await client.control(scope, {
        requestId: id(3),
        operationId: id(2),
        expectedRevision: 1,
        kind: "cancel",
      })
    )?.outcome,
    "applied",
  );
  await client.close();
  client = createGithubOutbox({ journal, transport: wire });
  await client.recover(scope);
  assert.equal(client.getState(scope).operations.length, 1);
  assert.equal(client.getState(scope).pendingCount, 1);
  await client.submit({
    scope,
    actor,
    operationId: id(4),
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "issue-comment", operationId: id(2) },
      body: "edited",
      expectedBody: "hello",
    },
  });
  await client.recover(scope);
  const child = client
    .getState(scope)
    .operations.find((item) => item.command.operationId === id(4))!;
  assert.deepEqual(child.command.dependencies, [id(1)]);
  assert.deepEqual(child.command.action, {
    kind: "edit-comment",
    target: { source: "local", kind: "issue-comment", operationId: id(1) },
    body: "edited",
    expectedBody: "hello",
  });
  const projected = createGithubOutboxProjection().project(client.getState(scope));
  assert.equal(projected.comments.length, 1);
  assert.equal(projected.comments[0].body, "edited");
  await client.close();
});
function transport(overrides: Partial<GithubOutboxTransport> = {}): GithubOutboxTransport {
  return {
    async enqueue(cmd) {
      return { outcome: "accepted", operation: operation(cmd) };
    },
    async snapshot(pr) {
      return { scope: pr, revision: 0, operations: [] };
    },
    async heartbeat() {},
    async control() {
      throw new Error("not called");
    },
    ...overrides,
  };
}

test("approval cooldown survives client restart and requires an explicit retry of the same intent", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:59Z"),
    calls = 0;
  const retryAt = "2026-01-01T00:01:00Z";
  t.mock.method(Date, "now", () => clock);
  const journal = memoryJournal();
  const wire = transport({
    async enqueue(cmd) {
      calls++;
      if (clock < Date.parse(retryAt))
        return {
          outcome: "rejected",
          operationId: cmd.operationId,
          error: {
            code: "approval-cooldown",
            retryable: true,
            retryAt,
            message: "Wait for approval cooldown",
          },
        };
      return { outcome: "accepted", operation: operation(cmd) };
    },
  });
  let client = createGithubOutbox({ journal, transport: wire });
  const action = {
    kind: "approve",
    expectedHeadSha: "a".repeat(40),
    body: "retained approval",
  } as const;
  const intent = await client.submit({ scope, actor, action, operationId: id(9) });
  await client.recover(scope);
  assert.equal(calls, 1);
  assert.equal(client.getState(scope).operations[0].status, "local-pending");
  assert.equal(client.getState(scope).operations[0].admissionRetryAt, retryAt);
  await client.close();
  client = createGithubOutbox({ journal, transport: wire });
  await client.recover(scope);
  await client.retryAdmission(scope, intent.operationId);
  assert.equal(calls, 1, "early explicit retry must not contact admission");
  clock += 1_000;
  await client.recover(scope);
  assert.equal(calls, 1, "expiry must not auto-submit an approval");
  await Promise.all([
    client.retryAdmission(scope, intent.operationId),
    client.retryAdmission(scope, intent.operationId),
  ]);
  assert.equal(calls, 2);
  const entry = (await journal.entries(scope))[0];
  assert.equal(entry.command.operationId, intent.operationId);
  assert.deepEqual(entry.command.action, action);
  assert.equal(entry.backendOwned, true);
  assert.equal(entry.admissionRetryAt, undefined);
  await client.recover(scope);
  assert.equal(calls, 2);
  await client.close();
});

test("journal failure rejects before network and unknown identity never creates an unbound command", async () => {
  let calls = 0;
  const journal = memoryJournal();
  journal.admit = async () => {
    throw new Error("storage unavailable");
  };
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async enqueue(cmd) {
        calls++;
        return { outcome: "accepted", operation: operation(cmd) };
      },
    }),
  });
  await assert.rejects(
    client.submit({ scope, actor, action: command().action }),
    /storage unavailable/,
  );
  await assert.rejects(
    client.submit({ scope, actor: undefined, action: command().action }),
    /identity is unknown/,
  );
  assert.equal(calls, 0);
  assert.equal(client.getState(scope).pendingSaving, 0);
  assert.equal(client.getState(scope).busy, false);
  assert.deepEqual(await journal.list(), []);
  await client.close();
});

for (const kind of ["request-changes", "review-comment"] as const) {
  test(`${kind}: journal retains cooldown draft intent and immutable head across client restart`, async (t) => {
    let clock = Date.parse("2026-01-01T00:00:59Z"),
      calls = 0;
    t.mock.method(Date, "now", () => clock);
    const retryAt = "2026-01-01T00:01:00Z";
    const journal = memoryJournal();
    const wire = transport({
      enqueue: async (cmd) => {
        calls++;
        return clock < Date.parse(retryAt)
          ? {
              outcome: "rejected",
              operationId: cmd.operationId,
              error: { code: "review-cooldown", message: "Wait", retryable: true, retryAt },
            }
          : { outcome: "accepted", operation: operation(cmd) };
      },
    });
    let client = createGithubOutbox({ journal, transport: wire });
    const action = { kind, expectedHeadSha: "a".repeat(40), body: "Retained review" };
    const intent = await client.submit({
      scope,
      actor,
      action,
      draftKey: "review-draft",
      operationId: id(9),
    });
    await client.recover(scope);
    assert.equal(calls, 1);
    await client.close();
    client = createGithubOutbox({ journal, transport: wire });
    await client.recover(scope);
    clock += 1_000;
    await client.recover(scope);
    assert.equal(calls, 1);
    await client.retryAdmission(scope, intent.operationId);
    const entry = (await journal.entries(scope))[0];
    assert.deepEqual(entry.command.action, action);
    assert.equal(entry.draftKey, "review-draft");
    assert.equal(entry.backendOwned, true);
    assert.equal(calls, 2);
    await client.close();
  });

  test(`${kind}: projection retains pending/confirmed review separate from inline comments`, () => {
    const cmd = {
      ...command(),
      action: { kind, expectedHeadSha: "a".repeat(40), body: "Review text" },
    };
    const projection = createGithubOutboxProjection();
    const queued = operation(cmd);
    let projected = projection.project(browserState(queued));
    assert.equal(projected.reviews.length, 1);
    assert.equal(projected.reviews[0].pending, true);
    assert.equal(projected.comments.length, 0);
    const confirmed: GithubRemoteResult = {
      kind: "review",
      id: 70,
      url: scope.url,
      state: kind === "request-changes" ? "CHANGES_REQUESTED" : "COMMENTED",
      commitSha: "a".repeat(40),
      body: "Review text",
      author: actor,
      submittedAt: "2026-01-01T00:00:00Z",
    };
    const synced = { ...operation(cmd, "synced", 2), result: confirmed };
    const state = browserState(synced);
    const token = projection.beginRead(state);
    projection.acceptRemote(token, empty());
    projected = projection.project(state);
    assert.equal(projected.reviews[0].pending, false);
    assert.deepEqual(projected.reviews[0].confirmed, confirmed);
    const newer = projection.beginRead(state);
    projection.acceptRemote(newer, { ...empty(), reviews: [confirmed] });
    projected = projection.project(state);
    assert.equal(projected.reviews.length, 1);
    assert.equal(projected.reviews[0].key, `local:review:${cmd.operationId}`);
    assert.equal(projected.reviews[0].operationIds.length, 0);
  });
}

test("browser saving publishes before journal acknowledgement without fabricating durable operations", async () => {
  const journal = memoryJournal();
  const admit = journal.admit;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  journal.admit = async (...args) => {
    await gate;
    return admit(...args);
  };
  const client = createGithubOutbox({ journal, transport: transport() });
  let notifications = 0;
  client.subscribe(() => notifications++);
  const savingEditor = client.beginSaving(scope);
  const submit = client.submit({ scope, actor, action: command().action });
  assert.equal(client.getState(scope).pendingSaving, 2);
  assert.equal(client.getState(scope).busy, true);
  assert.deepEqual(client.getState(scope).operations, []);
  assert.equal(client.getState(scope).pendingCount, 0);
  assert.ok(notifications >= 2);
  assert.equal(
    client.getState({ ...scope, number: 2, url: scope.url.replace(/\/1$/, "/2") }).pendingSaving,
    0,
  );
  release();
  await submit;
  assert.equal(client.getState(scope).pendingSaving, 1);
  savingEditor();
  savingEditor();
  assert.equal(client.getState(scope).pendingSaving, 0);
  assert.equal(client.getState(scope).operations.length, 1);
  await client.close();
});

test("lost admission receipt retries exactly the persisted command and ID after restart", async () => {
  const journal = memoryJournal();
  const seen: GithubOutboxCommand[] = [];
  let fail = true;
  const adapter = transport({
    async enqueue(cmd) {
      seen.push(cmd);
      if (fail) throw new Error("lost ack");
      return { outcome: "duplicate", operation: operation(cmd) };
    },
  });
  const first = createGithubOutbox({ journal, transport: adapter });
  await first.submit({ scope, actor, action: command().action, operationId: id(1) });
  await first.recover(scope);
  assert.equal((await journal.entries(scope))[0].backendOwned, false);
  await first.close();
  fail = false;
  const next = createGithubOutbox({ journal, transport: adapter });
  await next.recover(scope);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((cmd) => JSON.stringify(cmd) === JSON.stringify(seen[0])));
  assert.equal(seen[0].operationId, command().operationId);
  assert.ok(seen[0].queueDeadlineAt);
  assert.equal((await journal.entries(scope))[0].backendOwned, true);
  assert.equal(next.getState(scope).operations.length, 1);
  await next.close();
});

test("a read failure after durable admission still resolves submission instead of inviting duplicate intent", async () => {
  const journal = memoryJournal();
  const read = journal.entries;
  journal.entries = async () => {
    throw new Error("read unavailable");
  };
  const client = createGithubOutbox({ journal, transport: transport() });
  const saved = await client.submit({ scope, actor, action: command().action, operationId: id(1) });
  assert.equal(saved.operationId, id(1));
  assert.equal((await journal.list()).length, 1);
  assert.equal(client.getState(scope).operations[0].status, "local-pending");
  journal.entries = read;
  await client.recover(scope);
  assert.equal(client.getState(scope).operations.length, 1);
  await client.close();
});

test("scope and actor captured before await; other PR is never recovered implicitly", async () => {
  const journal = memoryJournal();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = journal.admit;
  journal.admit = async (...args) => {
    await gate;
    await original.apply(journal, args);
  };
  const seen: GithubOutboxCommand[] = [];
  const client = createGithubOutbox({
    journal,
    transport: transport({
      async enqueue(cmd) {
        seen.push(cmd);
        return { outcome: "accepted", operation: operation(cmd) };
      },
    }),
  });
  const input = {
    scope: { ...scope },
    actor: { ...actor },
    action: { kind: "issue-comment" as const, body: "before" },
    operationId: id(1),
  };
  const submission = client.submit(input);
  input.scope.number = 2;
  input.scope.url = "https://github.com/owner/repo/pull/2";
  input.actor.id = 99;
  input.action.body = "after";
  release();
  await submission;
  await client.recover(scope);
  assert.equal(seen[0].scope.number, 1);
  assert.equal(seen[0].expectedActor.id, 12);
  assert.equal("body" in seen[0].action && seen[0].action.body, "before");
  assert.deepEqual(await journal.entries(input.scope), []);
  await client.close();
});

test("local dependency refs inferred and malformed commands rejected", async () => {
  const journal = memoryJournal();
  const client = createGithubOutbox({ journal, transport: transport() });
  const submitted = await client.submit({
    scope,
    actor,
    operationId: id(2),
    action: {
      kind: "reply",
      body: "reply",
      target: { source: "local", kind: "review-comment", operationId: id(1) },
    },
  });
  assert.deepEqual(submitted.command.dependencies, [id(1)]);
  await assert.rejects(
    client.submit({ scope, actor, action: { kind: "issue-comment", body: "" } }),
    /Invalid GitHub write/,
  );
  await client.close();
});

test("only active visible PR recovers; navigation releases the previous tab lease", async () => {
  const journal = memoryJournal();
  const secondScope = { ...scope, number: 2, url: "https://github.com/owner/repo/pull/2" };
  await journal.admit(command());
  await journal.admit({ ...command(2), scope: secondScope });
  const leases: { scope: GithubPrScope; visible: boolean }[] = [];
  const admitted: number[] = [];
  const client = createGithubOutbox({
    journal,
    pollMs: 100_000,
    transport: transport({
      async heartbeat(value) {
        leases.push(value);
      },
      async enqueue(value) {
        admitted.push(value.scope.number);
        return { outcome: "accepted", operation: operation(value) };
      },
    }),
  });
  client.activate(scope, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(admitted, []);
  client.setVisible(true);
  await client.recover(scope);
  assert.deepEqual(admitted, [1]);
  client.activate(secondScope, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(admitted, [1]);
  assert.ok(leases.some((lease) => lease.scope.number === 1 && !lease.visible));
  await client.close();
  assert.equal(leases.at(-1)?.scope.number, 2);
  assert.equal(leases.at(-1)?.visible, false);
});

test("stale remote data cannot remove pending creations, edits, deletes, approvals or thread state", () => {
  const projection = createGithubOutboxProjection();
  const create = operation(command(1));
  const edit = operation({
    ...command(2),
    action: {
      kind: "edit-comment",
      target: { source: "remote", kind: "issue-comment", id: 55 },
      expectedBody: "old",
      body: "new",
    },
  });
  const remove = operation({
    ...command(3),
    action: {
      kind: "delete-comment",
      target: { source: "remote", kind: "issue-comment", id: 66 },
      expectedBody: "delete",
    },
  });
  const approve = operation({
    ...command(4),
    action: { kind: "approve", body: "", expectedHeadSha: "a".repeat(40) },
  });
  const resolve = operation({
    ...command(5),
    action: { kind: "resolve-thread", target: { source: "remote", kind: "thread", nodeId: "T1" } },
  });
  const state = browserState(create, edit, remove, approve, resolve);
  const stale = empty();
  stale.comments = [
    { ref: { source: "remote", kind: "issue-comment", id: 55 }, body: "old" },
    { ref: { source: "remote", kind: "issue-comment", id: 66 }, body: "delete" },
  ];
  projection.acceptRemote(projection.beginRead(state), stale);
  const view = projection.project(state);
  assert.equal(view.comments.find((item) => item.ref.source === "local")?.body, "hello");
  assert.equal(
    view.comments.find((item) => item.ref.source === "remote" && item.ref.id === 55)?.body,
    "new",
  );
  assert.equal(
    view.comments.find((item) => item.ref.source === "remote" && item.ref.id === 66)?.deleted,
    true,
  );
  assert.equal(view.approvals[0].id, undefined);
  assert.equal(view.threads[0].resolved, true);
});

test("observing a confirmed inverse thread transition also retires its superseded predecessor", () => {
  const projection = createGithubOutboxProjection();
  const target = { source: "remote", kind: "thread", nodeId: "T1" } as const;
  const resolve = operation(
    { ...command(1), action: { kind: "resolve-thread", target } },
    "synced",
  );
  resolve.result = { kind: "thread", nodeId: "T1", resolved: true };
  const unresolve = operation(
    { ...command(2), action: { kind: "unresolve-thread", target }, dependencies: [id(1)] },
    "synced",
  );
  unresolve.result = { kind: "thread", nodeId: "T1", resolved: false };
  const state = browserState(resolve, unresolve);
  projection.acceptRemote(projection.beginRead(state), {
    ...empty(),
    threads: [{ ref: target, resolved: false }],
  });
  assert.equal(projection.project(state).threads[0].resolved, false);
});

test("observing deletion cannot resurrect an earlier confirmed creation overlay", () => {
  const projection = createGithubOutboxProjection();
  const create = operation(command(1), "synced");
  const remove = operation(
    {
      ...command(2),
      action: {
        kind: "delete-comment",
        target: { source: "local", kind: "issue-comment", operationId: id(1) },
        expectedBody: "hello",
      },
      dependencies: [id(1)],
    },
    "synced",
  );
  remove.result = { kind: "deleted", target: { source: "remote", kind: "issue-comment", id: 44 } };
  const state = browserState(create, remove);
  projection.acceptRemote(projection.beginRead(state), empty());
  assert.equal(projection.project(state).comments.length, 0);
});

test("confirmed overlay retires only after a causally newer read observes effect; later remote edits win", () => {
  const projection = createGithubOutboxProjection();
  const pending = browserState(operation());
  const staleToken = projection.beginRead(pending);
  const synced = browserState(operation(command(), "synced", 2));
  projection.acceptRemote(staleToken, empty());
  assert.equal(projection.project(synced).comments[0].body, "hello");
  const fresh = empty();
  fresh.comments = [{ ref: { source: "remote", kind: "issue-comment", id: 44 }, body: "hello" }];
  projection.acceptRemote(projection.beginRead(synced), fresh);
  const observed = projection.project(synced).comments[0];
  assert.equal(observed.ref.source, "remote");
  assert.equal(observed.key, `local:issue-comment:${id(1)}`);
  fresh.comments[0].body = "external edit";
  projection.acceptRemote(projection.beginRead(synced), fresh);
  assert.equal(projection.project(synced).comments[0].body, "external edit");
  assert.equal(projection.acceptRemote(staleToken, empty()), false);
});

test("confirmed edits remain over stale values and tombstones need a post-confirmation absence", () => {
  const projection = createGithubOutboxProjection();
  const edit = operation(
    {
      ...command(2),
      action: {
        kind: "edit-comment",
        target: { source: "remote", kind: "issue-comment", id: 44 },
        expectedBody: "old",
        body: "new",
      },
    },
    "synced",
    2,
  );
  edit.result = result("new");
  const state = browserState(edit);
  const read = empty();
  read.comments = [{ ref: { source: "remote", kind: "issue-comment", id: 44 }, body: "old" }];
  projection.acceptRemote(projection.beginRead(state), read);
  assert.equal(projection.project(state).comments[0].body, "new");
  read.comments[0].body = "new";
  projection.acceptRemote(projection.beginRead(state), read);
  projection.project(state);
  read.comments[0].body = "later";
  projection.acceptRemote(projection.beginRead(state), read);
  assert.equal(projection.project(state).comments[0].body, "later");
});

test("dependent local edits project in dependency order without fabricated numeric IDs", () => {
  const creation = operation(command());
  const edit = operation({
    ...command(2),
    dependencies: [id(1)],
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "issue-comment", operationId: id(1) },
      expectedBody: "hello",
      body: "edited",
    },
  });
  const projection = createGithubOutboxProjection();
  const view = projection.project(browserState(edit, creation));
  assert.equal(view.comments.length, 1);
  assert.equal(view.comments[0].body, "edited");
  assert.equal(view.comments[0].ref.source, "local");
  assert.ok(!("id" in view.comments[0].ref));
});

test("reload projection retains full review metadata and uses actual discovered thread identity", () => {
  const projection = createGithubOutboxProjection();
  const inline = operation(
    {
      ...command(),
      action: {
        kind: "inline-comment",
        body: "hello",
        expectedHeadSha: "a".repeat(40),
        anchor: { path: "src/a.ts", side: "RIGHT", line: 10 },
      },
    },
    "synced",
    2,
  );
  inline.result = {
    kind: "review-comment",
    id: 77,
    nodeId: "COMMENT_NODE_NOT_THREAD",
    threadId: "ACTUAL_THREAD",
    url: "https://github.com/owner/repo/pull/1#discussion_r77",
    body: "hello",
    author: actor,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    location: {
      path: "src/a.ts",
      side: "RIGHT",
      line: null,
      originalLine: 10,
      commitSha: "a".repeat(40),
    },
  };
  const resolve = operation({
    ...command(2),
    dependencies: [id(1)],
    action: {
      kind: "resolve-thread",
      target: { source: "local", kind: "thread", operationId: id(1) },
    },
  });
  const view = projection.project(browserState(inline, resolve));
  assert.equal(view.comments[0].confirmed?.kind, "review-comment");
  assert.equal(view.comments[0].author?.id, actor.id);
  assert.equal(view.threads.length, 1);
  assert.deepEqual(view.threads[0].ref, {
    source: "remote",
    kind: "thread",
    nodeId: "ACTUAL_THREAD",
  });
  assert.equal(view.threads[0].resolved, true);
  assert.equal(view.threads[0].key, `local:thread:${id(1)}`);
});

test("wire marker stripping only removes explicitly recognized canonical comments", () => {
  const marker = `<!-- test-outbox:${id(1)} -->`;
  assert.equal(
    stripRecognizedGithubMarkers(
      `hello${marker}<!-- test-outbox:wrong -->`,
      (comment) => comment === marker,
    ),
    "hello<!-- test-outbox:wrong -->",
  );
  const canonical = `<!-- better-review:op:${id(1)} -->`;
  assert.equal(cleanGithubOutboxBody(`hello\n\n${canonical}`), "hello");
  assert.equal(cleanGithubOutboxBody(canonical), "");
  assert.equal(
    cleanGithubOutboxBody("hello\n\n<!-- better-review:op:invalid -->"),
    "hello\n\n<!-- better-review:op:invalid -->",
  );
  assert.equal(cleanGithubOutboxBody(`${canonical} user text`), `${canonical} user text`);
});
