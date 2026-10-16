import type { GithubOutboxCommand, GithubOutboxSnapshot, PRComment } from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { api, queryClient, queryKeys } from "../lib/query";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    browserGithubActions(request: { kind: string; input?: unknown }): Promise<unknown>;
  }
}

/** Actual App buttons → IndexedDB → RPC → SQLite worker → production HTTP adapter. */
export async function testAppGithubDeleteResolveInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url);
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
  let remoteComments = [comment];
  let extrasReads = 0,
    listRefreshes = 0;
  await mountAppFixture({
    extras: { comments: remoteComments, issueComments: [], status: null },
    procedures: {
      "githubOutbox.enqueue": rpc("enqueue"),
      "githubOutbox.snapshot": rpc("snapshot"),
      "githubOutbox.heartbeat": rpc("heartbeat"),
      "githubOutbox.control": rpc("control"),
      "pr.extras": () => {
        extrasReads++;
        return { comments: remoteComments, issueComments: [], status: null };
      },
      "prs.refresh": () => {
        listRefreshes++;
        return { prs: [], fetchedAt: Date.now() };
      },
    },
  });
  await refreshGithubActor();
  const card = () =>
    document.querySelector<HTMLElement>('[data-github-comment-key="remote:review-comment:20"]');
  const button = (label: string) =>
    [...card()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
  await wait(() => !!card() && !!button("Resolve"), "App resolve button not reachable");
  const latest = async () =>
    (await window.browserGithubActions({ kind: "snapshot" })) as GithubOutboxSnapshot;
  const sync = async (kind: GithubOutboxCommand["action"]["kind"], expected = "synced") => {
    let snapshot = await latest();
    for (let frame = 0; frame < 180; frame++) {
      snapshot = await latest();
      const item = snapshot.operations.at(-1);
      if (item?.command.action.kind === kind && item.status === expected) break;
      await new Promise(requestAnimationFrame);
    }
    const item = snapshot.operations.at(-1);
    check(
      item?.command.action.kind === kind && item.status === expected,
      `${kind} failed: ${JSON.stringify(item)}`,
    );
    await githubWrites.snapshot(scope);
    return item!;
  };
  const beforeToggles = { extrasReads, listRefreshes };
  for (const label of ["Resolve", "Unresolve", "Resolve", "Unresolve"]) {
    button(label)!.click();
    const item = await sync(label === "Resolve" ? "resolve-thread" : "unresolve-thread");
    check(
      "target" in item.command.action &&
        item.command.action.target.source === "remote" &&
        item.command.action.target.kind === "thread" &&
        item.command.action.target.nodeId === "actual-thread",
      "Thread action used comment node ID",
    );
    await wait(
      () => !!button(label === "Resolve" ? "Unresolve" : "Resolve"),
      "Thread toggle did not reflect confirmed state",
    );
  }
  for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
  const toggleRefreshes = {
    list: listRefreshes - beforeToggles.listRefreshes,
    extras: extrasReads - beforeToggles.extrasReads,
  };
  check(
    listRefreshes === beforeToggles.listRefreshes,
    `Four thread toggles caused ${listRefreshes - beforeToggles.listRefreshes} full PR-list refreshes and ${extrasReads - beforeToggles.extrasReads} extras reads`,
  );
  check(
    toggleRefreshes.extras >= 1 && toggleRefreshes.extras <= 4,
    `Thread refresh fanout is unbounded: ${JSON.stringify(toggleRefreshes)}`,
  );
  const readsAfterToggles = extrasReads;
  for (let n = 0; n < 4; n++) await githubWrites.snapshot(scope);
  for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
  check(
    extrasReads === readsAfterToggles && listRefreshes === beforeToggles.listRefreshes,
    "Identical real-worker snapshots repeated refreshes",
  );
  const originalConfirm = window.confirm;
  await window.browserGithubActions({ kind: "fail-delete", input: true });
  window.confirm = () => true;
  try {
    button("Delete")!.click();
  } finally {
    window.confirm = originalConfirm;
  }
  await sync("delete-comment", "retry-failed");
  await wait(
    () => !!card()?.querySelector('[data-github-sync-status="retry-failed"] button'),
    "Failed delete lacks warning icon",
  );
  check(
    card()!.textContent?.includes("action fixture body"),
    "Failed delete discarded recoverable content",
  );
  check(
    !document.querySelector("[popover]:popover-open"),
    "Failure opened recovery UI automatically",
  );
  card()!.querySelector<HTMLButtonElement>("[data-github-sync-status] button")!.click();
  await wait(
    () => !!document.querySelector("[popover]:popover-open [data-operation-id]"),
    "Failure detail did not open",
  );
  const retry = [
    ...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button"),
  ].find((item) => item.textContent?.trim() === "Retry");
  check(!!retry, "Proven-not-applied blocked failure hid explicit Retry");
  await window.browserGithubActions({ kind: "fail-delete", input: false });
  retry!.click();
  await sync("delete-comment");
  await wait(() => card()?.dataset.commentDeleted === "true", "Delete did not produce tombstone");
  check(!card()?.querySelector("[data-comment-body]"), "Delete left interactive body visible");
  remoteComments = [];
  queryClient.setQueryData(queryKeys.pr.extras(url), await api.fetchPrExtras(url));
  await wait(() => !card(), "Confirmed deletion survived fresh remote absence");
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  const creation = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "new comment then delete",
  });
  await sync("issue-comment");
  const localCard = () =>
    document.querySelector<HTMLElement>(
      `[data-github-comment-key="local:issue-comment:${creation.operationId}"]`,
    );
  await wait(() => !!localCard(), "Confirmed local creation did not render");
  window.confirm = () => true;
  try {
    [...localCard()!.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.trim() === "Delete")!
      .click();
  } finally {
    window.confirm = originalConfirm;
  }
  const removedLocal = await sync("delete-comment");
  check(
    removedLocal.command.action.kind === "delete-comment" &&
      removedLocal.command.action.target.source === "local" &&
      removedLocal.command.action.target.operationId === creation.operationId &&
      removedLocal.command.action.expectedBody === "new comment then delete",
    "Local deletion lost stable target alias or clean baseline",
  );
  check(
    removedLocal.result?.kind === "deleted" && removedLocal.result.target.id === 30,
    "Worker did not resolve local alias to actual remote deletion target",
  );
  queryClient.setQueryData(queryKeys.pr.extras(url), await api.fetchPrExtras(url));
  await wait(() => !localCard(), "Confirmed local deletion resurrected creation overlay");
  const state = (await window.browserGithubActions({ kind: "state" })) as {
    deleted: boolean;
    resolved: boolean;
    calls: { method: string; path: string; payload?: { query?: string } }[];
  };
  check(state.deleted && !state.resolved, "Remote fixture state did not change");
  check(
    state.calls.filter((item) => item.method === "DELETE").length === 3,
    "Delete was missing or duplicated",
  );
  check(
    state.calls.filter(
      (item) => item.path === "/graphql" && item.payload?.query?.includes("mutation"),
    ).length === 4,
    "Thread operations were missing or duplicated at HTTP adapter",
  );
  check(
    githubWrites.getState(scope).pendingCount === 0,
    "History regression requires zero pending writes",
  );
  const recovery = document.querySelector<HTMLButtonElement>(
    'button[aria-label="GitHub saved content"]',
  );
  check(!!recovery && !recovery.innerText.trim(), "Retired deletion lost icon-only history access");
  recovery!.click();
  await wait(
    () =>
      !!document.querySelector(
        `[popover]:popover-open [data-github-recovery-operation="${removedLocal.command.operationId}"]`,
      ),
    "Retired deletion history did not open",
  );
  const history = document.querySelector<HTMLDetailsElement>(
    `[data-github-recovery-operation="${removedLocal.command.operationId}"]`,
  )!;
  (history.parentElement as HTMLDetailsElement).open = true;
  history.open = true;
  check(
    history.innerText.includes("new comment then delete"),
    "Confirmed deletion lost original body after tombstone retirement",
  );
  check(!history.querySelector("button"), "Retired deletion history exposed a resend action");
  const afterRecovery = (await window.browserGithubActions({ kind: "state" })) as typeof state;
  check(
    afterRecovery.calls.length === state.calls.length,
    "Read-only deletion recovery performed HTTP requests",
  );
  check(
    listRefreshes === beforeToggles.listRefreshes,
    "Comment creation/deletion forced a full PR-list refresh",
  );
  return { passed, toggleRefreshes };
}
