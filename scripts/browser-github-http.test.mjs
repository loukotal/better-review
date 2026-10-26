import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createBrowserGithubHttp } from "./browser-github-http.mjs";

test(
  "isolated fixture serves production router/SuperJSON over HTTP with fixture-only auth",
  { timeout: 25000 },
  async () => {
    const fixture = await createBrowserGithubHttp();
    try {
      const url = `${fixture.origin}/api/trpc/githubOutbox.capability`;
      const denied = await fetch(url, { signal: AbortSignal.timeout(3000) });
      assert.equal(denied.status, 401);
      const accepted = await fetch(url, {
        headers: { authorization: `Bearer ${fixture.token}` },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual((await accepted.json()).result.data.json, {
        version: 1,
        durableAdmission: true,
      });
      assert.equal((await fixture.invoke("inspect")).operations.length, 0);
    } finally {
      const cleanup = await fixture.close();
      assert.ok(
        cleanup.serverClosed &&
          cleanup.runtimeStopped &&
          cleanup.processExited &&
          cleanup.storageRemoved,
      );
      assert.equal(await fixture.close(), cleanup, "Fixture cleanup must be idempotent");
    }
  },
);

test(
  "cleanup releases a held real worker mutation, closes HTTP/SQLite/runtime, and removes its subprocess/storage",
  { timeout: 25000 },
  async () => {
    const fixture = await createBrowserGithubHttp();
    try {
      await fixture.invoke("hold-approval");
      const scope = {
        host: "github.com",
        owner: "browser-fixture",
        repo: "isolated",
        number: 1,
        url: "https://github.com/browser-fixture/isolated/pull/1",
      };
      const command = {
        operationId: randomUUID(),
        scope,
        expectedActor: { id: 42, login: "browser-fixture" },
        dependencies: [],
        action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "shutdown while held" },
      };
      const response = await fetch(`${fixture.origin}/api/trpc/githubOutbox.enqueue`, {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
        body: JSON.stringify({ json: command }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.data.json.outcome, "accepted");
      const deadline = Date.now() + 5000;
      for (;;) {
        const evidence = await fixture.invoke("inspect");
        if (
          evidence.operations[0]?.status === "inflight" &&
          evidence.calls.some((call) => call.method === "POST")
        ) {
          assert.deepEqual(evidence.operations[0].command, command);
          break;
        }
        assert.ok(Date.now() < deadline, "Worker did not reach held mutation");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Deliberately leave the gate held: teardown must release it, including on test failure.
    } finally {
      const cleanup = await fixture.close();
      assert.ok(
        cleanup.serverClosed &&
          cleanup.runtimeStopped &&
          cleanup.processExited &&
          cleanup.storageRemoved,
      );
      assert.deepEqual(cleanup.faults, []);
    }
  },
);
