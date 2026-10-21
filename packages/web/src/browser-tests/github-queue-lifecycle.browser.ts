import type {
  GithubOutboxCommand,
  GithubOutboxOperation,
  GithubOutboxAdmissionCycle,
} from "@better-review/shared";

import { createGithubOutbox, type GithubOutboxTransport } from "../lib/github-outbox";
import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";

/** Isolated IndexedDB + transport fixture. No GitHub, API or model requests. */
export async function testQueueTimeoutRetryAndDurableClearInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const scope = {
    host: "github.com",
    owner: "test",
    repo: "test",
    number: 1,
    url: "https://github.com/test/test/pull/1",
  } as const;
  let now = Date.now();
  const name = `queue-lifecycle-${crypto.randomUUID()}`;
  let journal = createIndexedDbGithubJournal(name);
  const command: GithubOutboxCommand = {
    operationId: crypto.randomUUID(),
    scope,
    expectedActor: { id: 42, login: "test" },
    action: { kind: "issue-comment", body: "Retained private fixture text" },
    dependencies: [],
    queueDeadlineAt: new Date(now + 60_000).toISOString(),
  };
  await journal.admit(command);
  let admissionOnline = false;
  let clearOnline = false;
  let calls = 0;
  let lostAck = true;
  let lostSnapshot = false;
  const cycles: GithubOutboxAdmissionCycle[] = [];
  const committed = new Map<string, GithubOutboxOperation>();
  const transport: GithubOutboxTransport = {
    async enqueue(value, cycle) {
      calls++;
      check(
        JSON.stringify(value) === JSON.stringify(command),
        "Retry changed original command/fingerprint",
      );
      if (!admissionOnline) throw new Error("Fixture offline");
      if (!cycle) throw new Error("Expired intent retried without explicit cycle");
      cycles.push(cycle);
      const prior = committed.get(value.operationId);
      if (prior) return { outcome: "duplicate", operation: prior };
      const op: GithubOutboxOperation = {
        command: value,
        sequence: 1,
        revision: 1,
        status: "queued",
        retryMode: "automatic",
        attempts: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        queueDeadlineAt: cycle.queueDeadlineAt,
      };
      committed.set(value.operationId, op);
      if (lostAck) {
        lostAck = false;
        lostSnapshot = true;
        throw new Error("Fixture lost acknowledgement");
      }
      return { outcome: "accepted", operation: op };
    },
    async snapshot(scope) {
      if (lostSnapshot) throw new Error("Fixture lost snapshot");
      return { scope, revision: committed.size, operations: [...committed.values()] };
    },
    async control() {
      throw new Error("No automatic control may replace an admission-cycle replay");
    },
    async heartbeat() {
      throw new Error("Global recovery must not create leases");
    },
    async batchControl(input) {
      if (!clearOnline) throw new Error("Fixture Clear offline");
      const operations: GithubOutboxOperation[] = [];
      for (const op of committed.values()) {
        const cleared = {
          ...op,
          status: "cancelled" as const,
          retryMode: "blocked" as const,
          revision: op.revision + 1,
        };
        committed.set(op.command.operationId, cleared);
        operations.push(cleared);
      }
      for (const value of input.commands ?? []) {
        const cleared: GithubOutboxOperation = {
          command: value,
          sequence: committed.size + 1,
          revision: 1,
          status: "cancelled",
          retryMode: "blocked",
          attempts: 0,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        committed.set(value.operationId, cleared);
        operations.push(cleared);
      }
      return {
        outcome: "applied",
        operations,
        requiresConfirmation: [],
        skipped: [],
        aliases: Object.fromEntries(
          (input.commands ?? []).map((value) => [value.operationId, value.operationId]),
        ),
      };
    },
  };
  let client = createGithubOutbox({ journal, transport, now: () => now });
  try {
    await client.recover(scope);
    const offlineCalls = calls;
    now += 60_000;
    await client.recover(scope);
    check(calls === offlineCalls, "Expired local intent still reached admission transport");
    check(
      client.getState(scope).operations[0]?.admissionTimedOut && !client.getState(scope).busy,
      "Local timeout is not actionable/inactive",
    );
    await client.close();
    journal = createIndexedDbGithubJournal(name);
    client = createGithubOutbox({ journal, transport, now: () => now });
    client.setQueueTimeoutMs(15 * 60_000);
    await client.recover(scope);
    check(calls === offlineCalls, "Preference/reopen silently extended the expired cycle");
    admissionOnline = true;
    await client.retryAdmission(scope, command.operationId);
    check(
      committed.size === 1 && cycles.length === 1,
      "Explicit Retry did not create exactly one cycle",
    );
    await client.close();
    journal = createIndexedDbGithubJournal(name);
    client = createGithubOutbox({ journal, transport, now: () => now });
    lostSnapshot = false;
    await client.recoverAll();
    check(
      cycles.length === 2 && cycles[0]!.requestId === cycles[1]!.requestId,
      "Cycle request UUID lost on IndexedDB reopen",
    );
    check(
      cycles[0]!.queueDeadlineAt === cycles[1]!.queueDeadlineAt,
      "Recovery extended retry deadline",
    );
    check(
      client.getState(scope).operations[0]?.backendOwned,
      "Lost retry acknowledgement not recovered",
    );
    const local = {
      ...command,
      operationId: crypto.randomUUID(),
      queueDeadlineAt: new Date(now + 300_000).toISOString(),
    };
    await journal.admit(local);
    await client.clearAll().then(
      () => {
        throw new Error("Offline Clear unexpectedly succeeded");
      },
      () => {},
    );
    const callsBeforeClear = calls;
    await client.close();
    journal = createIndexedDbGithubJournal(name);
    check((await journal.batches!()).length === 1, "Clear decision not durable before HTTP");
    client = createGithubOutbox({ journal, transport, now: () => now });
    await client.recoverAll();
    check(calls === callsBeforeClear, "Reopen admitted intent despite unacknowledged Clear");
    clearOnline = true;
    await client.recoverAll();
    check(client.getState(scope).pendingCount === 0, "Acknowledged Clear left ghost pending work");
    check((await journal.entries(scope)).length === 2, "Clear deleted saved intent history");
    check((await journal.batches!()).length === 0, "Acknowledged Clear keeps replaying");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  return { passed };
}

export async function testDependentAdmissionClearFenceAcrossConnectionsInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Fence interleaving did not complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  for (const clearAckFirst of [false, true]) {
    const name = `queue-clear-fence-${crypto.randomUUID()}`;
    const journal = createIndexedDbGithubJournal(name);
    const otherJournal = createIndexedDbGithubJournal(name);
    const scope = {
      host: "github.com",
      owner: "test",
      repo: "test",
      number: 1,
      url: "https://github.com/test/test/pull/1",
    } as const;
    const parent: GithubOutboxCommand = {
      operationId: crypto.randomUUID(),
      scope,
      expectedActor: { id: 42, login: "test" },
      action: { kind: "issue-comment", body: "Parent fixture" },
      dependencies: [],
    };
    await journal.admit(parent);
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let parentHeld = false;
    let clearHeld = false;
    let childCalls = 0;
    let clearApplied = false;
    const clearIds: string[] = [];
    const remote = new Map<string, GithubOutboxOperation>();
    let clearReceipt: import("@better-review/shared").GithubOutboxBatchReceipt | undefined;
    const wire: GithubOutboxTransport = {
      async enqueue(command) {
        const operation: GithubOutboxOperation = {
          command,
          status: "queued",
          attempts: 0,
          retryMode: "automatic",
          sequence: remote.size + 1,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        remote.set(command.operationId, operation);
        if (command.operationId === parent.operationId) {
          parentHeld = true;
          await parentGate;
        } else childCalls++;
        return { outcome: "accepted", operation }; // deliberately old receipt after Clear
      },
      async snapshot() {
        return { scope, revision: 2, operations: [...remote.values()] };
      },
      async heartbeat() {},
      async control() {
        throw new Error("No controls in Clear fence fixture");
      },
      async batchControl(input) {
        clearIds.push(input.requestId);
        clearHeld = true;
        await clearGate;
        if (clearReceipt) return clearReceipt;
        const operations = input.commands!.map((command, index): GithubOutboxOperation => ({
          command,
          status: "cancelled",
          attempts: 0,
          retryMode: "blocked",
          sequence: index + 1,
          revision: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        for (const operation of operations) remote.set(operation.command.operationId, operation);
        clearReceipt = {
          outcome: "applied",
          operations,
          requiresConfirmation: [],
          skipped: [],
          aliases: Object.fromEntries(
            input.commands!.map((command) => [command.operationId, command.operationId]),
          ),
        };
        clearApplied = true;
        return clearReceipt;
      },
    };
    const client = createGithubOutbox({ journal, transport: wire });
    const clearingClient = createGithubOutbox({ journal: otherJournal, transport: wire });
    let reloaded: ReturnType<typeof createGithubOutbox> | undefined;
    let decision: Promise<unknown> | undefined;
    try {
      const child = await client.submit({
        scope,
        actor: parent.expectedActor,
        dependencies: [parent.operationId],
        action: { kind: "issue-comment", body: "Child fixture" },
      });
      await wait(() => parentHeld);
      decision = clearingClient.clearAll();
      // Attach now: the lost-ack variant closes this client while its HTTP waits.
      void decision.catch(() => {});
      await wait(() => clearHeld);
      check(
        (await otherJournal.batches!()).length === 1,
        "Clear was not committed before parent release",
      );
      if (clearAckFirst) {
        releaseClear();
        await decision;
        releaseParent();
        await wait(() => client.getState(scope).operations.every((item) => item.backendOwned));
        const state = client.getState(scope);
        check(
          state.operations.every((item) => item.status === "cancelled"),
          "Late parent receipt revived a cleared record",
        );
        check(
          state.pendingCount === 0,
          "Late receipt resurrected pending work before snapshot refresh",
        );
      } else {
        releaseParent();
        await client.recover(scope);
        check(
          childCalls === 0,
          "Child escaped another connection's persisted Clear while response was held",
        );
        await clearingClient.close();
        await decision.catch(() => {});
        const restoredJournal = createIndexedDbGithubJournal(name);
        reloaded = createGithubOutbox({ journal: restoredJournal, transport: wire });
        await reloaded.recover(scope);
        check(childCalls === 0, "Reload lost the unacknowledged Clear fence");
        releaseClear();
        await wait(() => clearApplied);
        await reloaded.recoverAll();
        check(
          clearIds.length === 2 && clearIds[0] === clearIds[1],
          "Reload did not replay the identical Clear decision",
        );
        check(reloaded.getState(scope).pendingCount === 0, "Recovered Clear left pending work");
      }
      await client.recover(scope);
      check(childCalls === 0, "Child admission occurred after Clear");
      check(
        client
          .getState(scope)
          .operations.find((item) => item.command.operationId === child.operationId)?.status ===
          "cancelled",
        "Cleared child was revived",
      );
      check((await journal.entries(scope)).length === 2, "Clear fence discarded intent history");
    } finally {
      releaseParent();
      releaseClear();
      await decision?.catch(() => {});
      await client.close();
      await clearingClient.close();
      await reloaded?.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }
  return { passed };
}
