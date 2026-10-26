import {
  isGithubOutboxCommand,
  isGithubOutboxBatchControl,
  type GithubOutboxOperation,
  type PrDetail,
} from "@better-review/shared";

import { beginGithubCommentRead, acceptGithubDetailRead } from "../lib/github-comment-views";
import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { queryClient, queryKeys } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
function detail(draft: boolean, canSetDraft = true): PrDetail {
  const value = prDetailFixture(url);
  value.fetchedAt = new Date().toISOString();
  if (value.metadata.status === "available") value.metadata.data.draft = draft;
  value.stageCapabilities = {
    status: "available",
    complete: true,
    data: { canSetDraft, reason: canSetDraft ? null : "Permission denied" },
  };
  return value;
}
function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (value) => value.textContent?.trim() === name,
  );
}
export async function testOverviewDraftDesiredStateAndGithubLinkInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const scope = githubPrScope(url);
  const operations: GithubOutboxOperation[] = [];
  const refreshes: Array<(value: PrDetail) => void> = [];
  let listRefreshes = 0;
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail(true),
      "prDetail.refresh": () => new Promise<PrDetail>((resolve) => refreshes.push(resolve)),
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid command");
        const operation: GithubOutboxOperation = {
          command: input,
          status: "queued",
          revision: 1,
          sequence: operations.length + 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        operations.push(operation);
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operations.reduce((sum, item) => sum + item.revision, 0),
        operations: structuredClone(operations),
      }),
      "prs.refresh": () => {
        listRefreshes++;
        return { prs: [], fetchedAt: Date.now() };
      },
    },
  });
  await refreshGithubActor();
  await wait(
    () => button("Ready for review")?.disabled === false,
    "Ready control did not become available",
  );
  const link = document.querySelector<HTMLAnchorElement>('a[aria-label="Open on GitHub"]');
  check(
    link?.href === url &&
      link.target === "_blank" &&
      link.relList.contains("noopener") &&
      link.relList.contains("noreferrer"),
    "GitHub link must target exact PR securely in a new tab",
  );
  check(!!link?.querySelector("svg"), "GitHub link must use external icon");
  const stale = beginGithubCommentRead(url);
  button("Ready for review")!.click();
  await wait(() => operations.length === 1, "Ready intent not admitted");
  check(
    operations[0]!.command.action.kind === "set-draft" &&
      operations[0]!.command.action.draft === false &&
      operations[0]!.command.action.pullRequestId === "PR_fixture",
    "Click must freeze explicit PR-scoped desired state",
  );
  check(!("expectedHeadSha" in operations[0]!.command.action), "Stage must not bind a head");
  await githubWrites.snapshot(scope);
  check(button("Ready for review")?.disabled, "Pending stage must block another intent");
  operations[0]!.status = "uncertain";
  operations[0]!.revision++;
  await githubWrites.snapshot(scope);
  check(button("Ready for review")?.disabled, "Uncertain stage must not allow another command");
  check(
    !document.body.textContent?.includes("GitHub confirmed."),
    "Uncertain stage must not claim success",
  );
  button("Checks")!.click();
  await wait(() => !document.querySelector("[data-pr-overview]"), "Checks did not navigate");
  operations[0]!.status = "synced";
  operations[0]!.revision++;
  operations[0]!.result = { kind: "pull-request-draft", nodeId: "PR_fixture", url, draft: false };
  await githubWrites.snapshot(scope);
  await wait(
    () => refreshes.length === 1 && listRefreshes > 0,
    "Global completion did not refresh detail and list after navigation",
  );
  button("Overview")!.click();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Overview did not return");
  check(
    button("Ready for review")?.disabled,
    "Confirmed receipt must survive navigation and block stale action",
  );
  check(
    document.body.textContent?.includes("GitHub confirmed."),
    "Confirmed receipt missing before refresh",
  );
  const old = detail(true);
  acceptGithubDetailRead(stale, old);
  queryClient.setQueryData(queryKeys.pr.detail(url), old);
  await new Promise(requestAnimationFrame);
  check(button("Ready for review")?.disabled, "Pre-confirmation read must not retire receipt");
  refreshes.shift()!(detail(false));
  await wait(
    () => button("Convert to draft")?.disabled === false,
    "Fresh details must enable reverse direction",
  );
  button("Convert to draft")!.click();
  await wait(() => operations.length === 2, "Draft intent not admitted");
  check(
    operations[1]!.command.action.kind === "set-draft" &&
      operations[1]!.command.action.draft === true,
    "Reverse click must freeze draft=true",
  );
  await githubWrites.snapshot(scope);
  operations[1]!.status = "synced";
  operations[1]!.revision++;
  operations[1]!.result = { kind: "pull-request-draft", nodeId: "PR_fixture", url, draft: true };
  await githubWrites.snapshot(scope);
  await wait(() => refreshes.length === 1, "Reverse stage completion did not refresh detail");
  check(
    button("Converted to draft")?.disabled,
    "Receipt must immediately confirm draft without optimistic enqueue",
  );
  const failedRead = detail(true);
  failedRead.metadata = { status: "unavailable", message: "Offline metadata" };
  failedRead.stageCapabilities = { status: "unavailable", message: "Offline permissions" };
  refreshes.shift()!(failedRead);
  await wait(
    () => document.body.textContent?.includes("Offline metadata") ?? false,
    "Refresh failure must remain separate from confirmed write",
  );
  check(
    button("Converted to draft")?.disabled &&
      document.body.textContent?.includes("GitHub confirmed."),
    "Failed refresh must retain confirmed receipt, never reoffer stale action",
  );
  button("Refresh details")!.click();
  await wait(() => refreshes.length === 1, "Explicit refresh did not start");
  refreshes.shift()!(detail(true, false));
  await wait(() => !!button("Ready for review"), "Refreshed draft metadata not shown");
  check(button("Ready for review")?.disabled, "Changed permissions must disable reverse action");
  const later = detail(false);
  later.stageCapabilities = { status: "unavailable", message: "Permission read failed" };
  queryClient.setQueryData(queryKeys.pr.detail(url), later);
  await new Promise(requestAnimationFrame);
  check(
    button("Convert to draft")?.disabled && !button("Converted to draft"),
    "Settled receipt must never resurrect over later metadata when permissions become unavailable",
  );
  check(operations.length === 2, "Reads/navigation must never enqueue another write");
  dispose();
  return result();
}

export async function testOverviewDraftRequiresFreshActorCapabilityInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const initial = detail(false);
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: { "prDetail.get": () => initial },
  });
  await refreshGithubActor();
  await wait(
    () => button("Convert to draft")?.disabled === false,
    "Initial verified capability unavailable",
  );
  const wrongActor = detail(false);
  if (wrongActor.actor.status === "available") wrongActor.actor.data.databaseId = 99;
  queryClient.setQueryData(queryKeys.pr.detail(url), wrongActor);
  await wait(
    () => button("Convert to draft")?.disabled === true,
    "Different numeric actor must disable stage",
  );
  const cached = detail(false);
  delete cached.stageCapabilities;
  queryClient.setQueryData(queryKeys.pr.detail(url), cached);
  await new Promise(requestAnimationFrame);
  check(button("Convert to draft")?.disabled, "Cached detail without capability must fail closed");
  const incomplete = detail(false);
  if (incomplete.stageCapabilities?.status === "available")
    incomplete.stageCapabilities.complete = false;
  queryClient.setQueryData(queryKeys.pr.detail(url), incomplete);
  await new Promise(requestAnimationFrame);
  check(button("Convert to draft")?.disabled, "Incomplete capability must fail closed");
  const wrongPr = detail(false);
  wrongPr.url = url.replace("/1", "/2");
  queryClient.setQueryData(queryKeys.pr.detail(url), wrongPr);
  await new Promise(requestAnimationFrame);
  check(
    button("Convert to draft")?.disabled,
    "Another PR's detail must never authorize this control",
  );
  const unavailable = detail(false);
  unavailable.metadata = { status: "unavailable", message: "Offline" };
  queryClient.setQueryData(queryKeys.pr.detail(url), unavailable);
  await new Promise(requestAnimationFrame);
  check(button("Convert to draft")?.disabled, "Retained display metadata must not authorize stage");
  dispose();
  return result();
}

export async function testOverviewDraftHydratesPendingAndIgnoresSyncedHistoryInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const scope = githubPrScope(url);
  const operation: GithubOutboxOperation = {
    command: {
      operationId: "11111111-1111-4111-8111-111111111111",
      scope,
      expectedActor: { id: 42, login: "browser-fixture" },
      action: { kind: "set-draft", pullRequestId: "PR_fixture", draft: true },
      dependencies: [],
    },
    status: "synced",
    revision: 2,
    sequence: 1,
    attempts: 1,
    retryMode: "automatic",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    result: { kind: "pull-request-draft", nodeId: "PR_fixture", url, draft: true },
  };
  let enqueues = 0;
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail(false),
      "prDetail.refresh": () => detail(false),
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operation.revision,
        operations: [structuredClone(operation)],
      }),
      "githubOutbox.enqueue": () => {
        enqueues++;
        throw new Error("Hydration cannot enqueue");
      },
    },
  });
  await refreshGithubActor();
  await githubWrites.recover(scope);
  await wait(
    () => button("Convert to draft")?.disabled === false,
    "Synced historical draft bit must not override current ready metadata",
  );
  check(
    !document.body.textContent?.includes("GitHub confirmed."),
    "First-seen synced history cannot create a receipt bridge",
  );
  // A later backend-admitted command models a reloaded browser discovering pending work.
  operation.command.operationId = "22222222-2222-4222-8222-222222222222";
  operation.status = "queued";
  operation.sequence++;
  operation.revision++;
  delete operation.result;
  await githubWrites.snapshot(scope);
  await wait(
    () => button("Convert to draft")?.disabled === true,
    "Hydrated pending stage must block conflicting Overview writes",
  );
  check(
    !document.body.textContent?.includes("GitHub confirmed."),
    "Hydrated pending intent cannot claim success",
  );
  check(enqueues === 0, "Hydration must never recreate a write");
  dispose();
  return result();
}

export async function testOverviewDraftClearArchivesUnknownAndAllowsFreshReverseInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const scope = githubPrScope(url);
  const operations: GithubOutboxOperation[] = [];
  const submittedIds: string[] = [];
  let clears = 0,
    refreshes = 0;
  const dispose = await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail(false),
      "prDetail.refresh": () => {
        refreshes++;
        return detail(true);
      },
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid stage command");
        submittedIds.push(input.operationId);
        const operation: GithubOutboxOperation = {
          command: input,
          status: "queued",
          revision: 1,
          sequence: operations.length + 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        operations.push(operation);
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operations.reduce((sum, item) => sum + item.revision, 0),
        operations: structuredClone(operations),
      }),
      "githubOutbox.batchControl": (input) => {
        if (!isGithubOutboxBatchControl(input) || input.kind !== "clear")
          throw new Error("Only explicit Clear is allowed");
        check(
          input.operations.length === 1 &&
            input.operations[0]?.operationId === operations[0]?.command.operationId,
          "Clear must target the original uncertain command",
        );
        clears++;
        const original = operations[0]!;
        original.archivedAt = new Date().toISOString();
        original.revision++;
        return {
          outcome: "applied",
          operations: [structuredClone(original)],
          requiresConfirmation: [],
          skipped: [],
          aliases: {},
        };
      },
      "githubOutbox.control": () => {
        throw new Error("Archived uncertainty must never be retried implicitly");
      },
    },
  });
  await refreshGithubActor();
  await wait(
    () => button("Convert to draft")?.disabled === false,
    "Verified ready PR must allow conversion",
  );
  button("Convert to draft")!.click();
  await wait(() => operations.length === 1, "Conversion was not admitted");
  const original = operations[0]!;
  check(
    original.command.action.kind === "set-draft" && original.command.action.draft === true,
    "Original conversion must capture draft=true",
  );
  original.status = "uncertain";
  original.attempts = 1;
  original.revision++;
  await githubWrites.snapshot(scope);
  await wait(
    () => button("Convert to draft")?.disabled === true,
    "Active unknown delivery must block another stage intent",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => !!document.querySelector('[data-github-queue-batch="clear"]'),
    "Global Clear control missing",
  );
  await window.clickBrowserQueueBatch("clear");
  await wait(
    () => !!original.archivedAt && githubWrites.getState(scope).pendingCount === 0,
    "Clear must remove unknown delivery from the active queue",
  );
  check(
    original.status === "uncertain" && original.attempts === 1 && clears === 1,
    "Clear must preserve unknown delivery history without another attempt",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  button("Refresh details")!.click();
  await wait(
    () => refreshes === 1 && !!button("Ready for review"),
    "Fresh draft detail did not load after Clear",
  );
  await wait(
    () => button("Ready for review")?.disabled === false,
    "Archived unknown delivery must not block the fresh reverse action",
  );
  button("Ready for review")!.click();
  await wait(() => operations.length === 2, "Fresh reverse intent was not admitted");
  const reverse = operations[1]!;
  check(
    reverse.command.action.kind === "set-draft" &&
      reverse.command.action.draft === false &&
      reverse.command.action.pullRequestId === "PR_fixture",
    "Reverse must enqueue draft=false for the same verified PR node",
  );
  check(
    reverse.command.operationId !== original.command.operationId,
    "Reverse must be a new explicit intent",
  );
  for (let n = 0; n < 3; n++) await githubWrites.snapshot(scope);
  check(
    submittedIds.length === 2 &&
      submittedIds.filter((id) => id === original.command.operationId).length === 1 &&
      original.status === "uncertain" &&
      !!original.archivedAt &&
      original.attempts === 1,
    "Refresh and reverse must never blindly resend or clear the original uncertain operation",
  );
  dispose();
  return result();
}
