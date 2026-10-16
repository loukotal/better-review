import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type {
  GithubOutboxOperation,
  GithubOutboxSnapshot,
  GithubPrScope,
} from "@better-review/shared";

import { PendingCommentForm } from "../components/CommentView";
import { createGithubOutbox } from "../lib/github-outbox";
import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope } from "../lib/github-writes";

/** Real IndexedDB + real editor + browser admission/reload lifecycle, no GitHub/model calls. */
export async function testDurableGithubEditorIntegrationInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const settle = async (predicate: () => boolean) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), "Browser condition did not settle");
  };
  const scope = githubPrScope("https://github.com/MyZenbase/Repo/pull/9");
  const other = githubPrScope("https://github.com/other/repo/pull/10");
  check(scope.url === "https://github.com/myzenbase/repo/pull/9", "Scope was not canonicalized");
  const head = "a".repeat(40);
  let offline = true;
  let writes = 0;
  let enqueueCalls = 0;
  const records = new Map<string, GithubOutboxOperation>();
  const heartbeats: { scope: GithubPrScope; visible: boolean }[] = [];
  let revision = 0;
  const transport = {
    async enqueue(command: GithubOutboxOperation["command"]) {
      enqueueCalls++;
      if (offline) throw new Error("Backend offline");
      let operation = records.get(command.operationId);
      if (operation) return { outcome: "duplicate" as const, operation };
      operation = {
        command: structuredClone(command),
        revision: 1,
        sequence: records.size + 1,
        status: "queued",
        retryMode: "automatic",
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.set(command.operationId, operation);
      revision++;
      return { outcome: "accepted" as const, operation };
    },
    async snapshot(current: GithubPrScope): Promise<GithubOutboxSnapshot> {
      if (offline) throw new Error("Backend offline");
      return {
        scope: current,
        revision,
        operations: [...records.values()]
          .filter((item) => item.command.scope.url === current.url)
          .map((item) => structuredClone(item)),
      };
    },
    async control(control: { operationId: string; kind: string }) {
      const operation = records.get(control.operationId)!;
      if (control.kind === "reconcile") {
        /* Read-only: never dispatch. */
      } else if (control.kind === "retry" && operation.status === "retry-failed") {
        operation.status = "queued";
        operation.revision++;
        revision++;
      }
      return { outcome: "applied" as const, operation: structuredClone(operation) };
    },
    async heartbeat(value: { scope: GithubPrScope; visible: boolean }) {
      heartbeats.push(value);
    },
  };
  const name = `github-integration-${crypto.randomUUID()}`;
  const makeClient = () =>
    createGithubOutbox({ journal: createIndexedDbGithubJournal(name), transport, pollMs: 60_000 });
  let client = makeClient();
  const host = document.createElement("div");
  document.body.append(host);
  let unknownActor = true;
  const [editorOpen, setEditorOpen] = createSignal(true);
  const dispose = render(
    () => (
      <>
        {editorOpen() && (
          <PendingCommentForm
            startLine={2}
            endLine={2}
            initialBody="recoverable inline body"
            onCancel={() => {}}
            onSubmit={async (body) => {
              await client.submit({
                scope,
                actor: unknownActor ? undefined : { id: 42, login: "reviewer" },
                action: {
                  kind: "inline-comment",
                  expectedHeadSha: head,
                  anchor: { path: "src/a.ts", side: "RIGHT", line: 2 },
                  body,
                },
              });
              setEditorOpen(false);
            }}
          />
        )}
      </>
    ),
    host,
  );
  const submitEditor = () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  try {
    submitEditor();
    await settle(() => !!host.querySelector('[role="alert"]'));
    check(
      host.querySelector("textarea")?.value === "recoverable inline body",
      "Unknown identity discarded draft",
    );
    check(
      client.getState(scope).operations.length === 0,
      "Unknown identity falsely claimed local save",
    );
    unknownActor = false;
    submitEditor();
    await settle(() => !editorOpen());
    check(
      client.getState(scope).operations[0]?.status === "local-pending",
      "Offline submission not saved locally",
    );
    const id = client.getState(scope).operations[0]!.command.operationId;
    check(writes === 0, "Offline submission reached GitHub");
    await client.close();
    client = makeClient();
    await client.recover(scope).catch(() => {});
    check(
      client.getState(scope).operations[0]?.command.operationId === id,
      "Reload changed admission ID",
    );
    offline = false;
    await client.recover(scope);
    check(
      client.getState(scope).operations[0]?.status === "queued",
      "Recovery did not get durable receipt",
    );
    check(records.size === 1 && enqueueCalls >= 2, "Replay created duplicate operation");
    const operation = records.get(id)!;
    check(
      operation.command.action.kind === "inline-comment" &&
        operation.command.action.expectedHeadSha === head,
      "Viewed head was not pinned",
    );
    // Slow remote does not hold the editor open: it is already closed before dispatch begins.
    writes++;
    operation.status = "inflight";
    operation.attempts++;
    operation.revision++;
    revision++;
    check(!editorOpen(), "Editor waited for remote completion");
    operation.status = "uncertain";
    operation.retryMode = "blocked";
    operation.revision++;
    revision++;
    await client.snapshot(scope);
    await client.control(scope, {
      requestId: crypto.randomUUID(),
      operationId: id,
      expectedRevision: operation.revision,
      kind: "reconcile",
    });
    check(writes === 1, "Checking uncertainty dispatched a duplicate write");
    client.activate(scope, true);
    client.activate(other, true);
    check(
      client.getState(other).operations.length === 0,
      "Navigation leaked another PR's pending comment",
    );
    await settle(() => heartbeats.some((value) => value.scope.url === scope.url && !value.visible));
    client.setVisible(false);
    await settle(() => heartbeats.some((value) => value.scope.url === other.url && !value.visible));
    check(
      client.getState(scope).operations[0]?.status === "uncertain",
      "Navigation discarded uncertain content",
    );
  } finally {
    dispose();
    host.remove();
    await client.close();
    indexedDB.deleteDatabase(name);
  }
  return { passed };
}
