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
  const sync = async (
    kind: GithubOutboxCommand["action"]["kind"],
    expected = "synced",
    afterSequence = 0,
  ) => {
    let snapshot = await latest();
    for (let frame = 0; frame < 180; frame++) {
      snapshot = await latest();
      const item = snapshot.operations.at(-1);
      if (
        item?.command.action.kind === kind &&
        item.status === expected &&
        item.sequence > afterSequence
      )
        break;
      await new Promise(requestAnimationFrame);
    }
    const item = snapshot.operations.at(-1);
    check(
      item?.command.action.kind === kind &&
        item.status === expected &&
        item.sequence > afterSequence,
      `${kind} failed: ${JSON.stringify(item)}`,
    );
    await githubWrites.snapshot(scope);
    return item!;
  };
  const beforeToggles = { extrasReads, listRefreshes };
  const editCard = async (element: HTMLElement, body: string, expected = "synced") => {
    const previousSequence = (await latest()).operations.at(-1)?.sequence ?? 0;
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.trim() === "Edit")!
      .click();
    await wait(() => !!element.querySelector("textarea"), "Edit textarea missing");
    const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
    await wait(() => !textarea.disabled, "Edit draft not loaded");
    textarea.value = body;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await wait(
      () => !element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      "Edit draft not ready",
    );
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.trim() === "Save locally")!
      .click();
    return sync("edit-comment", expected, previousSequence);
  };
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
  await window.browserGithubActions({ kind: "fail-edit", input: true });
  const failedEdit = await editCard(card()!, "review edit one", "retry-failed");
  check(
    failedEdit.error?.httpStatus === 422 &&
      !JSON.stringify(failedEdit.error).includes("private-response"),
    "Failed edit lost HTTP status or leaked response text",
  );
  card()!.querySelector<HTMLButtonElement>("[data-github-sync-status] button")!.click();
  await wait(
    () => !!document.querySelector("[popover]:popover-open [data-operation-id]"),
    "Failed edit detail missing",
  );
  const editDetail = document.querySelector<HTMLElement>("[popover]:popover-open")!;
  check(
    editDetail.textContent?.includes("HTTP 422") &&
      editDetail.textContent.includes("request format"),
    "Edit failure UI hid actionable safe diagnosis",
  );
  await window.browserGithubActions({ kind: "fail-edit", input: false });
  [...editDetail.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === "Retry")!
    .click();
  const retriedEdit = await sync("edit-comment");
  check(
    retriedEdit.command.operationId === failedEdit.command.operationId &&
      retriedEdit.attempts === 2,
    "Retry replaced durable intent or duplicated the edit",
  );
  editDetail.hidePopover();
  const restoredReview = await editCard(card()!, "action fixture body");
  check(
    restoredReview.result?.kind === "review-comment" &&
      restoredReview.result.body === "action fixture body",
    "Repeated review PATCH failed through App/IndexedDB/RPC/worker",
  );
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
  const inlineCreation = await queueGithubWrite(url, {
    kind: "inline-comment",
    body: "local review original",
    expectedHeadSha: "a".repeat(40),
    anchor: { path: "src/example.ts", side: "RIGHT", line: 9 },
  });
  await sync("inline-comment");
  const inlineCard = () =>
    document.querySelector<HTMLElement>(
      `[data-github-comment-key="local:review-comment:${inlineCreation.operationId}"]`,
    );
  await wait(() => !!inlineCard(), "Local review creation missing");
  for (const [index, body] of ["local review edit one", "local review edit two"].entries()) {
    const edited = await editCard(inlineCard()!, body);
    check(
      edited.command.action.kind === "edit-comment" &&
        edited.command.action.target.source === "local" &&
        edited.command.action.target.operationId === inlineCreation.operationId &&
        edited.command.action.expectedBody ===
          (index === 0 ? "local review original" : "local review edit one") &&
        edited.result?.kind === "review-comment" &&
        edited.result.id === 21 &&
        edited.result.body === body,
      "Local review edit lost alias, expectedBody or remote identity",
    );
  }
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
  for (const body of ["issue edit one", "new comment then delete"]) {
    const edited = await editCard(localCard()!, body);
    check(
      edited.command.action.kind === "edit-comment" &&
        edited.command.action.target.source === "local" &&
        edited.command.action.target.operationId === creation.operationId &&
        edited.result?.kind === "issue-comment" &&
        edited.result.body === body,
      "Repeated edit lost local alias or clean result",
    );
  }
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
    calls: {
      method: string;
      path: string;
      payload?: { query?: string; body?: string };
      headers: { accept: string; contentType: string; apiVersion: string; ifMatch: string | null };
    }[];
  };
  check(state.deleted && !state.resolved, "Remote fixture state did not change");
  const patches = state.calls.filter((item) => item.method === "PATCH");
  check(patches.length === 7, "Edit PATCH was missing or duplicated");
  check(
    patches.every(
      (item) =>
        item.headers.ifMatch === null &&
        item.headers.accept === "application/vnd.github+json" &&
        item.headers.contentType === "application/json" &&
        item.headers.apiVersion === "2022-11-28" &&
        Object.keys(item.payload!).join() === "body",
    ),
    "PATCH violated GitHub HTTP contract",
  );
  check(
    patches
      .filter((item) => item.path.includes("/issues/"))
      .every((item) =>
        item.payload?.body?.includes(`<!-- better-review:op:${creation.operationId} -->`),
      ),
    "Repeated issue edits dropped creation marker",
  );
  check(
    patches
      .filter((item) => item.path.endsWith("/21"))
      .every((item) =>
        item.payload?.body?.includes(`<!-- better-review:op:${inlineCreation.operationId} -->`),
      ),
    "Repeated local review edits dropped creation marker",
  );
  check(
    patches
      .filter((item) => item.path.endsWith("/20"))
      .every((item) =>
        item.payload?.body?.includes(
          "<!-- better-review:op:11111111-1111-4111-8111-111111111111 -->",
        ),
      ),
    "Repeated remote review edits dropped creation marker",
  );
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
