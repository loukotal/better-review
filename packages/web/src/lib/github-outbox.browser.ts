/** Real IndexedDB regression fixture; callable through Vite/Playwright, no GitHub requests. */
import type {
  GithubOutboxCommand,
  GithubOutboxOperation,
  GithubPrScope,
} from "@better-review/shared";

import { createGithubOutbox, type GithubOutboxTransport } from "./github-outbox";
import { createIndexedDbGithubJournal } from "./github-outbox-journal";

export async function testGithubOutboxInBrowser() {
  let passed = 0;
  function check(value: unknown, message: string) {
    if (!value) throw new Error(message);
    passed++;
  }
  const name = `github-outbox-test-${crypto.randomUUID()}`;
  const scope: GithubPrScope = {
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
  };
  const actor = { id: 1, login: "author" };
  const command: GithubOutboxCommand = {
    operationId: crypto.randomUUID(),
    scope,
    expectedActor: actor,
    action: { kind: "issue-comment", body: "durable draft" },
    dependencies: [],
  };
  const operation: GithubOutboxOperation = {
    command,
    revision: 1,
    sequence: 1,
    status: "queued",
    retryMode: "automatic",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let journal = createIndexedDbGithubJournal(name);
  let second = createIndexedDbGithubJournal(name);
  let calls = 0;
  let loseAck = true;
  let loseControlAck = true;
  const seen: string[] = [];
  const transport: GithubOutboxTransport = {
    async enqueue(value) {
      calls++;
      seen.push(JSON.stringify(value));
      check(
        (await journal.entries(scope)).some(
          (entry) => entry.command.operationId === value.operationId,
        ),
        "journal commits before HTTP",
      );
      if (loseAck) throw new Error("lost receipt after admission");
      return { outcome: "duplicate", operation: { ...operation, command: value } };
    },
    async snapshot() {
      return { scope, revision: 1, operations: loseAck ? [] : [operation] };
    },
    async heartbeat() {},
    async control() {
      if (loseControlAck) throw new Error("lost control receipt");
      return {
        outcome: "duplicate",
        operation: { ...operation, status: "cancelled", revision: 2 },
      };
    },
  };
  let client = createGithubOutbox({ journal, transport });
  try {
    await journal.saveDraft({ key: "editor-1", scope, body: "durable draft" });
    await client.submit({
      scope,
      actor,
      action: command.action,
      operationId: command.operationId,
      draftKey: "editor-1",
    });
    await client.recover(scope);
    check(
      (await journal.entries(scope))[0].backendOwned === false,
      "lost ack remains local-pending",
    );
    check(
      (await journal.draft("editor-1"))?.submittedOperationId === command.operationId,
      "draft linked atomically to operation",
    );
    await client.close();
    journal = createIndexedDbGithubJournal(name);
    client = createGithubOutbox({ journal, transport });
    loseAck = false;
    await client.recover(scope);
    check((await journal.entries(scope))[0].backendOwned, "backend ownership survives reload");
    check(
      seen.every((value) => value === JSON.stringify(command)),
      "same admission ID and payload replayed after reload",
    );
    const repeated = await client.submit({
      scope,
      actor,
      action: command.action,
      draftKey: "editor-1",
    });
    check(
      repeated.operationId === command.operationId,
      "submitted draft does not create a duplicate editor operation",
    );
    await Promise.all([journal.admit(command), second.admit(command)]);
    check(
      (await second.entries(scope)).length === 1,
      "two tab journals deduplicate repeated admission",
    );
    let conflict = false;
    try {
      await second.admit({ ...command, action: { kind: "issue-comment", body: "different" } });
    } catch {
      conflict = true;
    }
    check(conflict, "same ID different payload rejected");
    check(
      (await second.entries(scope))[0].command.action.kind === "issue-comment",
      "conflict does not corrupt durable command",
    );
    const before = calls;
    await Promise.all([client.recover(scope), client.recover(scope)]);
    check(calls === before, "acknowledged commands not admitted again");
    const cancellation = {
      kind: "cancel" as const,
      operationId: command.operationId,
      expectedRevision: 1,
      requestId: crypto.randomUUID(),
    };
    let lostControl = false;
    try {
      await client.control(scope, cancellation);
    } catch {
      lostControl = true;
    }
    check(
      lostControl && (await journal.controls(scope))[0]?.requestId === cancellation.requestId,
      "lost control ack retains durable identical request",
    );
    loseControlAck = false;
    await client.recover(scope);
    check(
      (await journal.controls(scope)).length === 0,
      "duplicate control receipt removes only the pending control intent",
    );
    const recovered = await client.draftForOperation(scope, command.operationId);
    check(
      recovered?.canRestore && recovered.body === "durable draft",
      "confirmed cancellation preserves explicit draft recovery",
    );
    let savedOverSubmitted = false;
    try {
      await journal.saveDraft({ key: "editor-1", scope, body: "overwrite" });
    } catch {
      savedOverSubmitted = true;
    }
    check(savedOverSubmitted, "submitted draft cannot be overwritten by stale editor persistence");
    const pending = { ...command, operationId: crypto.randomUUID() };
    await second.admit(pending);
    let unsafeRemove = false;
    try {
      await second.remove(pending.operationId);
    } catch {
      unsafeRemove = true;
    }
    check(unsafeRemove, "uncertain admission cannot be discarded locally");
    const controls = {
      kind: "cancel" as const,
      requestId: crypto.randomUUID(),
      operationId: pending.operationId,
      expectedRevision: 1,
    };
    await second.putControl(controls, scope);
    await second.close();
    second = createIndexedDbGithubJournal(name);
    check(
      (await second.controls(scope))[0]?.requestId === controls.requestId,
      "control intent survives reload with stable request ID",
    );
    // A concurrent submit from another tab must not bind the already-submitted draft twice.
    let reboundDraft = false;
    try {
      await second.admit({ ...command, operationId: crypto.randomUUID() }, "editor-1");
    } catch {
      reboundDraft = true;
    }
    check(reboundDraft, "atomic draft mapping prevents a second tab submission");
    // Two independently generated operation UUIDs racing for one draft still yield one command.
    await journal.saveDraft({ key: "race-editor", scope, body: "racing" });
    const otherClient = createGithubOutbox({ journal: second, transport });
    try {
      await second.removeControl(controls.requestId);
      await Promise.all([client.recover(scope), otherClient.recover(scope)]);
      check(
        seen.filter((value) => JSON.parse(value).operationId === pending.operationId).length === 1,
        "Web Locks deduplicate two-tab pending network admission",
      );
      const [a, b] = await Promise.all([
        client.submit({
          scope,
          actor,
          action: { kind: "issue-comment", body: "racing" },
          draftKey: "race-editor",
        }),
        otherClient.submit({
          scope,
          actor,
          action: { kind: "issue-comment", body: "racing" },
          draftKey: "race-editor",
        }),
      ]);
      check(
        a.operationId === b.operationId,
        "concurrent tab submissions reuse atomically claimed draft operation",
      );
    } finally {
      await otherClient.close();
    }
  } finally {
    await client.close();
    await second.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  return { passed };
}
