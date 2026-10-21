import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { GithubOutboxCommand, GithubOutboxOperation } from "@better-review/shared";

import { createGithubOutboxAdapter } from "./github";
import { createGithubOutbox } from "./outbox";
import type { GithubOutboxAdapter } from "./types";

const actor = { id: 42, login: "fixture" };
const scope = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
} as const;
const command = (body = "retained fixture"): GithubOutboxCommand => ({
  operationId: randomUUID(),
  scope,
  expectedActor: actor,
  action: { kind: "issue-comment", body },
  dependencies: [],
});
const result = (op: GithubOutboxOperation) => ({
  kind: "issue-comment" as const,
  id: 5,
  url: scope.url,
  body: "body" in op.command.action ? op.command.action.body : "",
  author: actor,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
async function wait(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "transition did not complete");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function setup(t: TestContext, patch: Partial<GithubOutboxAdapter> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "github-lifecycle-"));
  let now = Date.now();
  let posts = 0;
  let reads = 0;
  const adapter: GithubOutboxAdapter = {
    async identity() {
      return { outcome: "known", actor };
    },
    async dispatch(op) {
      posts++;
      return { outcome: "accepted", result: result(op) };
    },
    async reconcile() {
      reads++;
      return { outcome: "absent" };
    },
    async verifyApplied() {
      return { outcome: "absent" };
    },
    ...patch,
  };
  const options = {
    databasePath: join(dir, "outbox.sqlite"),
    adapter,
    getCachedActor: () => actor,
    now: () => now,
    pollMs: 5,
    attemptTimeoutMs: 2_000,
    closeTimeoutMs: 20,
  };
  let box = await createGithubOutbox(options);
  t.after(async () => {
    await box.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    get box() {
      return box;
    },
    adapter,
    options,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    get posts() {
      return posts;
    },
    get reads() {
      return reads;
    },
    async reopen() {
      await box.close();
      box = await createGithubOutbox(options);
    },
    async op(id: string) {
      return (await box.snapshot(scope)).operations.find((op) => op.command.operationId === id)!;
    },
  };
}

test("Clear atomically cancels root and FIFO followers; stale snapshots reject and UUID history survives", async (t) => {
  const f = await setup(t);
  const a = command();
  const b = command("follower");
  await f.box.enqueue(a);
  await f.box.enqueue(b);
  const input = {
    kind: "clear" as const,
    requestId: randomUUID(),
    operations: [{ operationId: a.operationId, expectedRevision: 1 }],
  };
  const receipt = await f.box.batchControl(input);
  assert.equal(receipt.outcome, "applied");
  assert.equal((await f.box.batchControl(input)).outcome, "duplicate");
  assert.equal(
    (await f.box.batchControl({ ...input, requestId: randomUUID() })).outcome,
    "rejected",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.posts, 0);
  assert.equal((await f.op(a.operationId)).status, "cancelled");
  assert.equal((await f.op(b.operationId)).status, "cancelled");
  assert.deepEqual((await f.op(a.operationId)).command, a);
  const replay = await f.box.enqueue(a);
  assert.ok(replay.outcome === "duplicate" && replay.operation.status === "cancelled");
});

test("Clear of unacknowledged browser intents creates durable never-send receipts before a late enqueue", async (t) => {
  const f = await setup(t);
  const cmd = command();
  await f.box.batchControl({
    kind: "clear",
    requestId: randomUUID(),
    operations: [],
    commands: [cmd],
  });
  await f.reopen();
  const replay = await f.box.enqueue(cmd);
  assert.ok(replay.outcome === "duplicate" && replay.operation.status === "cancelled");
  assert.deepEqual((await f.op(cmd.operationId)).command, cmd);
  assert.equal(f.posts, 0);
});

test("Clear archives unknown delivery, cancels followers, suppresses reads and retains content dedup safety", async (t) => {
  const f = await setup(t, {
    async dispatch() {
      return {
        outcome: "uncertain",
        error: { code: "network", message: "fixture", retryable: false },
      };
    },
  });
  const a = command();
  await f.box.enqueue(a);
  await wait(async () => (await f.op(a.operationId)).status === "uncertain");
  const b = command("later queued intent");
  await f.box.enqueue(b);
  const op = await f.op(a.operationId);
  await f.box.batchControl({
    kind: "clear",
    requestId: randomUUID(),
    operations: [{ operationId: a.operationId, expectedRevision: op.revision }],
  });
  assert.equal((await f.op(a.operationId)).status, "uncertain");
  assert.ok((await f.op(a.operationId)).archivedAt);
  assert.equal((await f.op(b.operationId)).status, "cancelled");
  assert.deepEqual(await f.box.listPending(), []);
  const reads = f.reads;
  f.advance(600_000);
  await f.reopen();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.reads, reads);
  assert.equal((await f.box.enqueue({ ...a, operationId: randomUUID() })).outcome, "rejected");
  const dependent = { ...command("dependent"), dependencies: [a.operationId] };
  assert.equal((await f.box.enqueue(dependent)).outcome, "rejected");
});

test("Clear fences a real adapter held in preflight so releasing it cannot send a late mutation", async (t) => {
  let release!: () => void;
  let users = 0;
  let held = false;
  let posts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = createGithubOutboxAdapter({
    token: async () => "fixture-only",
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === "/user") {
        users++;
        if (users === 2) {
          held = true;
          await gate;
        }
        return Response.json(actor);
      }
      if (init?.method === "POST") posts++;
      throw new Error("Cleared preflight must not reach a mutation endpoint");
    },
  });
  const f = await setup(t, adapter);
  const cmd = command();
  await f.box.enqueue(cmd);
  await wait(() => held);
  const op = await f.op(cmd.operationId);
  assert.equal(op.status, "inflight");
  await f.box.batchControl({
    kind: "clear",
    requestId: randomUUID(),
    operations: [{ operationId: cmd.operationId, expectedRevision: op.revision }],
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts, 0);
  assert.ok((await f.op(cmd.operationId)).archivedAt);
});

test("queued FIFO follower expires at 300s, not 299s, without an attempt or automatic restart", async (t) => {
  const f = await setup(t, {
    async dispatch() {
      return {
        outcome: "rejected",
        error: { code: "permission", message: "fixture", retryable: false },
      };
    },
  });
  const a = command();
  await f.box.enqueue(a);
  await wait(async () => (await f.op(a.operationId)).status === "retry-failed");
  const b = command("blocked follower");
  await f.box.enqueue(b);
  const deadline = (await f.op(b.operationId)).queueDeadlineAt;
  f.advance(299_000);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await f.op(b.operationId)).status, "queued");
  f.advance(1_000);
  await wait(async () => !!(await f.op(b.operationId)).timedOutAt);
  const expired = await f.op(b.operationId);
  assert.equal(expired.status, "retry-failed");
  assert.equal(expired.error?.code, "timeout");
  assert.equal(expired.attempts, 0);
  await f.reopen();
  assert.equal((await f.op(b.operationId)).queueDeadlineAt, deadline);
  assert.equal(
    (await f.op(a.operationId)).error?.code,
    "permission",
    "expiry must not hide an existing permanent failure",
  );
});

test("identity waiting times out unsent; explicit Retry starts configured cycle on the same UUID", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup(t, {
    async identity() {
      await gate;
      return { outcome: "known", actor };
    },
  });
  const cmd = command();
  await f.box.enqueue(cmd);
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.advance(300_000);
  await wait(async () => !!(await f.op(cmd.operationId)).timedOutAt);
  release();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.posts, 0);
  const expired = await f.op(cmd.operationId);
  const req = {
    kind: "retry" as const,
    requestId: randomUUID(),
    operations: [{ operationId: cmd.operationId, expectedRevision: expired.revision }],
    queueTimeoutMs: 15 * 60_000,
  };
  await f.box.batchControl(req);
  await wait(async () => (await f.op(cmd.operationId)).status === "synced");
  assert.equal(f.posts, 1);
  assert.equal((await f.op(cmd.operationId)).attempts, 1);
  assert.equal(Date.parse((await f.op(cmd.operationId)).queueDeadlineAt!), f.now + 15 * 60_000);
  assert.equal((await f.box.batchControl(req)).outcome, "duplicate");
});

test("inflight deadline stays unknown, ignores late success, stops reads and refuses blind batch Retry", async (t) => {
  let complete!: () => void;
  let started = false;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const f = await setup(t, {
    async dispatch(op) {
      started = true;
      await gate;
      return { outcome: "accepted", result: result(op) };
    },
  });
  const cmd = command();
  await f.box.enqueue(cmd);
  await wait(() => started);
  f.advance(300_000);
  await wait(async () => !!(await f.op(cmd.operationId)).timedOutAt);
  complete();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const op = await f.op(cmd.operationId);
  assert.equal(op.status, "uncertain");
  assert.equal(op.attempts, 1);
  assert.equal(op.error?.code, "timeout");
  assert.equal(op.nextAttemptAt, undefined);
  assert.equal(f.reads, 0);
  const retry = await f.box.batchControl({
    kind: "retry",
    requestId: randomUUID(),
    operations: [{ operationId: cmd.operationId, expectedRevision: op.revision }],
  });
  assert.ok(retry.outcome === "applied" && retry.requiresConfirmation.includes(cmd.operationId));
  assert.equal((await f.op(cmd.operationId)).attempts, 1);
  await f.box.control({
    kind: "resolve-uncertainty",
    requestId: randomUUID(),
    operationId: cmd.operationId,
    expectedRevision: op.revision,
    resolution: { kind: "confirm-not-applied" },
  });
  let retries = 0;
  f.adapter.dispatch = async (current) => {
    retries++;
    return { outcome: "accepted", result: result(current) };
  };
  const manual = await f.op(cmd.operationId);
  assert.equal(manual.retryMode, "manual");
  const request = {
    kind: "retry" as const,
    requestId: randomUUID(),
    operationId: cmd.operationId,
    expectedRevision: manual.revision,
    queueTimeoutMs: 15 * 60_000,
  };
  await f.box.control(request);
  await wait(async () => (await f.op(cmd.operationId)).status === "synced");
  await f.box.control(request);
  assert.equal(retries, 1);
  assert.equal((await f.op(cmd.operationId)).attempts, 2);
});

test("legacy invalid edit Retry uses real HTTP adapter once, original target/body, without alias suppression", async (t) => {
  let now = Date.now();
  let patches = 0;
  const base = {
    id: 17,
    user: actor,
    html_url: scope.url,
    pull_request_url: "https://api.github.com/repos/OWNER/REPO/pulls/1",
    body: "old text",
    path: "a.ts",
    side: "RIGHT",
    line: 1,
    original_line: 1,
    commit_id: "a".repeat(40),
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  const adapter = createGithubOutboxAdapter({
    token: async () => "fixture-only",
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === "/user") return Response.json(actor);
      assert.equal(new URL(String(input)).pathname, "/repos/owner/repo/pulls/comments/17");
      if (init?.method === "PATCH") {
        patches++;
        assert.equal(JSON.parse(String(init.body)).body, "new text");
        return Response.json({ ...base, body: "new text" });
      }
      assert.equal(init?.method, "GET");
      return Response.json(base);
    },
  });
  const f = await setup(t, {
    async identity() {
      return { outcome: "known", actor };
    },
    dispatch: adapter.dispatch,
  });
  // Seed a durable legacy rejection through a proven-unsent adapter result.
  const send = f.adapter.dispatch;
  f.adapter.dispatch = async () => ({
    outcome: "rejected",
    error: { code: "invalid", message: "legacy fixture", retryable: false },
  });
  const cmd: GithubOutboxCommand = {
    ...command(),
    action: {
      kind: "edit-comment",
      target: { source: "remote", kind: "review-comment", id: 17 },
      expectedBody: "old text",
      body: "new text",
    },
  };
  await f.box.enqueue(cmd);
  await wait(async () => (await f.op(cmd.operationId)).status === "retry-failed");
  f.adapter.dispatch = send;
  const op = await f.op(cmd.operationId);
  await f.box.control({
    kind: "retry",
    requestId: randomUUID(),
    operationId: cmd.operationId,
    expectedRevision: op.revision,
  });
  await wait(async () => (await f.op(cmd.operationId)).status === "synced");
  assert.equal(patches, 1);
  assert.equal((await f.op(cmd.operationId)).attempts, 2);
});

test("explicit local retry cycle is durable/idempotent without changing the original UUID fingerprint", async (t) => {
  let sends = 0;
  const f = await setup(t, {
    async dispatch(op) {
      sends++;
      return sends === 1
        ? {
            outcome: "rejected",
            error: { code: "permission", message: "fixture", retryable: false },
          }
        : { outcome: "accepted", result: result(op) };
    },
  });
  const cmd = { ...command(), queueDeadlineAt: new Date(f.now - 1).toISOString() };
  await f.box.enqueue(cmd);
  assert.equal((await f.op(cmd.operationId)).error?.code, "timeout");
  const cycle = {
    requestId: randomUUID(),
    queueTimeoutMs: 15 * 60_000,
    queueDeadlineAt: new Date(f.now + 15 * 60_000).toISOString(),
  };
  await f.box.enqueue(cmd, cycle);
  await wait(async () => (await f.op(cmd.operationId)).error?.code === "permission");
  await f.reopen();
  await f.box.enqueue(cmd, cycle);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sends, 1, "lost cycle acknowledgement must never authorize another attempt");
  assert.equal(
    (await f.box.enqueue(cmd, { ...cycle, queueTimeoutMs: 30 * 60_000 })).outcome,
    "rejected",
  );
  await f.box.enqueue(cmd, { ...cycle, requestId: randomUUID() });
  await wait(async () => (await f.op(cmd.operationId)).status === "synced");
  assert.equal(sends, 2);
  assert.deepEqual((await f.op(cmd.operationId)).command, cmd);
});

test("late admission uses the frozen end-to-end retry deadline, not a fresh server duration", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup(t, {
    async identity() {
      await gate;
      return { outcome: "known", actor };
    },
  });
  const deadline = new Date(f.now + 15 * 60_000).toISOString();
  const cycle = { requestId: randomUUID(), queueTimeoutMs: 15 * 60_000, queueDeadlineAt: deadline };
  f.advance(14 * 60_000);
  const cmd = command();
  await f.box.enqueue(cmd, cycle);
  assert.equal((await f.op(cmd.operationId)).queueDeadlineAt, deadline);
  f.advance(60_000);
  await wait(async () => !!(await f.op(cmd.operationId)).timedOutAt);
  release();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.posts, 0);
});

test("scheduling policy is excluded from content dedup but immutable for UUID replay, with duration clamping", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup(t, {
    async identity() {
      await gate;
      return { outcome: "known", actor };
    },
  });
  const first = {
    ...command(),
    queueTimeoutMs: 300_000,
    queueDeadlineAt: new Date(f.now + 3_600_000).toISOString(),
  };
  await f.box.enqueue(first);
  assert.equal(
    Date.parse((await f.op(first.operationId)).queueDeadlineAt!),
    f.now + 300_000,
    "clock skew must not extend a five-minute policy",
  );
  const second = { ...first, operationId: randomUUID(), queueTimeoutMs: 3_600_000 };
  const duplicate = await f.box.enqueue(second);
  assert.ok(
    duplicate.outcome === "duplicate" &&
      duplicate.operation.command.operationId === first.operationId,
  );
  assert.equal(Date.parse(duplicate.operation.queueDeadlineAt!), f.now + 300_000);
  assert.equal((await f.box.enqueue({ ...first, queueTimeoutMs: 900_000 })).outcome, "rejected");
  release();
  await wait(async () => (await f.op(first.operationId)).status === "synced");
  assert.equal(f.posts, 1);
});

test("replaying an expired Retry batch returns current timeout without reactivating its old deadline", async (t) => {
  const f = await setup(t);
  const cmd = { ...command(), queueDeadlineAt: new Date(f.now - 1).toISOString() };
  await f.box.enqueue(cmd);
  const initial = await f.op(cmd.operationId);
  const request = {
    kind: "retry" as const,
    requestId: randomUUID(),
    operations: [{ operationId: cmd.operationId, expectedRevision: initial.revision }],
    queueTimeoutMs: 60_000,
    queueDeadlineAt: new Date(f.now + 60_000).toISOString(),
  };
  await f.box.batchControl(request);
  f.advance(60_000);
  const replay = await f.box.batchControl(request);
  assert.ok(replay.outcome === "duplicate");
  assert.equal(replay.operations[0].status, "retry-failed");
  assert.equal(replay.operations[0].error?.code, "timeout");
  assert.equal(replay.operations[0].queueDeadlineAt, request.queueDeadlineAt);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.posts, 0);
});

test("verified delivery after timeout retires its active timeout marker; clearing an unsent timeout does likewise", async (t) => {
  const f = await setup(t, {
    async dispatch() {
      return {
        outcome: "uncertain",
        error: { code: "network", message: "fixture", retryable: false },
      };
    },
    async verifyApplied(op) {
      return { outcome: "matched", result: result(op) };
    },
  });
  const cmd = command();
  await f.box.enqueue(cmd);
  await wait(async () => (await f.op(cmd.operationId)).status === "uncertain");
  f.advance(300_000);
  await wait(async () => !!(await f.op(cmd.operationId)).timedOutAt);
  const expired = await f.op(cmd.operationId);
  const receipt = await f.box.control({
    kind: "resolve-uncertainty",
    requestId: randomUUID(),
    operationId: cmd.operationId,
    expectedRevision: expired.revision,
    resolution: { kind: "confirm-applied", result: result(expired) },
  });
  assert.equal(receipt.outcome, "applied");
  assert.equal((await f.op(cmd.operationId)).status, "synced");
  assert.equal((await f.op(cmd.operationId)).timedOutAt, undefined);
  const unsent = { ...command("never sent"), queueDeadlineAt: new Date(f.now - 1).toISOString() };
  await f.box.enqueue(unsent);
  const pending = await f.op(unsent.operationId);
  await f.box.batchControl({
    kind: "clear",
    requestId: randomUUID(),
    operations: [{ operationId: unsent.operationId, expectedRevision: pending.revision }],
  });
  assert.equal((await f.op(unsent.operationId)).status, "cancelled");
  assert.equal((await f.op(unsent.operationId)).timedOutAt, undefined);
  assert.equal((await f.op(unsent.operationId)).error, undefined);
});
