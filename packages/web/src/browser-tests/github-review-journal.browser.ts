import type { GithubOutboxCommand } from "@better-review/shared";
import type { GithubOutboxOperation } from "@better-review/shared";

import { createGithubOutbox, type GithubOutboxTransport } from "../lib/github-outbox";
import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { createGithubOutboxProjection } from "../lib/github-outbox-projection";
import { createAssertions } from "./assertions";

/** Actual IndexedDB close/reopen; transport is an isolated fixture, never GitHub. */
export async function testReviewJournalInBrowser() {
  const { check, wait, result } = createAssertions(2000);
  const scope = {
    host: "github.com",
    owner: "test",
    repo: "test",
    number: 1,
    url: "https://github.com/test/test/pull/1",
  } as const;
  const name = `review-journal-${crypto.randomUUID()}`;
  let journal = createIndexedDbGithubJournal(name);
  for (const kind of ["request-changes", "review-comment"] as const) {
    const slot = `review:${kind}`;
    const head = "a".repeat(40);
    const draft = await journal.openEditor(slot, scope, {
      body: "",
      context: { expectedHeadSha: head, kind },
    });
    await journal.saveEditor(draft.key, "Retained review text");
    await journal.close();
    journal = createIndexedDbGithubJournal(name);
    const restored = await journal.openEditor(slot, scope);
    check(restored.body === "Retained review text", "Unsubmitted review draft lost");
    check(restored.context?.expectedHeadSha === head, "Editor-open head was not retained");
    const command: GithubOutboxCommand = {
      operationId: crypto.randomUUID(),
      scope,
      expectedActor: { id: 42, login: "test" },
      dependencies: [],
      action: { kind, expectedHeadSha: restored.context!.expectedHeadSha, body: restored.body },
    };
    await journal.admit(command, restored.key);
    await journal.admissionFailed(
      command.operationId,
      "Wait for review cooldown",
      "2026-01-01T00:01:00Z",
    );
    await journal.close();
    journal = createIndexedDbGithubJournal(name);
    const entry = (await journal.entries(scope)).find(
      (item) => item.command.operationId === command.operationId,
    )!;
    check(
      JSON.stringify(entry.command) === JSON.stringify(command),
      "Review intent changed after reopen",
    );
    check(entry.admissionRetryAt === "2026-01-01T00:01:00Z", "Cooldown deadline lost");
    check(
      (await journal.draft(restored.key))?.submittedOperationId === command.operationId,
      "Draft identity not linked atomically",
    );
    const next = await journal.openEditor(slot, scope);
    check(
      next.key !== restored.key && next.body === "",
      "Submitted draft restored as second unsent intent",
    );
  }
  const entries = await journal.entries(scope);
  const projected = createGithubOutboxProjection().project({
    scope,
    revision: 0,
    operations: entries.map((entry) => ({ ...entry, status: "local-pending" })),
    pendingCount: entries.length,
    pendingSaving: 0,
    busy: true,
  });
  check(
    projected.reviews.length === 2 &&
      projected.reviews.every((item) => item.pending && item.body === "Retained review text"),
    "Pending review projection lost",
  );
  check(projected.comments.length === 0, "Review actions became inline comment entities");
  // Isolated fixture only: real IndexedDB and client recovery, no GitHub requests.
  const intent: GithubOutboxCommand = {
    operationId: crypto.randomUUID(),
    scope,
    expectedActor: { id: 42, login: "test" },
    dependencies: [],
    action: { kind: "issue-comment", body: "Restart fixture" },
  };
  await journal.admit(intent);
  let now = Date.now();
  let calls = 0;
  let initialized = false;
  let committed: GithubOutboxOperation | undefined;
  let lostAck = false;
  const transport: GithubOutboxTransport = {
    async enqueue(command) {
      check(command.operationId === intent.operationId, "Recovery changed immutable UUID");
      calls++;
      if (!initialized)
        return {
          outcome: "rejected",
          operationId: command.operationId,
          error: {
            code: "identity-unknown",
            message: "Fixture identity initializing",
            retryable: true,
          },
        };
      if (committed) return { outcome: "duplicate", operation: committed };
      committed = {
        command,
        status: "queued",
        retryMode: "automatic",
        attempts: 0,
        revision: 1,
        sequence: 1,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      lostAck = true;
      throw new Error("Fixture withheld admission response");
    },
    async snapshot() {
      if (lostAck) throw new Error("Fixture connection offline");
      return { scope, revision: committed ? 1 : 0, operations: committed ? [committed] : [] };
    },
    async heartbeat() {},
    async control() {
      throw new Error("No fixture controls");
    },
  };
  let client = createGithubOutbox({ journal, transport, now: () => now });
  await client.recover(scope);
  check(calls === 1, "Startup admission not attempted");
  await client.close();
  journal = createIndexedDbGithubJournal(name);
  const transient = (await journal.entries(scope)).find(
    (entry) => entry.command.operationId === intent.operationId,
  )!;
  check(transient.admissionRetryable === true, "Automatic admission classification lost on reopen");
  check(!!transient.admissionRetryAt, "Automatic admission deadline lost on reopen");
  client = createGithubOutbox({ journal, transport, now: () => now });
  initialized = true;
  await client.recover(scope);
  check(calls === 1, "Client ignored persisted retry deadline");
  now += 15_001;
  await client.recover(scope).catch(() => {});
  check(calls === 2 && !!committed, "Identity recovery stranded local intent");
  await client.close();
  journal = createIndexedDbGithubJournal(name);
  client = createGithubOutbox({ journal, transport, now: () => now });
  lostAck = false;
  await client.recover(scope);
  const recovered = (await journal.entries(scope)).find(
    (entry) => entry.command.operationId === intent.operationId,
  )!;
  check(recovered.backendOwned && calls === 3, "Lost acknowledgement did not replay exactly once");
  check(
    !recovered.admissionError && !recovered.admissionRetryAt && !recovered.admissionRetryable,
    "Confirmed receipt retained obsolete admission failure",
  );
  await client.close();
  journal = createIndexedDbGithubJournal(name);
  const chainScope = { ...scope, number: 2, url: "https://github.com/test/test/pull/2" };
  const chain = Array.from({ length: 4 }, (_, index): GithubOutboxCommand => ({
    ...intent,
    scope: chainScope,
    operationId: crypto.randomUUID(),
    action: { kind: "issue-comment", body: `Dependency fixture ${index}` },
    dependencies: [],
  }));
  for (let n = 1; n < chain.length; n++) chain[n]!.dependencies = [chain[n - 1]!.operationId];
  const alias = chain[0]!.operationId;
  const canonicalId = crypto.randomUUID();
  let root: GithubOutboxOperation = {
    command: { ...chain[0]!, operationId: canonicalId },
    sequence: 1,
    revision: 1,
    status: "retry-failed",
    retryMode: "blocked",
    attempts: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    error: { code: "auth", retryable: false, message: "Fixture authentication requires attention" },
  };
  await journal.admit(chain[0]!);
  await journal.acknowledge(root, alias);
  for (const command of chain.slice(1).reverse()) await journal.admit(command);
  await journal.close();
  journal = createIndexedDbGithubJournal(name);
  const admitted: GithubOutboxOperation[] = [];
  const chainCalls: string[] = [];
  const chainTransport: GithubOutboxTransport = {
    ...transport,
    async enqueue(command) {
      chainCalls.push(command.operationId);
      const op: GithubOutboxOperation = {
        ...root,
        command: {
          ...command,
          dependencies: command.dependencies.map((id) => (id === alias ? canonicalId : id)),
        },
        sequence: admitted.length + 2,
        revision: 1,
        status: "queued",
        retryMode: "automatic",
        attempts: 0,
        error: undefined,
      };
      admitted.push(op);
      return { outcome: "accepted", operation: op };
    },
    async snapshot() {
      return {
        scope: chainScope,
        revision: root.revision + admitted.length,
        operations: [root, ...admitted],
      };
    },
  };
  client = createGithubOutbox({ journal, transport: chainTransport, now: () => now });
  await client.recover(chainScope);
  await client.recover(chainScope);
  check(chainCalls.length === 0, "Deep aliased blocker still entered admission HTTP");
  const blocked = client.getState(chainScope);
  check(
    !blocked.busy && blocked.operations.length === 4,
    "Deep aliased chain spins or projects duplicate root",
  );
  for (const item of blocked.operations)
    if (item.command.operationId !== canonicalId)
      check(
        item.blockedByOperationId === canonicalId,
        "Descendant points to intermediate/alias instead of real blocker",
      );
  root = {
    ...root,
    status: "synced",
    revision: 2,
    error: undefined,
    result: {
      kind: "issue-comment",
      id: 5,
      url: chainScope.url,
      body: "Dependency fixture 0",
      author: intent.expectedActor,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    },
  };
  await client.snapshot(chainScope);
  await client.close();
  journal = createIndexedDbGithubJournal(name);
  client = createGithubOutbox({ journal, transport: chainTransport, now: () => now });
  await client.recover(chainScope);
  await client.recover(chainScope);
  check(
    JSON.stringify(chainCalls) ===
      JSON.stringify(chain.slice(1).map((command) => command.operationId)),
    "Resolved alias chain did not admit children once in dependency order after reopen",
  );
  check(
    client
      .getState(chainScope)
      .operations.every((item) => item.backendOwned && !item.blockedByOperationId),
    "Resolved blocker survived durable alias refresh",
  );
  await client.close();
  journal = createIndexedDbGithubJournal(name);
  await journal.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const globalName = `${name}-global`;
  journal = createIndexedDbGithubJournal(globalName);
  const globalIntent: GithubOutboxCommand = {
    ...intent,
    operationId: crypto.randomUUID(),
    action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "" },
  };
  await journal.admit(globalIntent);
  await journal.close(); // browser closed before durable server acknowledgement
  journal = createIndexedDbGithubJournal(globalName);
  let globalAdmissions = 0;
  let globalHeartbeats = 0;
  let globalCommitted: GithubOutboxOperation | undefined;
  client = createGithubOutbox({
    journal,
    pollMs: 5,
    transport: {
      async enqueue(command) {
        check(
          JSON.stringify(command) === JSON.stringify(globalIntent),
          "Global recovery changed saved UUID/actor/head",
        );
        globalAdmissions++;
        if (globalCommitted) return { outcome: "duplicate", operation: globalCommitted };
        globalCommitted = {
          command,
          sequence: 1,
          revision: 1,
          status: "queued",
          attempts: 0,
          retryMode: "automatic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        throw new Error("Fixture lost acknowledgement after global admission");
      },
      async snapshot(scope) {
        if (globalAdmissions === 1) throw new Error("Fixture temporarily disconnected");
        return {
          scope,
          revision: globalCommitted ? 1 : 0,
          operations: globalCommitted ? [globalCommitted] : [],
        };
      },
      async heartbeat() {
        globalHeartbeats++;
      },
      async control() {
        throw new Error("No global fixture controls");
      },
    },
  });
  try {
    client.startRecovery(); // app open on list page; no PR activation at all
    await wait(
      () => !!client.getState(scope).operations[0]?.backendOwned,
      "Global IndexedDB recovery did not run on list page",
    );
    check(globalAdmissions === 2, "Global recovery did not deduplicate lost acknowledgement");
    check(globalHeartbeats === 0, "Global recovery fabricated an active PR lease");
    check(client.getStates()[0]?.pendingCount === 1, "Global pending state missing on list page");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(globalName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  return result();
}
