import {
  isGithubOutboxCommand,
  type GithubOutboxOperation,
  type PrStatus,
  type ReviewDecision,
  type SearchedPr,
} from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { fetchPrExtras, queryClient, queryKeys } from "../lib/query";
import { mountAppFixture } from "./mount-app";

const url = "https://github.com/browser-fixture/isolated/pull/1";
declare global {
  interface Window {
    decodeBrowserGithubReviewStatus(
      value: unknown,
      expectedHeadSha: string,
    ): Promise<Pick<PrStatus, "reviewDecision" | "viewerApproval" | "checks">>;
  }
}
const status = (reviewDecision: ReviewDecision): PrStatus => ({
  reviewDecision,
  state: "open",
  draft: false,
  mergeable: true,
  title: "Externally reviewed PR",
  body: "",
  author: "another-user",
  url,
  headRef: "feature",
  checks: [],
});
const pr = (reviewDecision: ReviewDecision): SearchedPr => ({
  reviewDecision,
  number: 1,
  headRefOid: "a".repeat(40),
  title: "Externally reviewed PR",
  url,
  repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
  author: { login: "another-user" },
  createdAt: "2026-01-01T00:00:00Z",
  isDraft: false,
  myReviewState: null,
  isAuthor: false,
  reviewRequested: true,
  additions: 1,
  deletions: 1,
  ciStatus: null,
});
const badge = () =>
  document.querySelector('span[title="GitHub\'s current overall review decision is Approved."]');
async function wait(predicate: () => boolean, message: string) {
  for (let i = 0; i < 180 && !predicate(); i++) await new Promise(requestAnimationFrame);
  if (!predicate()) throw new Error(message);
}

export async function testRemoteApprovalInActualAppAndListInBrowser() {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  let decision: ReviewDecision = "APPROVED";
  const list = () => ({ prs: [pr(decision)], fetchedAt: Date.now() });
  await mountAppFixture({
    extras: { status: status(decision), comments: [], issueComments: [] },
    procedures: {
      "prs.list": list,
      "prs.refresh": list,
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({}),
    },
  });
  await wait(() => !!badge(), "Remote approval missing from actual App header without outbox");
  check(badge()?.textContent?.trim() === "Approved", "Approval badge lacks text");
  check(!!badge()?.querySelector("svg"), "Approval badge lacks check icon");
  check(
    !document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')?.disabled,
    "Another reviewer's aggregate approval disabled your approval button",
  );
  document.querySelector<HTMLAnchorElement>('a[aria-label="Better Review home"]')!.click();
  await wait(() => location.pathname === "/" && !!badge(), "List lost external aggregate approval");
  check(!!badge(), "Remote-approved list row missing badge without own approval");
  for (const next of ["CHANGES_REQUESTED", "REVIEW_REQUIRED", null, "APPROVED"] as const) {
    decision = next;
    queryClient.setQueryData(queryKeys.prs.list, list());
    await wait(
      () => !!badge() === (next === "APPROVED"),
      `List retained incorrect approval for ${next}`,
    );
    passed++;
  }
  // Historical own approval must not turn a non-approved aggregate into Approved.
  queryClient.setQueryData(queryKeys.prs.list, {
    prs: [{ ...pr("REVIEW_REQUIRED"), myReviewState: "APPROVED" }],
    fetchedAt: Date.now(),
  });
  await wait(() => !badge(), "Historical own approval mislabeled aggregate decision");
  return { passed: passed + 1 };
}

export async function testApprovalHeaderDoesNotLeakAcrossCachedPrNavigationInBrowser() {
  const nextUrl = url.replace("/1", "/2");
  await mountAppFixture({
    extras: { status: status("APPROVED"), comments: [], issueComments: [] },
    procedures: {
      "prs.list": () => ({ prs: [pr("APPROVED"), { ...pr(null), url: nextUrl, number: 2 }] }),
    },
  });
  await wait(() => !!badge(), "Initial approved header missing");
  const core = queryClient.getQueryData(queryKeys.pr.core(url))!;
  queryClient.setQueryData(queryKeys.pr.core(nextUrl), core);
  queryClient.setQueryData(
    queryKeys.pr.diff(nextUrl),
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  );
  queryClient.setQueryData(queryKeys.pr.extras(nextUrl), {
    comments: [],
    issueComments: [],
    status: null,
  });
  await wait(() => !!document.querySelector('a[title^="Next:"]'), "Next PR link missing");
  document.querySelector<HTMLAnchorElement>('a[title^="Next:"]')!.click();
  await wait(() => location.search.includes("%2F2"), "Second PR did not load");
  await wait(() => !badge(), "Previous PR approval leaked into cached PR without status");
  return { passed: 2 };
}

export async function testPendingAndRefreshedApprovalDecisionsInBrowser() {
  const scope = githubPrScope(url),
    head = "a".repeat(40);
  let revision = 0;
  const operations: GithubOutboxOperation[] = [];
  let remoteStatus = status("REVIEW_REQUIRED");
  let holdRead = false;
  let releaseOldRead: (() => void) | undefined;
  let extrasReads = 0;
  let listReads = 0;
  const nextUrl = url.replace("/1", "/2");
  await mountAppFixture({
    extras: { status: remoteStatus, comments: [], issueComments: [] },
    procedures: {
      "prs.list": () => ({ prs: [pr(null), { ...pr(null), url: nextUrl, number: 2 }] }),
      "pr.extras": () => {
        extrasReads++;
        const data = { status: remoteStatus, comments: [], issueComments: [] };
        if (holdRead) {
          holdRead = false;
          return new Promise((resolve) => {
            releaseOldRead = () => resolve(data);
          });
        }
        return data;
      },
      "prs.refresh": () => {
        listReads++;
        return {
          prs: [pr(remoteStatus.reviewDecision ?? null)],
          fetchedAt: Date.now(),
        };
      },
      "githubOutbox.snapshot": () => ({ scope, revision, operations: structuredClone(operations) }),
      "githubOutbox.enqueue": (command) => {
        if (!isGithubOutboxCommand(command)) throw new Error("Invalid fixture command");
        const operation: GithubOutboxOperation = {
          command,
          status: "queued",
          revision: 1,
          sequence: operations.length + 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
        operations.push(operation);
        revision++;
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
    },
  });
  await refreshGithubActor();
  await githubWrites.snapshot(scope);
  holdRead = true;
  await queryClient.invalidateQueries({
    queryKey: queryKeys.pr.extras(url),
    exact: true,
    refetchType: "none",
  });
  const olderRead = fetchPrExtras(url).catch(() => undefined);
  await wait(() => !!releaseOldRead, "Older extras read did not start");
  const receipt = await queueGithubWrite(url, { kind: "approve", expectedHeadSha: head, body: "" });
  await githubWrites.recover(scope);
  await wait(
    () =>
      !!document.querySelector('button[aria-label="Approval pending"] [data-github-sync-status]'),
    "Queued approval lacks pending spinner",
  );
  if (badge()) throw new Error("Queued approval falsely shown as aggregate Approved");
  const complete = async (operationId: string) => {
    const operation = operations.find((item) => item.command.operationId === operationId)!;
    operation.status = "synced";
    operation.revision++;
    operation.result =
      operation.command.action.kind === "approve"
        ? { kind: "approval", id: operation.sequence, url, commitSha: head }
        : {
            kind: "issue-comment",
            id: operation.sequence,
            url,
            body: "refresh",
            author: operation.command.expectedActor,
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
          };
    revision++;
    await githubWrites.snapshot(scope);
  };
  remoteStatus = {
    ...status("APPROVED"),
    viewerApproval: { login: "browser-fixture", commitSha: head },
  };
  await complete(receipt.operationId);
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "You approved",
      ),
    "Confirmed current-head own approval missing",
  );
  await wait(() => !!badge(), "Confirmed aggregate approval missing");
  releaseOldRead!();
  await olderRead;
  for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
  if (
    queryClient.getQueryData<{ status: PrStatus }>(queryKeys.pr.extras(url))?.status
      .reviewDecision !== "APPROVED" ||
    queryClient.getQueryData<PrStatus>(queryKeys.pr.status(url))?.viewerApproval?.commitSha !== head
  )
    throw new Error("Older extras read rolled back confirmed shared approval caches");
  const core = queryClient.getQueryData(queryKeys.pr.core(url))!;
  queryClient.setQueryData(queryKeys.pr.core(nextUrl), core);
  queryClient.setQueryData(queryKeys.pr.extras(nextUrl), {
    status: null,
    comments: [],
    issueComments: [],
  });
  await wait(() => !!document.querySelector('a[title^="Next:"]'), "Next PR link missing");
  document.querySelector<HTMLAnchorElement>('a[title^="Next:"]')!.click();
  await wait(() => location.search.includes("%2F2") && !badge(), "Did not leave approved PR");
  // Same App instance, same five-minute caches.
  history.back();
  await wait(
    () => !!badge() && !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Returning to cached PR lost confirmed own/aggregate approval",
  );
  if (extrasReads !== 2 || listReads !== 1)
    throw new Error(`Approval batch repeated reads: extras=${extrasReads}, lists=${listReads}`);
  for (const next of ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null] as const) {
    remoteStatus = status(next);
    const refresh = await queueGithubWrite(url, { kind: "issue-comment", body: "refresh" });
    await githubWrites.recover(scope);
    await wait(
      () => operations.some((operation) => operation.command.operationId === refresh.operationId),
      "Refresh command was not admitted",
    );
    await complete(refresh.operationId);
    await wait(
      () => !!badge() === (next === "APPROVED"),
      `Refreshed detail decision incorrect for ${next}`,
    );
    if (
      next !== "APPROVED" &&
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "You approved",
      )
    )
      throw new Error("Dismissed own review persisted after authoritative refresh");
  }
  if (listReads !== 1) throw new Error("Comment refreshes triggered extra PR list refreshes");
  return { passed: 12 };
}

export async function testRequestedAgainApprovalEligibilityInBrowser() {
  const head = "a".repeat(40);
  const decode = async (reviewRequests: unknown, state = "APPROVED", commitSha = head) => ({
    ...status("APPROVED"),
    ...(await window.decodeBrowserGithubReviewStatus(
      {
        data: {
          viewer: { login: "browser-fixture" },
          repository: {
            pullRequest: {
              headRefOid: head,
              reviewDecision: "APPROVED",
              commits: { nodes: [] },
              latestReviews: {
                nodes: [
                  { author: { login: "browser-fixture" }, state, commit: { oid: commitSha } },
                ],
              },
              reviewRequests,
            },
          },
        },
      },
      head,
    )),
  });
  const empty = { nodes: [], pageInfo: { hasNextPage: false } };
  let remoteStatus = await decode(empty);
  let dispose = await mountAppFixture({
    extras: { status: remoteStatus, comments: [], issueComments: [] },
  });
  await refreshGithubActor();
  await wait(
    () => !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Current-head approval without renewed request should disable duplicate approval",
  );
  dispose();
  let passed = 1;
  const direct = {
    ...empty,
    nodes: [{ requestedReviewer: { __typename: "User", login: "browser-fixture" } }],
  };
  const team = { ...empty, nodes: [{ requestedReviewer: { __typename: "Team" } }] };
  for (const [requests, state, sha] of [
    [direct, "APPROVED", head],
    [empty, "DISMISSED", head],
    [empty, "APPROVED", "old-head"],
    [team, "APPROVED", head],
    [null, "APPROVED", head],
    [undefined, "APPROVED", head],
  ] as const) {
    remoteStatus = await decode(requests, state, sha);
    queryClient.removeQueries({ queryKey: queryKeys.pr.status(url), exact: true });
    dispose = await mountAppFixture({
      extras: { status: remoteStatus, comments: [], issueComments: [] },
    });
    await wait(
      () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
      "Renewed/dismissed/stale/unknown request state prevented another approval",
    );
    if (!badge() || document.querySelector('button[aria-label="You approved"]'))
      throw new Error("Eligibility changed aggregate approval or claimed historical own approval");
    passed++;
    dispose();
  }
  return { passed };
}
