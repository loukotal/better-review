import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubWriteAction } from "@better-review/shared";

import type { BrowserGithubOperation, BrowserGithubState } from "./github-outbox";
import { createGithubSyncRefreshCoordinator } from "./github-sync-refresh";

const scope = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
} as const;
function action(kind: GithubWriteAction["kind"]): GithubWriteAction {
  const target = { source: "remote", kind: "issue-comment", id: 1 } as const;
  switch (kind) {
    case "approve":
      return { kind, expectedHeadSha: "a".repeat(40), body: "" };
    case "request-changes":
    case "review-comment":
      return { kind, expectedHeadSha: "a".repeat(40), body: "Review" };
    case "resolve-thread":
    case "unresolve-thread":
      return { kind, target: { source: "remote", kind: "thread", nodeId: "thread" } };
    case "edit-comment":
      return { kind, target, body: "new", expectedBody: "old" };
    case "delete-comment":
      return { kind, target, expectedBody: "old" };
    case "issue-comment":
      return { kind, body: "retained" };
    default:
      throw new Error(`Unsupported fixture action ${kind}`);
  }
}
function state(
  status: BrowserGithubOperation["status"],
  kinds: GithubWriteAction["kind"][] = ["resolve-thread"],
): BrowserGithubState {
  return {
    scope,
    revision: 1,
    pendingCount: status === "synced" ? 0 : kinds.length,
    busy: false,
    pendingSaving: 0,
    operations: kinds.map((kind, index) => ({
      status,
      backendOwned: true,
      command: {
        scope,
        expectedActor: { id: 1, login: "owner" },
        operationId: `operation-${index}`,
        dependencies: [],
        action: action(kind),
      },
    })),
  };
}
function clock() {
  let pending: (() => Promise<void>) | undefined;
  return {
    schedule(work: () => Promise<void>) {
      pending = work;
      return () => {
        if (pending === work) pending = undefined;
      };
    },
    async flush() {
      const work = pending;
      pending = undefined;
      await work?.();
    },
    hasWork: () => !!pending,
  };
}

test("global observer retains pending evidence across navigation, fences review reads once and batches scopes", async () => {
  const timer = clock();
  const extras: string[] = [],
    details: string[] = [];
  let lists = 0,
    fences = 0;
  const refresh = createGithubSyncRefreshCoordinator({
    global: true,
    schedule: timer.schedule,
    refreshPr: async (url) => {
      extras.push(url);
    },
    refreshDetail: async (url) => {
      details.push(url);
    },
    refreshList: async () => {
      lists++;
    },
    onReviewCompletion: () => {
      fences++;
    },
  });
  const first = state("queued", ["approve"]);
  const other = {
    ...state("queued", ["issue-comment"]),
    scope: { ...scope, number: 2, url: scope.url.replace("/1", "/2") },
  };
  refresh.observe(first);
  refresh.observe(other);
  refresh.observe(undefined);
  refresh.observe({
    ...first,
    operations: first.operations.map((item) => ({ ...item, status: "synced" })),
  });
  const complete = {
    ...other,
    operations: other.operations.map((item) => ({ ...item, status: "synced" as const })),
  };
  refresh.observe(complete);
  refresh.observe(complete);
  assert.equal(fences, 1, "Fence must run at observation, before batched network work");
  await timer.flush();
  assert.deepEqual(extras, [scope.url, other.scope.url]);
  assert.deepEqual(details, [scope.url]);
  assert.equal(lists, 1);
  refresh.dispose();
});

test("batched comment/thread completions refresh extras once, never the PR list; repeated snapshots do nothing", async () => {
  const timer = clock(),
    reads: string[] = [];
  let lists = 0;
  const refresh = createGithubSyncRefreshCoordinator({
    schedule: timer.schedule,
    refreshPr: async (url) => {
      reads.push(url);
    },
    refreshList: async () => {
      lists++;
    },
  });
  const kinds: GithubWriteAction["kind"][] = [
    "resolve-thread",
    "issue-comment",
    "edit-comment",
    "delete-comment",
    "unresolve-thread",
  ];
  refresh.observe(state("queued", kinds));
  const completed = state("queued", kinds);
  for (const operation of completed.operations) {
    operation.status = "synced";
    refresh.observe(completed);
  }
  await timer.flush();
  assert.deepEqual(reads, [scope.url]);
  assert.equal(lists, 0);
  for (let n = 0; n < 20; n++) refresh.observe(completed);
  assert.equal(timer.hasWork(), false);
});

test("synced history is a baseline on mount/remount, not an invalidation replay", async () => {
  let calls = 0;
  for (let mount = 0; mount < 2; mount++) {
    const timer = clock();
    const refresh = createGithubSyncRefreshCoordinator({
      schedule: timer.schedule,
      refreshPr: async () => {
        calls++;
      },
      refreshList: async () => {
        calls++;
      },
    });
    refresh.observe(state("synced", ["approve", "issue-comment", "resolve-thread"]));
    await timer.flush();
    refresh.dispose();
  }
  assert.equal(calls, 0);
});

test("review actions coalesce detail/list refreshes and ignore history and repeated snapshots", async () => {
  const timer = clock();
  let prs = 0,
    lists = 0,
    details = 0;
  const refresh = createGithubSyncRefreshCoordinator({
    schedule: timer.schedule,
    refreshPr: async () => {
      prs++;
    },
    refreshList: async () => {
      lists++;
    },
    refreshDetail: async () => {
      details++;
    },
  });
  const kinds = ["approve", "request-changes", "review-comment"] as const;
  refresh.observe(state("synced", [...kinds]));
  await timer.flush();
  assert.equal(prs + lists, 0);
  refresh.observe(state("queued", [...kinds]));
  refresh.observe(state("synced", [...kinds]));
  await timer.flush();
  assert.equal(prs, 1);
  assert.equal(lists, 1);
  assert.equal(details, 1);
  refresh.observe(state("synced", [...kinds]));
  await timer.flush();
  assert.equal(prs + lists, 2);
  refresh.dispose();
});

test("approval completion batch refreshes list once; read failure cannot replay completion or resend", async () => {
  const timer = clock();
  let reads = 0,
    lists = 0;
  const refresh = createGithubSyncRefreshCoordinator({
    schedule: timer.schedule,
    refreshPr: async () => {
      reads++;
    },
    refreshList: async () => {
      lists++;
      throw new Error("Offline list");
    },
  });
  const kinds: GithubWriteAction["kind"][] = ["approve", "approve", "issue-comment"];
  refresh.observe(state("queued", kinds));
  refresh.observe(state("synced", kinds));
  await timer.flush();
  for (let n = 0; n < 10; n++) refresh.observe(state("synced", kinds));
  await timer.flush();
  assert.equal(reads, 1);
  assert.equal(lists, 1);
});

test("navigation drops stale queued PR reads and disposal cancels scheduled invalidations", async () => {
  const timer = clock();
  let reads = 0;
  const refresh = createGithubSyncRefreshCoordinator({
    schedule: timer.schedule,
    refreshPr: async () => {
      reads++;
    },
    refreshList: async () => {},
  });
  refresh.observe(state("queued"));
  refresh.observe(state("synced"));
  refresh.observe(undefined);
  await timer.flush();
  assert.equal(reads, 0);
  refresh.observe(state("queued", ["issue-comment", "issue-comment"]));
  refresh.observe(state("synced", ["issue-comment", "issue-comment"]));
  refresh.dispose();
  await timer.flush();
  assert.equal(reads, 0);
});

test("a slow background approval-list refresh cannot block later comment extras", async () => {
  const timer = clock();
  let reads = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = createGithubSyncRefreshCoordinator({
    schedule: timer.schedule,
    refreshPr: async () => {
      reads++;
    },
    refreshList: () => gate,
  });
  refresh.observe(state("queued", ["approve"]));
  refresh.observe(state("synced", ["approve"]));
  await timer.flush();
  const next = state("queued", ["approve", "issue-comment"]);
  next.operations[0].status = "synced";
  refresh.observe(next);
  next.operations[1].status = "synced";
  refresh.observe(next);
  await timer.flush();
  assert.equal(reads, 2);
  release();
  refresh.dispose();
});
