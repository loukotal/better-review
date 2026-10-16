import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { GithubOutboxCommand } from "@better-review/shared";

import { createGithubOutboxRuntime } from "./runtime";
import type { GithubOutboxAdapter } from "./types";

test("runtime admits durably without network, caches stable identity and closes ownership", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "github-runtime-"));
  let identityCalls = 0;
  let writes = 0;
  const adapter: GithubOutboxAdapter = {
    async identity() {
      identityCalls++;
      return { outcome: "known", actor: { id: 42, login: "reviewer" } };
    },
    async dispatch() {
      writes++;
      throw new Error("No writes expected without a lease");
    },
    async reconcile() {
      throw new Error("No reconciliation expected");
    },
    async verifyApplied() {
      throw new Error("No verification expected");
    },
  };
  const databasePath = path.join(directory, "outbox.sqlite");
  const runtime = await createGithubOutboxRuntime({ databasePath, adapter });
  const command: GithubOutboxCommand = {
    operationId: randomUUID(),
    scope: {
      host: "github.com",
      owner: "owner",
      repo: "repo",
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
    },
    expectedActor: { id: 42, login: "reviewer" },
    dependencies: [],
    action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "review body" },
  };
  try {
    await runtime.refreshIdentity();
    const before = identityCalls;
    assert.equal((await runtime.outbox.enqueue(command)).outcome, "accepted");
    assert.equal(identityCalls, before);
    assert.equal(writes, 0);
    assert.equal(runtime.actor()?.id, 42);
    await runtime.close();
    const reopened = await createGithubOutboxRuntime({ databasePath, adapter });
    try {
      assert.equal(
        (await reopened.outbox.snapshot(command.scope)).operations[0]?.command.operationId,
        command.operationId,
      );
      assert.equal((await reopened.outbox.enqueue(command)).outcome, "duplicate");
    } finally {
      await reopened.close();
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("slow remote dispatch does not delay durable acknowledgement and pinned head survives sync", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "github-runtime-slow-"));
  let release!: () => void;
  const remote = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writes = 0;
  const head = "a".repeat(40);
  const adapter: GithubOutboxAdapter = {
    async identity() {
      return { outcome: "known", actor: { id: 42, login: "reviewer" } };
    },
    async dispatch(operation) {
      writes++;
      assert.equal(operation.command.action.kind, "approve");
      if (operation.command.action.kind === "approve")
        assert.equal(operation.command.action.expectedHeadSha, head);
      started();
      await remote;
      return {
        outcome: "accepted",
        result: {
          kind: "approval",
          id: 123,
          url: "https://github.com/o/r/pull/1#pullrequestreview-123",
          commitSha: head,
        },
      };
    },
    async reconcile() {
      return { outcome: "absent" };
    },
    async verifyApplied() {
      throw new Error("No verification expected");
    },
  };
  const runtime = await createGithubOutboxRuntime({
    databasePath: path.join(directory, "outbox.sqlite"),
    adapter,
  });
  const scope = {
    host: "github.com" as const,
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
  };
  try {
    await runtime.refreshIdentity();
    await runtime.outbox.heartbeat({ clientId: randomUUID(), scope, visible: true });
    const receipt = await runtime.outbox.enqueue({
      operationId: randomUUID(),
      scope,
      expectedActor: { id: 42, login: "reviewer" },
      dependencies: [],
      action: { kind: "approve", expectedHeadSha: head, body: "" },
    });
    assert.equal(receipt.outcome, "accepted");
    await dispatchStarted;
    assert.equal((await runtime.outbox.snapshot(scope)).operations[0]?.status, "inflight");
    release();
    for (let count = 0; count < 100; count++) {
      if ((await runtime.outbox.snapshot(scope)).operations[0]?.status === "synced") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal((await runtime.outbox.snapshot(scope)).operations[0]?.status, "synced");
    assert.equal(writes, 1);
  } finally {
    release();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
