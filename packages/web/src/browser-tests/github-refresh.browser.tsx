import type { GithubOutboxOperation } from "@better-review/shared";
import { isGithubOutboxCommand } from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

/** Actual App refresh effects, including historical hydration and per-operation snapshot emissions. */
export async function testAppGithubSyncRefreshBatchingInBrowser() {
  let passed = 0,
    extras = 0,
    lists = 0,
    admissions = 0,
    revision = 1;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const frames = async () => {
    for (let n = 0; n < 10; n++) await new Promise(requestAnimationFrame);
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 180 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1"),
    head = "a".repeat(40),
    stamp = "2026-01-01T00:00:00Z";
  const historical: GithubOutboxOperation = {
    command: {
      scope,
      operationId: "11111111-1111-4111-8111-111111111111",
      expectedActor: { id: 42, login: "browser-fixture" },
      dependencies: [],
      action: { kind: "approve", expectedHeadSha: head, body: "old approval" },
    },
    status: "synced",
    revision: 1,
    sequence: 1,
    attempts: 1,
    retryMode: "blocked",
    createdAt: stamp,
    updatedAt: stamp,
    result: { kind: "approval", id: 100, url: scope.url, commitSha: head },
  };
  const records = new Map([[historical.command.operationId, historical]]);
  await mountAppFixture({
    procedures: {
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid refresh fixture command");
        admissions++;
        const operation: GithubOutboxOperation = {
          command: input,
          status: "queued",
          revision: 1,
          sequence: records.size + 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: stamp,
          updatedAt: stamp,
        };
        records.set(input.operationId, operation);
        revision++;
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision,
        operations: [...records.values()].map((item) => structuredClone(item)),
      }),
      "pr.extras": () => {
        extras++;
        return { comments: [], issueComments: [], status: null };
      },
      "prs.refresh": () => {
        lists++;
        throw new Error("Fixture list refresh unavailable");
      },
    },
  });
  await refreshGithubActor();
  await githubWrites.snapshot(scope);
  await frames();
  check(
    extras === 0 && lists === 0,
    `Hydrated history replayed refreshes: extras=${extras}, lists=${lists}`,
  );
  const complete = async (ids: string[]) => {
    for (const id of ids) {
      const operation = records.get(id)!;
      operation.status = "synced";
      operation.revision++;
      operation.attempts++;
      const action = operation.command.action;
      operation.result =
        action.kind === "approve"
          ? { kind: "approval", id: operation.sequence + 100, url: scope.url, commitSha: head }
          : {
              kind: "issue-comment",
              id: operation.sequence + 100,
              url: `${scope.url}#issuecomment-${operation.sequence + 100}`,
              body: "body" in action ? action.body : "",
              author: operation.command.expectedActor,
              createdAt: stamp,
              updatedAt: stamp,
            };
    }
    revision++;
    await githubWrites.snapshot(scope);
  };
  const comments = await Promise.all([
    queueGithubWrite(scope.url, { kind: "issue-comment", body: "batch comment one" }),
    queueGithubWrite(scope.url, { kind: "issue-comment", body: "batch comment two" }),
  ]);
  await githubWrites.recover(scope);
  await complete(comments.map((item) => item.operationId));
  await wait(() => extras === 1, "One snapshot batch did not coalesce extras refresh");
  check(lists === 0, "Comment completions refreshed the full PR list");
  for (let n = 0; n < 5; n++) await githubWrites.snapshot(scope);
  await frames();
  check(extras === 1 && lists === 0, "Unchanged snapshots repeated invalidations");
  const approvals = await Promise.all([
    queueGithubWrite(scope.url, {
      kind: "approve",
      expectedHeadSha: head,
      body: "batch approval one",
    }),
    queueGithubWrite(scope.url, {
      kind: "approve",
      expectedHeadSha: head,
      body: "batch approval two",
    }),
  ]);
  await githubWrites.recover(scope);
  await complete(approvals.map((item) => item.operationId));
  await wait(
    () => lists === 1 && extras === 2,
    "Approval batch did not refresh list/extras exactly once",
  );
  for (let n = 0; n < 5; n++) await githubWrites.snapshot(scope);
  await frames();
  check(
    lists === 1 && extras === 2 && admissions === 4,
    "Failed list refresh repeated invalidations or re-enqueued an operation",
  );
  check(
    githubWrites.getState(scope).operations.every((item) => item.status === "synced"),
    "Read refresh failure changed write outcomes",
  );
  return { passed };
}
