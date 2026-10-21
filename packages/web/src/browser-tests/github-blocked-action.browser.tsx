import type { GithubOutboxSnapshot, PRComment } from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

export async function testBlockedFollowerRevealsEarlierActionAndSafeCancelInBrowser() {
  const url = "https://github.com/browser-fixture/isolated/pull/1",
    scope = githubPrScope(url);
  const comment: PRComment = {
    id: 20,
    node_id: "comment-node-not-thread",
    body: "action fixture body",
    path: "src/example.ts",
    line: 9,
    original_line: 9,
    side: "RIGHT",
    html_url: `${url}#discussion_r20`,
    user: { login: "browser-fixture", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    canEdit: true,
    threadId: "actual-thread",
    isResolved: false,
  };
  const rpc = (kind: string) => (input: unknown) => window.browserGithubActions({ kind, input });
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const wait = async (test: () => boolean, message: string) => {
    const until = performance.now() + 5000;
    while (!test() && performance.now() < until) await new Promise(requestAnimationFrame);
    check(test(), message);
  };
  const snapshot = async () =>
    (await window.browserGithubActions({ kind: "snapshot" })) as GithubOutboxSnapshot;
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: { comments: [comment], issueComments: [], status: null },
    procedures: {
      "githubOutbox.enqueue": rpc("enqueue"),
      "githubOutbox.snapshot": rpc("snapshot"),
      "githubOutbox.control": rpc("control"),
      "githubOutbox.heartbeat": rpc("heartbeat"),
      "pr.extras": () => ({ comments: [comment], issueComments: [], status: null }),
    },
  });
  await refreshGithubActor();
  await window.browserGithubActions({ kind: "fail-edit", input: true });
  const parent = await queueGithubWrite(url, {
    kind: "edit-comment",
    target: { source: "remote", kind: "review-comment", id: 20 },
    expectedBody: comment.body,
    body: "Permanent failed edit",
  });
  for (let frame = 0; frame < 240; frame++) {
    const state = await snapshot();
    if (
      state.operations.find((item) => item.command.operationId === parent.operationId)?.status ===
      "retry-failed"
    )
      break;
    await new Promise(requestAnimationFrame);
  }
  const follower = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "Comment waiting behind failed edit",
  });
  await githubWrites.snapshot(scope);
  await wait(
    () =>
      githubWrites
        .getState(scope)
        .operations.find((item) => item.command.operationId === follower.operationId)
        ?.blockedByOperationId === parent.operationId,
    "FIFO blocker hook not present",
  );
  const card = () =>
    document.querySelector<HTMLElement>(
      `[data-github-comment-key="local:issue-comment:${follower.operationId}"]`,
    )!;
  await wait(
    () => !!card()?.querySelector("[data-github-sync-status]"),
    "Follower date/status missing",
  );
  const status = card().querySelector<HTMLElement>("[data-github-sync-status]")!;
  check(
    status.dataset.githubSyncStatus === "blocked" &&
      getComputedStyle(status.querySelector("svg")!).animationName !== "spin",
    "Blocked follower falsely displays active sync spinner",
  );
  status.querySelector<HTMLButtonElement>("button")!.click();
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (entry) => entry.textContent?.trim() === "Waiting for earlier action",
      ),
    "Follower details cannot reveal its blocker",
  );
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.trim() === "Waiting for earlier action")!
    .click();
  const blocker = () =>
    [...document.querySelectorAll<HTMLElement>(`[data-operation-id="${parent.operationId}"]`)].find(
      (entry) => entry.querySelector('[role="alert"]'),
    );
  await wait(() => !!blocker(), "Blocker error not revealed");
  check(
    !!blocker()!.querySelector('[role="alert"]')?.textContent,
    "Earlier rejection has no useful error",
  );
  const cancel = [...blocker()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Cancel queued write",
  );
  check(cancel, "Earlier failed action has no safe cancellation control");
  cancel!.click();
  let final = await snapshot();
  for (let frame = 0; frame < 240; frame++) {
    final = await snapshot();
    if (
      final.operations.find((item) => item.command.operationId === follower.operationId)?.status ===
      "synced"
    )
      break;
    await new Promise(requestAnimationFrame);
  }
  check(
    final.operations.find((item) => item.command.operationId === parent.operationId)?.status ===
      "cancelled",
    "Safe cancellation did not cancel failed blocker",
  );
  check(
    final.operations.find((item) => item.command.operationId === follower.operationId)?.status ===
      "synced",
    "Cancelling blocker did not unblock actual mock worker",
  );
  const remote = (await window.browserGithubActions({ kind: "state" })) as {
    calls: { method: string; path: string }[];
  };
  check(
    remote.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/issues/1/comments"),
    ).length === 1,
    "Follower dispatched more than once",
  );
  return { passed: 7 };
}
