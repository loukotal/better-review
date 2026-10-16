import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type {
  GithubActor,
  GithubOutboxCommand,
  GithubOutboxOperation,
  GithubPrScope,
  GithubRemoteResult,
  GithubWriteAction,
} from "@better-review/shared";

import { OutboxDatabase } from "./database.js";
import { createGithubOutboxAdapter } from "./github.js";
import { createGithubOutbox, type GithubOutboxOptions } from "./outbox.js";
import type {
  GithubDispatchOutcome,
  GithubOutboxAdapter,
  GithubReconcileOutcome,
} from "./types.js";

const actor: GithubActor = { id: 42, login: "reviewer" };
const scope: GithubPrScope = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
};
const otherScope: GithubPrScope = {
  ...scope,
  number: 2,
  url: "https://github.com/owner/repo/pull/2",
};
function command(patch: Partial<GithubOutboxCommand> = {}): GithubOutboxCommand {
  return {
    operationId: randomUUID(),
    scope,
    expectedActor: actor,
    action: { kind: "issue-comment", body: "hello" },
    dependencies: [],
    ...patch,
  };
}
function result(op: GithubOutboxOperation, id = 123): GithubRemoteResult {
  return {
    kind: "issue-comment",
    id,
    url: `${op.command.scope.url}#issuecomment-${id}`,
    body: "body" in op.command.action ? op.command.action.body : "",
    author: actor,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
class Adapter implements GithubOutboxAdapter {
  posts: GithubOutboxOperation[] = [];
  reads: GithubOutboxOperation[] = [];
  verifications: GithubRemoteResult[] = [];
  identities = 0;
  liveActor = actor;
  available = true;
  send: (op: GithubOutboxOperation) => Promise<GithubDispatchOutcome> = async (op) => ({
    outcome: "accepted",
    result: result(op),
  });
  check: (op: GithubOutboxOperation) => Promise<GithubReconcileOutcome> = async () => ({
    outcome: "absent",
  });
  async identity(): ReturnType<GithubOutboxAdapter["identity"]> {
    this.identities++;
    return this.available
      ? { outcome: "known" as const, actor: this.liveActor }
      : {
          outcome: "unavailable" as const,
          error: { code: "auth" as const, message: "secret must not persist", retryable: false },
        };
  }
  async dispatch(op: GithubOutboxOperation) {
    this.posts.push(structuredClone(op));
    return this.send(op);
  }
  async reconcile(op: GithubOutboxOperation) {
    this.reads.push(structuredClone(op));
    return this.check(op);
  }
  async verifyApplied(op: GithubOutboxOperation, candidate: GithubRemoteResult) {
    this.verifications.push(structuredClone(candidate));
    this.reads.push(structuredClone(op));
    return this.check(op);
  }
}

test("database migration is atomic and SQLite durability settings are enabled", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "github-outbox-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.sqlite");
  const broken = new DatabaseSync(path);
  broken.exec("CREATE TABLE operations (id TEXT)");
  broken.close();
  await assert.rejects(OutboxDatabase.open(path), /already exists/);
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 0);
  assert.equal(
    inspect.prepare("SELECT name FROM sqlite_master WHERE name='scopes'").get(),
    undefined,
  );
  inspect.exec("DROP TABLE operations");
  inspect.close();
  const store = await OutboxDatabase.open(path);
  try {
    assert.equal(store.db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(store.db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
    assert.equal(store.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(store.db.prepare("PRAGMA busy_timeout").get()?.timeout, 5_000);
  } finally {
    await store.close();
  }
});

test("pre-owner v1/v2 migrations preserve durable operations, dependencies and history byte-for-byte", async (t) => {
  for (const version of [1, 2])
    await t.test(`version ${version}`, async (t) => {
      const f = await fixture(t);
      const a = command();
      const b = command({ dependencies: [a.operationId] });
      await f.box.enqueue(a);
      await f.box.enqueue(b);
      await f.box.control({
        requestId: randomUUID(),
        operationId: a.operationId,
        expectedRevision: 1,
        kind: "revise",
        body: "preserved queued content",
      });
      await f.box.close();
      const db = new DatabaseSync(f.options.databasePath);
      const row = db.prepare("SELECT data FROM operations WHERE id=?").get(b.operationId)!;
      const uncertain: GithubOutboxOperation = JSON.parse(row.data as string);
      uncertain.status = "uncertain";
      uncertain.attempts = 7;
      uncertain.revision = 11;
      uncertain.error = { code: "network", message: "delivery unknown", retryable: false };
      db.prepare("UPDATE operations SET data=? WHERE id=?").run(
        JSON.stringify(uncertain),
        b.operationId,
      );
      db.exec("UPDATE operations SET data=json_remove(data,'$.retryMode')");
      db.prepare("INSERT INTO audit(operation_id,at,event) VALUES (?,?,?)").run(
        b.operationId,
        uncertain.updatedAt,
        "preserved event",
      );
      db.exec("DROP TABLE owner");
      if (version === 1) db.exec("DROP TABLE schedules");
      else
        db.prepare(
          "INSERT INTO schedules(operation_id,identity_failures,reconcile_attempts) VALUES (?,4,6)",
        ).run(b.operationId);
      db.exec(`PRAGMA user_version=${version}`);
      const tables = [
        "scopes",
        "operations",
        "dependencies",
        "controls",
        "audit",
        ...(version === 2 ? ["schedules"] : []),
      ];
      const before = tables.map((table) =>
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
      );
      db.close();
      // Migration only: never start a worker or make a network call.
      const migrated = await OutboxDatabase.open(f.options.databasePath);
      try {
        assert.equal(migrated.db.prepare("PRAGMA user_version").get()?.user_version, 3);
        assert.deepEqual(
          tables.map((table) =>
            JSON.stringify(migrated.db.prepare(`SELECT * FROM ${table}`).all()),
          ),
          before,
        );
        assert.ok(migrated.db.prepare("SELECT token FROM owner WHERE singleton=1").get()?.token);
        assert.equal(migrated.get(a.operationId)?.retryMode, "automatic");
        assert.equal(migrated.get(b.operationId)?.retryMode, "blocked");
        assert.equal(f.adapter.posts.length, 0);
      } finally {
        await migrated.close();
      }
    });
});

test("durable owner token fences a resumed former owner before dispatch", async (t) => {
  const f = await fixture(t);
  let identities = 0;
  f.adapter.identity = async () => {
    identities++;
    const db = new DatabaseSync(f.options.databasePath);
    db.prepare("UPDATE owner SET token=? WHERE singleton=1").run(randomUUID());
    db.close();
    return { outcome: "known", actor };
  };
  await f.box.enqueue(command());
  await f.activate();
  await until(() => identities > 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.adapter.posts.length, 0);
  await assert.rejects(f.box.snapshot(scope), /ownership/);
});

test("accepted results must preserve target IDs, approval head SHA and requested thread state", async (t) => {
  const cases: Array<{ action: GithubWriteAction; remote: GithubRemoteResult }> = [
    {
      action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "" },
      remote: { kind: "approval", id: 3, url: scope.url, commitSha: "b".repeat(40) },
    },
    {
      action: {
        kind: "delete-comment",
        target: { source: "remote", kind: "issue-comment", id: 3 },
        expectedBody: "old",
      },
      remote: { kind: "deleted", target: { source: "remote", kind: "issue-comment", id: 4 } },
    },
    {
      action: {
        kind: "resolve-thread",
        target: { source: "remote", kind: "thread", nodeId: "THREAD" },
      },
      remote: { kind: "thread", nodeId: "WRONG", resolved: true },
    },
    {
      action: {
        kind: "unresolve-thread",
        target: { source: "remote", kind: "thread", nodeId: "THREAD" },
      },
      remote: { kind: "thread", nodeId: "THREAD", resolved: true },
    },
  ];
  for (const { action, remote } of cases)
    await t.test(action.kind, async (t) => {
      const f = await fixture(t);
      await f.activate();
      f.adapter.send = async () => ({ outcome: "accepted", result: remote });
      const a = command({ action });
      await f.box.enqueue(a);
      await until(async () => (await operation(f, a.operationId)).status === "uncertain");
      assert.equal((await operation(f, a.operationId)).result, undefined);
    });
});

test("automatic retries stop at eight durable attempts and remain bounded", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "rejected",
    error: { code: "network", message: "before dispatch", retryable: true },
  });
  const a = command();
  await f.box.enqueue(a);
  for (let attempt = 1; attempt <= 8; attempt++) {
    await until(async () => {
      const op = await operation(f, a.operationId);
      return op.attempts === attempt && op.status === "retry-failed";
    });
    const op = await operation(f, a.operationId);
    if (attempt < 8) {
      assert.ok(op.nextAttemptAt);
      assert.equal(op.retryMode, "automatic");
      assert.ok(Date.parse(op.nextAttemptAt) - Date.parse(op.updatedAt) <= 300_000);
      f.advance(300_001);
      await f.activate();
    } else {
      assert.equal(op.retryMode, "blocked");
      assert.equal(op.nextAttemptAt, undefined);
    }
  }
  f.advance(1_000_000);
  await f.activate();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.adapter.posts.length, 8);
});
async function fixture(t: TestContext, patch: Partial<GithubOutboxOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "github-outbox-test-"));
  const adapter = new Adapter();
  let time = Date.now();
  const options: GithubOutboxOptions = {
    databasePath: join(dir, "outbox.sqlite"),
    adapter,
    getCachedActor: () => actor,
    now: () => time,
    pollMs: 5,
    closeTimeoutMs: 20,
    attemptTimeoutMs: 200,
    ...patch,
  };
  let box = await createGithubOutbox(options);
  t.after(async () => {
    await box.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    adapter,
    options,
    get box() {
      return box;
    },
    advance(ms: number) {
      time += ms;
    },
    async reopen() {
      await box.close();
      box = await createGithubOutbox(options);
    },
    async activate(pr = scope, clientId = randomUUID()) {
      await box.heartbeat({ clientId, scope: pr, visible: true });
      return clientId;
    },
  };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "timed out waiting for outbox transition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function operation(f: Awaited<ReturnType<typeof fixture>>, id: string, pr = scope) {
  const op = (await f.box.snapshot(pr)).operations.find((op) => op.command.operationId === id);
  assert.ok(op);
  return op;
}

test("shutdown aborts held identity and adapter preflight before a successor acquires ownership", async (t) => {
  for (const stage of ["worker-identity", "adapter-preflight"] as const)
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      let signal: AbortSignal | undefined;
      let release!: () => void;
      let writes = 0;
      if (stage === "worker-identity") {
        f.options.adapter = {
          identity: async (options) => {
            signal = options?.signal;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return { outcome: "known", actor };
          },
          dispatch: async (op) => {
            writes++;
            return { outcome: "accepted", result: result(op) };
          },
          reconcile: async () => ({ outcome: "absent" }),
          verifyApplied: async () => ({ outcome: "absent" }),
        };
        await f.reopen();
      } else {
        f.options.adapter = {
          identity: async () => ({ outcome: "known", actor }),
          dispatch: async (op, options) => {
            signal = options?.signal;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            if (signal?.aborted)
              return {
                outcome: "rejected",
                error: { code: "network", message: "aborted before send", retryable: true },
              };
            writes++;
            return { outcome: "accepted", result: result(op) };
          },
          reconcile: async () => ({ outcome: "absent" }),
          verifyApplied: async () => ({ outcome: "absent" }),
        };
        await f.reopen();
      }
      const a = command();
      await f.box.enqueue(a);
      await f.activate();
      await until(() => !!release);
      assert.ok(signal);
      assert.equal(signal.aborted, false);
      await f.reopen();
      assert.equal(signal.aborted, true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(writes, 0);
      assert.equal(
        (await operation(f, a.operationId)).status,
        stage === "worker-identity" ? "queued" : "uncertain",
      );
    });
});

test("actual adapter cannot post after former-worker held credential preflight is released", async (t) => {
  let tokenReads = 0;
  let writes = 0;
  let release!: () => void;
  const adapter = createGithubOutboxAdapter({
    token: async () => {
      tokenReads++;
      if (tokenReads === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return "fake-test-token";
    },
    fetch: async (_input, init) => {
      if (init?.method === "POST") writes++;
      return new Response(JSON.stringify(actor), { status: 200 });
    },
  });
  const f = await fixture(t, { adapter });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(() => !!release);
  await f.reopen();
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 0);
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
});

test("worker deadline aborts actual-adapter preflight and forbids a late POST", async (t) => {
  let tokenReads = 0;
  let writes = 0;
  let release!: () => void;
  const adapter = createGithubOutboxAdapter({
    token: async () => {
      if (++tokenReads === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return "fake-test-token";
    },
    fetch: async (_input, init) => {
      if (init?.method === "POST") writes++;
      return new Response(JSON.stringify(actor), { status: 200 });
    },
  });
  const f = await fixture(t, { adapter, attemptTimeoutMs: 20 });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(() => !!release);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 0);
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
});

test("owner-loss abort propagates into already-entered adapter preflight", async (t) => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  let writes = 0;
  const adapter: GithubOutboxAdapter = {
    identity: async () => ({ outcome: "known", actor }),
    dispatch: async (op, options) => {
      signal = options?.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (signal?.aborted)
        return {
          outcome: "rejected",
          error: { code: "network", message: "aborted before send", retryable: true },
        };
      writes++;
      return { outcome: "accepted", result: result(op) };
    },
    reconcile: async () => ({ outcome: "absent" }),
    verifyApplied: async () => ({ outcome: "absent" }),
  };
  const f = await fixture(t, { adapter });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(() => !!release);
  const db = new DatabaseSync(f.options.databasePath);
  db.prepare("UPDATE owner SET token=? WHERE singleton=1").run(randomUUID());
  db.close();
  await until(() => signal?.aborted === true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes, 0);
});

test("synchronous mutation fence blocks real adapter when /user transfers ownership before its immediate response", async (t) => {
  let databasePath = "";
  let users = 0;
  let posts = 0;
  let guards = 0;
  const adapter = createGithubOutboxAdapter({
    token: async () => "fake-test-token",
    fetch: async (input, init) => {
      if (init?.method === "POST") posts++;
      assert.equal(new URL(String(input)).pathname, "/user");
      if (++users === 2) {
        // No timer/event-loop turn: ownership changes inside dispatch identity.
        const db = new DatabaseSync(databasePath);
        db.prepare("UPDATE owner SET token=? WHERE singleton=1").run(randomUUID());
        db.close();
      }
      return new Response(JSON.stringify(actor), { status: 200 });
    },
  });
  const dispatch = adapter.dispatch;
  adapter.dispatch = (op, options) =>
    dispatch(op, {
      ...options,
      beforeMutation: () => {
        guards++;
        options?.beforeMutation?.();
      },
    });
  const f = await fixture(t, { adapter, pollMs: 60_000 });
  databasePath = f.options.databasePath;
  await f.box.enqueue(command());
  await f.activate();
  await until(() => guards === 1);
  assert.equal(users, 2);
  assert.equal(posts, 0);
  await assert.rejects(f.box.snapshot(scope), /ownership/);
});

test("synchronous mutation fence enforces the deadline even before its timer can run", async (t) => {
  let users = 0;
  let posts = 0;
  let guards = 0;
  const adapter = createGithubOutboxAdapter({
    token: async () => "fake-test-token",
    fetch: async (_input, init) => {
      if (init?.method === "POST") posts++;
      if (++users === 2) {
        const end = performance.now() + 30;
        while (performance.now() < end) {
          /* Deliberately prevent the deadline timer from running. */
        }
      }
      return new Response(JSON.stringify(actor), { status: 200 });
    },
  });
  const dispatch = adapter.dispatch;
  adapter.dispatch = (op, options) =>
    dispatch(op, {
      ...options,
      beforeMutation: () => {
        guards++;
        options?.beforeMutation?.();
      },
    });
  const f = await fixture(t, { adapter, attemptTimeoutMs: 20 });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(() => guards === 1);
  assert.equal(posts, 0);
  await until(async () => (await operation(f, a.operationId)).status !== "inflight");
  assert.notEqual((await operation(f, a.operationId)).status, "synced");
});

test("uncertain reconciliation preserves sanitized rate-limit classification and the remote retry deadline across restart", async (t) => {
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const retryAt = "2026-01-01T01:00:00.000Z";
  const f = await fixture(t, { now: () => time });
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "write timed out", retryable: true },
  });
  f.adapter.check = async () => ({
    outcome: "conflict",
    error: {
      code: "rate-limit",
      message: "Authorization: secret must not persist",
      retryable: true,
      retryAt,
    },
  });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(async () => (await operation(f, a.operationId)).error?.code === "rate-limit");
  let op = await operation(f, a.operationId);
  assert.equal(op.status, "uncertain");
  assert.equal(op.retryMode, "blocked");
  assert.equal(op.error?.retryable, true);
  assert.equal(op.error?.retryAt, retryAt);
  assert.ok(Date.parse(op.nextAttemptAt!) >= Date.parse(retryAt));
  assert.ok(!JSON.stringify(op).includes("Authorization"));
  await f.reopen();
  await f.activate();
  op = await operation(f, a.operationId);
  assert.equal(op.nextAttemptAt, retryAt);
  time = Date.parse(retryAt) - 1;
  await f.activate();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.adapter.reads.length, 1);
  f.adapter.check = async () => ({ outcome: "absent" });
  time = Date.parse(retryAt);
  await f.activate();
  await until(() => f.adapter.reads.length === 2);
  assert.equal(f.adapter.posts.length, 1);
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
});

test("reconciliation keeps safe network/auth error codes without raw diagnostics or malformed retry dates", async (t) => {
  for (const code of ["network", "auth"] as const)
    await t.test(code, async (t) => {
      const f = await fixture(t);
      f.adapter.send = async () => ({
        outcome: "uncertain",
        error: { code: "network", message: "write timeout", retryable: true },
      });
      f.adapter.check = async () => ({
        outcome: "conflict",
        error: {
          code,
          message: "sensitive diagnostic",
          retryable: code === "network",
          retryAt: "malformed sensitive retry date",
        },
      });
      const a = command();
      await f.box.enqueue(a);
      await f.activate();
      await until(async () => {
        const op = await operation(f, a.operationId);
        return (
          op.error?.code === code &&
          op.error.message === "GitHub reconciliation could not confirm this operation."
        );
      });
      const op = await operation(f, a.operationId);
      assert.equal(op.status, "uncertain");
      assert.equal(op.error?.retryAt, undefined);
      assert.equal(op.error?.retryable, code === "network");
      assert.ok(!JSON.stringify(op).includes("sensitive"));
      assert.equal(!!op.nextAttemptAt, code === "network");
      assert.equal(f.adapter.posts.length, 1);
    });
});

test("transient live identity failures preserve classification and persisted automatic backoff", async (t) => {
  for (const code of ["network", "rate-limit"] as const)
    await t.test(code, async (t) => {
      const f = await fixture(t);
      let attempts = 0;
      const retryAt = new Date(f.options.now!() + 5_000).toISOString();
      f.adapter.identity = async () => {
        attempts++;
        return attempts === 1
          ? {
              outcome: "unavailable",
              error: { code, message: "unsafe remote cause", retryable: true, retryAt },
            }
          : { outcome: "known", actor };
      };
      const a = command();
      await f.box.enqueue(a);
      await f.activate();
      await until(async () => (await operation(f, a.operationId)).status === "retry-failed");
      const op = await operation(f, a.operationId);
      assert.equal(op.error?.code, code);
      assert.equal(op.retryMode, "automatic");
      assert.equal(op.nextAttemptAt, retryAt);
      assert.equal(op.attempts, 0);
      await f.reopen();
      await f.activate();
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(attempts, 1);
      f.advance(5_001);
      await f.activate();
      await until(async () => (await operation(f, a.operationId)).status === "synced");
      assert.equal(f.adapter.posts.length, 1);
    });
});

test("active uncertain FIFO head automatically reconciles reads with durable exponential backoff and no writes", async (t) => {
  const f = await fixture(t);
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: true },
  });
  const a = command();
  await f.box.enqueue(a);
  await f.activate();
  await until(
    async () => f.adapter.reads.length === 1 && !!(await operation(f, a.operationId)).nextAttemptAt,
  );
  let op = await operation(f, a.operationId);
  assert.equal(op.status, "uncertain");
  assert.equal(op.retryMode, "blocked");
  assert.equal(Date.parse(op.nextAttemptAt!) - Date.parse(op.updatedAt), 5_000);
  const scheduled = op.nextAttemptAt;
  await f.reopen();
  await f.activate();
  assert.equal((await operation(f, a.operationId)).nextAttemptAt, scheduled);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.adapter.reads.length, 1);
  f.advance(5_001);
  await f.activate();
  await until(
    async () =>
      f.adapter.reads.length === 2 &&
      (await operation(f, a.operationId)).nextAttemptAt !== scheduled,
  );
  op = await operation(f, a.operationId);
  assert.equal(Date.parse(op.nextAttemptAt!) - Date.parse(op.updatedAt), 10_000);
  f.adapter.check = async (current) => ({ outcome: "matched", result: result(current) });
  f.advance(10_001);
  await f.activate();
  await until(async () => (await operation(f, a.operationId)).status === "synced");
  assert.equal(f.adapter.posts.length, 1);
});

test("restart of crashed inflight automatically reads on activation and never reposts", async (t) => {
  const f = await fixture(t);
  const a = command();
  await f.box.enqueue(a);
  await f.box.close();
  const db = new DatabaseSync(f.options.databasePath);
  const row = db.prepare("SELECT data FROM operations WHERE id=?").get(a.operationId)!;
  const op = JSON.parse(row.data as string) as GithubOutboxOperation;
  op.status = "inflight";
  op.attempts = 1;
  db.prepare("UPDATE operations SET data=? WHERE id=?").run(JSON.stringify(op), a.operationId);
  db.close();
  await f.reopen();
  f.adapter.check = async (current) => ({ outcome: "matched", result: result(current) });
  await f.activate();
  await until(async () => (await operation(f, a.operationId)).status === "synced");
  assert.equal(f.adapter.posts.length, 0);
  assert.equal(f.adapter.reads.length, 1);
});

test("global two-job limit includes identity preflight and reconciliation across six active PRs", async (t) => {
  const f = await fixture(t);
  let identityCalls = 0;
  let live = 0;
  let maximum = 0;
  const releaseIdentity: Array<() => void> = [];
  const releaseReads: Array<() => void> = [];
  f.adapter.identity = async () => {
    identityCalls++;
    live++;
    maximum = Math.max(maximum, live);
    await new Promise<void>((resolve) => releaseIdentity.push(resolve));
    live--;
    return { outcome: "known", actor };
  };
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: false },
  });
  f.adapter.check = async () => {
    live++;
    maximum = Math.max(maximum, live);
    await new Promise<void>((resolve) => releaseReads.push(resolve));
    live--;
    return { outcome: "absent" };
  };
  for (let number = 1; number <= 6; number++) {
    const pr = { ...scope, number, url: `https://github.com/owner/repo/pull/${number}` };
    await f.box.enqueue(command({ scope: pr }));
    await f.activate(pr);
  }
  await until(() => identityCalls === 2);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(identityCalls, 2);
  releaseIdentity.splice(0).forEach((resolve) => resolve());
  await until(() => identityCalls === 4); // Both slots moved into read-only reconciliation identity.
  releaseIdentity.splice(0).forEach((resolve) => resolve());
  await until(() => releaseReads.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(identityCalls, 4);
  assert.equal(f.adapter.posts.length, 2);
  assert.equal(maximum, 2);
  releaseReads.splice(0).forEach((resolve) => resolve());
  await until(() => identityCalls === 6);
  assert.equal(maximum, 2);
});

test("local reply-to-reply resolves the verified root while edits preserve the actual reply ID", async (t) => {
  const f = await fixture(t);
  const sha = "a".repeat(40);
  const root = command({
    action: {
      kind: "inline-comment",
      expectedHeadSha: sha,
      anchor: { path: "file.ts", line: 3, side: "RIGHT" },
      body: "root",
    },
  });
  const reply = command({
    dependencies: [root.operationId],
    action: {
      kind: "reply",
      target: { source: "local", kind: "review-comment", operationId: root.operationId },
      body: "first",
    },
  });
  const second = command({
    dependencies: [reply.operationId],
    action: {
      kind: "reply",
      target: { source: "local", kind: "review-comment", operationId: reply.operationId },
      body: "second",
    },
  });
  const edit = command({
    dependencies: [reply.operationId],
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "review-comment", operationId: reply.operationId },
      body: "edited",
      expectedBody: "first",
    },
  });
  f.adapter.send = async (op) => {
    const action = op.command.action;
    const id =
      action.kind === "inline-comment"
        ? 100
        : action.kind === "edit-comment"
          ? 101
          : "body" in action && action.body === "first"
            ? 101
            : 102;
    return {
      outcome: "accepted",
      result: {
        kind: "review-comment",
        id,
        body: "body" in action ? action.body : "",
        url: `${scope.url}#discussion_r${id}`,
        author: actor,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        location: { path: "file.ts", side: "RIGHT", line: 3, originalLine: 3, commitSha: sha },
        ...(id !== 100 ? { inReplyToId: 100 } : {}),
      },
    };
  };
  for (const cmd of [root, reply, second, edit]) await f.box.enqueue(cmd);
  await f.activate();
  await until(async () => (await operation(f, edit.operationId)).status === "synced");
  assert.deepEqual(f.adapter.posts[2]!.command.action, {
    kind: "reply",
    target: { source: "remote", kind: "review-comment", id: 100 },
    body: "second",
  });
  assert.deepEqual(f.adapter.posts[3]!.command.action, {
    kind: "edit-comment",
    target: { source: "remote", kind: "review-comment", id: 101 },
    body: "edited",
    expectedBody: "first",
  });
});

test("remote reply targets accept adapter-verified roots for dispatch and reconciliation; local roots remain strict", async (t) => {
  const f = await fixture(t);
  const review = (op: GithubOutboxOperation, root = 100): GithubRemoteResult => ({
    kind: "review-comment",
    id: 201,
    author: actor,
    body: "body" in op.command.action ? op.command.action.body : "",
    url: `${scope.url}#discussion_r201`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    inReplyToId: root,
    location: {
      path: "file.ts",
      side: "RIGHT",
      line: 3,
      originalLine: 3,
      commitSha: "a".repeat(40),
    },
  });
  f.adapter.send = async (op) => ({ outcome: "accepted", result: review(op) });
  const a = command({
    action: {
      kind: "reply",
      target: { source: "remote", kind: "review-comment", id: 101 },
      body: "remote reply",
    },
  });
  await f.box.enqueue(a);
  await f.activate();
  await until(async () => (await operation(f, a.operationId)).status === "synced");
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: false },
  });
  f.adapter.check = async (op) => ({ outcome: "matched", result: review(op) });
  const b = command({
    action: {
      kind: "reply",
      target: { source: "remote", kind: "review-comment", id: 102 },
      body: "reconciled remote reply",
    },
  });
  await f.box.enqueue(b);
  await until(async () => (await operation(f, b.operationId)).status === "synced");
  f.adapter.send = async (op) => ({ outcome: "accepted", result: review(op, 999) });
  f.adapter.check = async () => ({ outcome: "absent" });
  const c = command({
    dependencies: [a.operationId],
    action: {
      kind: "reply",
      target: { source: "local", kind: "review-comment", operationId: a.operationId },
      body: "local root is known",
    },
  });
  await f.box.enqueue(c);
  await until(async () => (await operation(f, c.operationId)).status === "uncertain");
  assert.equal(f.adapter.posts.length, 3);
  assert.equal((await operation(f, c.operationId)).result, undefined);
});

test("admission is durable, offline, canonical-idempotent and detects changed original payload after revision/restart", async (t) => {
  const f = await fixture(t);
  const cmd = command();
  assert.equal((await f.box.enqueue(cmd)).outcome, "accepted");
  assert.equal(f.adapter.identities, 0);
  assert.equal(f.adapter.posts.length, 0);
  const reordered = {
    dependencies: [],
    action: cmd.action,
    expectedActor: actor,
    scope,
    operationId: cmd.operationId,
  };
  assert.equal((await f.box.enqueue(reordered)).outcome, "duplicate");
  const control = {
    requestId: randomUUID(),
    operationId: cmd.operationId,
    expectedRevision: 1,
    kind: "revise" as const,
    body: "revised",
  };
  assert.equal((await f.box.control(control)).outcome, "applied");
  assert.equal((await f.box.control(control)).outcome, "duplicate");
  assert.equal((await f.box.control({ ...control, body: "different" })).outcome, "rejected");
  await f.reopen();
  assert.equal((await f.box.enqueue(cmd)).outcome, "duplicate");
  assert.equal((await operation(f, cmd.operationId)).command.action.kind, "issue-comment");
  assert.equal(
    (await f.box.enqueue({ ...cmd, action: { kind: "issue-comment", body: "revised" } })).outcome,
    "rejected",
  );
  assert.equal((await f.box.control(control)).outcome, "duplicate");
  assert.equal((await f.box.snapshot(scope)).revision, 2);
});

test("unknown/mismatched admission identity and noncanonical scopes reject without adapter calls", async (t) => {
  const f = await fixture(t, { getCachedActor: () => undefined });
  assert.equal((await f.box.enqueue(command())).outcome, "rejected");
  assert.equal(
    (await f.box.enqueue(command({ scope: { ...scope, owner: "OWNER" } }))).outcome,
    "rejected",
  );
  assert.equal(f.adapter.identities, 0);
  assert.equal((await f.box.snapshot(scope)).operations.length, 0);
  const g = await fixture(t, { getCachedActor: () => ({ id: 99, login: "other" }) });
  assert.equal((await g.box.enqueue(command())).outcome, "rejected");
});

test("exclusive database owner and future schema fail closed without migration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createGithubOutbox(f.options), /lock/i);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { OutboxDatabase } from ${JSON.stringify(new URL("./database.ts", import.meta.url).href)};
    try { const db = await OutboxDatabase.open(${JSON.stringify(f.options.databasePath)}); await db.close(); process.exitCode=1; }
    catch (error) { if (error.code !== 'ELOCKED') throw error; }
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  await f.box.close();
  const db = new DatabaseSync(f.options.databasePath);
  db.exec("PRAGMA user_version=99");
  db.close();
  await assert.rejects(createGithubOutbox(f.options), /future/);
  const check = new DatabaseSync(f.options.databasePath);
  assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 99);
  check.close();
});

test("confirm-applied stores adapter-verified evidence, never browser content; request dedup survives restart", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: false },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  const op = await operation(f, a.operationId);
  const candidate = { ...result(op, 999), body: "untrusted browser content" };
  f.adapter.check = async (current) => ({ outcome: "matched", result: result(current, 555) });
  const control = {
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "resolve-uncertainty" as const,
    resolution: { kind: "confirm-applied" as const, result: candidate },
  };
  assert.equal((await f.box.control(control)).outcome, "applied");
  assert.deepEqual((await operation(f, a.operationId)).result, result(op, 555));
  assert.deepEqual(f.adapter.verifications, [candidate]);
  assert.equal((await f.box.control(control)).outcome, "duplicate");
  await f.reopen();
  assert.equal((await f.box.control(control)).outcome, "duplicate");
  assert.equal(f.adapter.verifications.length, 1);
});

test("async evidence verification loses revision CAS to another control", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: false },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  const op = await operation(f, a.operationId);
  let finish!: () => void;
  f.adapter.check = (current) =>
    new Promise((resolve) => {
      finish = () => resolve({ outcome: "matched", result: result(current) });
    });
  const pending = f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "resolve-uncertainty",
    resolution: { kind: "confirm-applied", result: result(op) },
  });
  await until(() => !!finish);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "resolve-uncertainty",
    resolution: { kind: "confirm-not-applied" },
  });
  finish();
  assert.equal((await pending).outcome, "rejected");
  assert.equal((await operation(f, a.operationId)).status, "retry-failed");
  assert.equal((await operation(f, a.operationId)).retryMode, "manual");
});

test("manual uncertainty override never enables automatic retries after the explicit retry", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: true },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  let op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "resolve-uncertainty",
    resolution: { kind: "confirm-not-applied" },
  });
  op = await operation(f, a.operationId);
  assert.equal(op.retryMode, "manual");
  assert.equal(op.nextAttemptAt, undefined);
  f.adapter.send = async () => ({
    outcome: "rejected",
    error: { code: "network", message: "offline", retryable: true },
  });
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "retry",
  });
  await until(
    async () =>
      (await operation(f, a.operationId)).attempts === 2 &&
      (await operation(f, a.operationId)).status === "retry-failed",
  );
  op = await operation(f, a.operationId);
  assert.equal(op.retryMode, "manual");
  assert.equal(op.nextAttemptAt, undefined);
  await f.reopen();
  f.advance(60_000);
  await f.activate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.posts.length, 2);
  f.adapter.liveActor = { id: 999, login: "different" };
  op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "retry",
  });
  await until(async () => (await operation(f, a.operationId)).error?.code === "identity-mismatch");
  f.adapter.liveActor = actor;
  op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "retry",
  });
  await until(
    async () =>
      (await operation(f, a.operationId)).attempts === 3 &&
      (await operation(f, a.operationId)).status === "retry-failed",
  );
  op = await operation(f, a.operationId);
  assert.equal(op.retryMode, "manual");
  assert.equal(op.nextAttemptAt, undefined);
});

test("inline success does not require thread ID; child discovers actual thread read-only and never uses comment node ID", async (t) => {
  const f = await fixture(t);
  const sha = "a".repeat(40);
  const parent = command({
    action: {
      kind: "inline-comment",
      body: "inline",
      expectedHeadSha: sha,
      anchor: { path: "file.ts", side: "RIGHT", line: 3 },
    },
  });
  const child = command({
    dependencies: [parent.operationId],
    action: {
      kind: "resolve-thread",
      target: { source: "local", kind: "thread", operationId: parent.operationId },
    },
  });
  const edit = command({
    dependencies: [parent.operationId],
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "review-comment", operationId: parent.operationId },
      body: "edited inline",
      expectedBody: "inline",
    },
  });
  const review: GithubRemoteResult = {
    kind: "review-comment",
    id: 456,
    nodeId: "COMMENT_NODE",
    url: `${scope.url}#discussion_r456`,
    body: "inline",
    author: actor,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    location: { path: "file.ts", side: "RIGHT", line: 3, originalLine: 3, commitSha: sha },
  };
  f.adapter.send = async (op) =>
    op.command.action.kind === "inline-comment"
      ? { outcome: "accepted", result: review }
      : op.command.action.kind === "edit-comment"
        ? { outcome: "accepted", result: { ...review, body: "edited inline" } }
        : {
            outcome: "accepted",
            result: { kind: "thread", nodeId: "ACTUAL_THREAD", resolved: true },
          };
  await f.box.enqueue(parent);
  await f.box.enqueue(edit);
  await f.box.enqueue(child);
  await f.activate();
  await until(() => f.adapter.reads.length === 1);
  assert.equal((await operation(f, parent.operationId)).status, "synced");
  assert.equal((await operation(f, child.operationId)).retryMode, "blocked");
  assert.equal(f.adapter.posts.length, 2);
  f.adapter.check = async () => ({
    outcome: "matched",
    result: { ...review, body: "edited inline", threadId: "ACTUAL_THREAD" },
  });
  f.advance(5_001);
  await until(async () => (await operation(f, child.operationId)).status === "synced");
  assert.deepEqual(f.adapter.posts[2]!.command.action, {
    kind: "resolve-thread",
    target: { source: "remote", kind: "thread", nodeId: "ACTUAL_THREAD" },
  });
  assert.equal(
    f.adapter.posts.filter((op) => op.command.action.kind === "inline-comment").length,
    1,
  );
  assert.equal((await operation(f, parent.operationId)).revision, 4);
});

test("incompatible adapter results never sync for dispatch or reconciliation", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "accepted",
    result: { kind: "approval", id: 99, url: scope.url, commitSha: "a".repeat(40) },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  let op = await operation(f, a.operationId);
  f.adapter.check = async (current) => ({
    outcome: "matched",
    result: { ...result(current), author: { id: 999, login: "wrong" } } as GithubRemoteResult,
  });
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "reconcile",
  });
  await until(async () => (await operation(f, a.operationId)).revision > op.revision + 1);
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
});

test("heartbeat and enqueue wake immediately; different PRs run concurrently, one write per PR", async (t) => {
  const f = await fixture(t, { pollMs: 60_000 });
  const pending: Array<() => void> = [];
  f.adapter.send = (op) =>
    new Promise((resolve) =>
      pending.push(() => resolve({ outcome: "accepted", result: result(op) })),
    );
  await f.activate();
  await f.activate(otherScope);
  const a = command();
  const b = command();
  const c = command({ scope: otherScope });
  await f.box.enqueue(a);
  await f.box.enqueue(b);
  await f.box.enqueue(c);
  await until(() => f.adapter.posts.length === 2);
  assert.deepEqual(
    new Set(f.adapter.posts.map((op) => op.command.operationId)),
    new Set([a.operationId, c.operationId]),
  );
  pending.shift()!();
  pending.shift()!();
  await until(() => f.adapter.posts.length === 3);
  assert.equal(f.adapter.posts[2]!.command.operationId, b.operationId);
  pending.shift()!();
});

test("two visible tabs keep a PR active until last lease expires; hidden tab cannot revoke another", async (t) => {
  const f = await fixture(t, { leaseMs: 100 });
  const first = await f.activate();
  const second = await f.activate();
  await f.box.heartbeat({ clientId: first, scope, visible: false });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "synced");
  f.advance(101);
  const b = command();
  await f.box.enqueue(b);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.adapter.posts.length, 1);
  await f.activate(scope, second);
  await until(async () => (await operation(f, b.operationId)).status === "synced");
});

test("live wrong actor and failed identity refresh never post, even with active leases", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.liveActor = { id: 999, login: actor.login };
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "retry-failed");
  assert.equal((await operation(f, a.operationId)).error?.code, "identity-mismatch");
  assert.equal(f.adapter.posts.length, 0);
  const op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "cancel",
  });
  f.adapter.liveActor = actor;
  f.adapter.available = false;
  const b = command();
  await f.box.enqueue(b);
  await until(async () => (await operation(f, b.operationId)).status === "retry-failed");
  assert.equal(f.adapter.posts.length, 0);
  assert.ok(!JSON.stringify(await f.box.snapshot(scope)).includes("secret"));
});

test("lost acknowledgment never replays; restart and absent reconciliation remain uncertain; matched evidence syncs", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => {
    throw new Error("Authorization: secret");
  };
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  await f.reopen();
  await f.activate();
  f.advance(1_000_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.posts.length, 1);
  let op = await operation(f, a.operationId);
  assert.equal(
    (
      await f.box.control({
        requestId: randomUUID(),
        operationId: a.operationId,
        expectedRevision: op.revision,
        kind: "retry",
      })
    ).outcome,
    "rejected",
  );
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "reconcile",
  });
  await until(() => f.adapter.reads.length === 1);
  await until(async () => (await operation(f, a.operationId)).revision > op.revision + 1);
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
  f.adapter.check = async (current) => ({ outcome: "matched", result: result(current) });
  op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "reconcile",
  });
  await until(async () => (await operation(f, a.operationId)).status === "synced");
  assert.equal(f.adapter.posts.length, 1);
});

test("bounded close mid-post preserves uncertainty, fences late accepted response and opens cleanly", async (t) => {
  const f = await fixture(t);
  await f.activate();
  let finish!: () => void;
  f.adapter.send = (op) =>
    new Promise((resolve) => {
      finish = () => resolve({ outcome: "accepted", result: result(op) });
    });
  const a = command();
  await f.box.enqueue(a);
  await until(() => f.adapter.posts.length === 1);
  const start = Date.now();
  await f.reopen();
  assert.ok(Date.now() - start < 500);
  finish();
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
  await f.activate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.posts.length, 1);
});

test("startup converts a durably persisted crashed inflight to uncertain", async (t) => {
  const f = await fixture(t);
  const a = command();
  await f.box.enqueue(a);
  await f.box.close();
  const db = new DatabaseSync(f.options.databasePath);
  const row = db.prepare("SELECT data FROM operations WHERE id=?").get(a.operationId)!;
  const op: GithubOutboxOperation = JSON.parse(row.data as string);
  op.status = "inflight";
  op.attempts = 1;
  db.prepare("UPDATE operations SET data=? WHERE id=?").run(JSON.stringify(op), a.operationId);
  db.close();
  await f.reopen();
  await f.activate();
  assert.equal((await operation(f, a.operationId)).status, "uncertain");
  assert.equal(f.adapter.posts.length, 0);
});

test("dispatch timeout remains uncertain and blocks the PR FIFO", async (t) => {
  const f = await fixture(t, { attemptTimeoutMs: 20 });
  await f.activate();
  f.adapter.send = () => new Promise(() => {});
  const a = command();
  const b = command();
  await f.box.enqueue(a);
  await f.box.enqueue(b);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  assert.equal((await operation(f, b.operationId)).status, "queued");
  assert.equal(f.adapter.posts.length, 1);
});

test("local refs resolve to real IDs; edit/delete retain immutable expected body and original content", async (t) => {
  const f = await fixture(t);
  const parent = command();
  const edit = command({
    dependencies: [parent.operationId],
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "issue-comment", operationId: parent.operationId },
      body: "edited",
      expectedBody: "hello",
    },
  });
  const deletion = command({
    dependencies: [parent.operationId, edit.operationId],
    action: {
      kind: "delete-comment",
      target: { source: "local", kind: "issue-comment", operationId: parent.operationId },
      expectedBody: "edited",
    },
  });
  for (const cmd of [parent, edit, deletion])
    assert.equal((await f.box.enqueue(cmd)).outcome, "accepted");
  f.adapter.send = async (op) => {
    const action = op.command.action;
    if (action.kind === "delete-comment") {
      assert.equal(action.target.source, "remote");
      assert.equal(action.expectedBody, "edited");
      return {
        outcome: "accepted",
        result: { kind: "deleted", target: { source: "remote", kind: "issue-comment", id: 123 } },
      };
    }
    return { outcome: "accepted", result: result(op) };
  };
  await f.activate();
  await until(async () => (await operation(f, deletion.operationId)).status === "synced");
  assert.deepEqual(f.adapter.posts[1]!.command.action, {
    kind: "edit-comment",
    target: { source: "remote", kind: "issue-comment", id: 123 },
    body: "edited",
    expectedBody: "hello",
  });
  assert.deepEqual((await operation(f, edit.operationId)).command, edit);
});

test("dependency validation rejects forward edges/cross scope/wrong entity; cancelled parent blocks child and preserves text", async (t) => {
  const f = await fixture(t);
  const parent = command();
  assert.equal(
    (await f.box.enqueue(command({ dependencies: [parent.operationId] }))).outcome,
    "rejected",
  );
  await f.box.enqueue(parent);
  assert.equal(
    (await f.box.enqueue(command({ scope: otherScope, dependencies: [parent.operationId] })))
      .outcome,
    "rejected",
  );
  assert.equal(
    (
      await f.box.enqueue(
        command({
          dependencies: [parent.operationId],
          action: {
            kind: "reply",
            target: { source: "local", kind: "review-comment", operationId: parent.operationId },
            body: "reply",
          },
        }),
      )
    ).outcome,
    "rejected",
  );
  const child = command({ dependencies: [parent.operationId] });
  await f.box.enqueue(child);
  await f.box.control({
    requestId: randomUUID(),
    operationId: parent.operationId,
    expectedRevision: 1,
    kind: "cancel",
  });
  await f.activate();
  await until(async () => (await operation(f, child.operationId)).status === "retry-failed");
  assert.deepEqual((await operation(f, parent.operationId)).command, parent);
  assert.equal(f.adapter.posts.length, 0);
});

test("known-not-applied backoff survives restart; auth/head changes pause automatic attempts", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "rejected",
    error: { code: "network", message: "offline", retryable: true },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "retry-failed");
  const before = await operation(f, a.operationId);
  assert.ok(before.nextAttemptAt);
  await f.reopen();
  await f.activate();
  assert.equal((await operation(f, a.operationId)).nextAttemptAt, before.nextAttemptAt);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.adapter.posts.length, 1);
  f.adapter.send = async () => ({
    outcome: "rejected",
    error: { code: "head-changed", message: "new head", retryable: true },
  });
  f.advance(1_001);
  await until(() => f.adapter.posts.length === 2);
  await until(async () => (await operation(f, a.operationId)).status === "retry-failed");
  assert.equal((await operation(f, a.operationId)).nextAttemptAt, undefined);
  f.advance(1_000_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.posts.length, 2);
});

test("uncertainty confirmation requires a separate retry decision; controls CAS, evidence mismatch, reconcile actor checks", async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.adapter.send = async () => ({
    outcome: "uncertain",
    error: { code: "network", message: "timeout", retryable: true },
  });
  const a = command();
  await f.box.enqueue(a);
  await until(async () => (await operation(f, a.operationId)).status === "uncertain");
  let op = await operation(f, a.operationId);
  assert.equal(
    (
      await f.box.control({
        requestId: randomUUID(),
        operationId: a.operationId,
        expectedRevision: 1,
        kind: "cancel",
      })
    ).outcome,
    "rejected",
  );
  assert.equal(
    (
      await f.box.control({
        requestId: randomUUID(),
        operationId: a.operationId,
        expectedRevision: op.revision,
        kind: "resolve-uncertainty",
        resolution: {
          kind: "confirm-applied",
          result: { kind: "thread", nodeId: "not-a-comment", resolved: true },
        },
      })
    ).outcome,
    "rejected",
  );
  const priorReads = f.adapter.reads.length;
  f.adapter.liveActor = { id: 99, login: "other" };
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "reconcile",
  });
  await until(async () => (await operation(f, a.operationId)).error?.code === "identity-mismatch");
  assert.equal(f.adapter.reads.length, priorReads);
  op = await operation(f, a.operationId);
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "resolve-uncertainty",
    resolution: { kind: "confirm-not-applied" },
  });
  f.adapter.liveActor = actor;
  f.advance(1_000_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.adapter.posts.length, 1);
  op = await operation(f, a.operationId);
  await f.activate();
  await f.box.control({
    requestId: randomUUID(),
    operationId: a.operationId,
    expectedRevision: op.revision,
    kind: "retry",
  });
  await until(() => f.adapter.posts.length === 2);
});
