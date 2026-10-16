import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GithubOutboxCommand,
  GithubOutboxOperation,
  GithubPrScope,
  GithubRemoteResult,
} from "@better-review/shared";

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
    pendingCount: operations.filter((op) => op.status !== "synced").length,
  };
}
const empty = (): GithubRemoteRead => ({ comments: [], threads: [], approvals: [] });
function memoryJournal(): BrowserGithubJournal {
  const entries = new Map<string, GithubAdmission>();
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
      if (entry)
        entries.set(submittedId, {
          ...entry,
          backendOwned: true,
          operation: structuredClone(op),
        });
    },
    async admissionFailed(operationId, admissionError) {
      const entry = entries.get(operationId)!;
      entries.set(operationId, { ...entry, admissionError });
    },
    async remove(operationId) {
      entries.delete(operationId);
    },
    async close() {},
    async saveDraft() {},
    async draft() {
      return undefined;
    },
    async putControl() {},
    async controls() {
      return [];
    },
    async removeControl() {},
  };
}

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
  assert.deepEqual(await journal.list(), []);
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
  assert.ok(seen.every((cmd) => JSON.stringify(cmd) === JSON.stringify(command())));
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
