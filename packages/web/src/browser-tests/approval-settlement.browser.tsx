import { isGithubOutboxCommand, type GithubOutboxOperation } from "@better-review/shared";

import {
  acceptGithubDetailRead,
  acceptGithubCommentRead,
  beginGithubCommentRead,
  githubApprovalState,
} from "../lib/github-comment-views";
import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { queryClient, queryKeys } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

export async function testApprovalNeverReoffersWhileRefreshPendingInBrowser() {
  return approvalSettlement("changes");
}

export async function testOverviewApprovalNeverReoffersWhileRefreshPendingInBrowser() {
  return approvalSettlement("overview");
}

async function approvalSettlement(tab: "changes" | "overview") {
  const { check, wait, result } = createAssertions(3000);
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const head = "a".repeat(40);
  let operation: GithubOutboxOperation | undefined;
  let resolveExtras!: (value: unknown) => void;
  let refreshing = false;
  let resolveDetail!: (value: unknown) => void;
  let actor = { id: 42, login: "browser-fixture" };
  const dispose = await mountAppFixture({
    defaultTab: tab,
    waitForFiles: tab === "changes",
    procedures: {
      "githubOutbox.identity": () => ({ actor }),
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid command");
        operation = {
          command: input,
          status: "queued",
          revision: 1,
          sequence: 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operation?.revision ?? 0,
        operations: operation ? [structuredClone(operation)] : [],
      }),
      "pr.extras": () => {
        refreshing = true;
        return new Promise((resolve) => {
          resolveExtras = resolve;
        });
      },
      "prDetail.refresh": () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
    },
  });
  await refreshGithubActor();
  await wait(
    () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
    "Approval control not ready",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
  await wait(
    () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
    "Approval editor not ready",
  );
  document
    .querySelector<HTMLFormElement>('form[aria-label="Approve PR"]')!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await wait(() => operation?.status === "queued", "Approval not admitted");
  await githubWrites.recover(scope);
  await wait(
    () => !!document.querySelector('button[aria-label="Approval pending"]:disabled'),
    "Pending approval not shown",
  );
  const staleRead = beginGithubCommentRead(scope.url);
  operation!.status = "uncertain";
  operation!.revision++;
  await githubWrites.snapshot(scope);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Uncertain approval shown as success",
  );
  operation!.status = "retry-failed";
  operation!.revision++;
  await githubWrites.snapshot(scope);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Failed approval shown as success",
  );
  let reoffered = false;
  const observer = new MutationObserver(() => {
    reoffered ||= !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)');
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  operation!.status = "synced";
  operation!.revision++;
  operation!.result = { kind: "approval", id: 123, url: scope.url, commitSha: head };
  await githubWrites.snapshot(scope);
  await wait(() => refreshing, "Completion did not start refresh");
  check(
    !document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
    "Confirmed approval reoffered Approve while refreshed metadata was held",
  );
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Receipt did not confirm approval",
  );
  for (let i = 0; i < 3; i++) {
    await githubWrites.snapshot(scope);
    await new Promise(requestAnimationFrame);
  }
  observer.disconnect();
  check(!reoffered, "Approval control transiently reoffered before authoritative refresh settled");
  acceptGithubDetailRead(staleRead, prDetailFixture(scope.url));
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Pre-confirmation response erased confirmed approval",
  );
  check(
    githubApprovalState(scope.url, "c".repeat(40), actor, null) === undefined,
    "Receipt leaked to new head",
  );
  check(
    githubApprovalState(scope.url.replace("/1", "/2"), head, actor, null) === undefined,
    "Receipt leaked to another PR",
  );
  actor = { id: 99, login: "other-actor" };
  await refreshGithubActor();
  const negativeStatus = {
    state: "open" as const,
    draft: false,
    mergeable: true,
    title: "Fixture",
    body: "",
    author: "other",
    url: scope.url,
    headRef: "feature",
    checks: [],
    viewerApproval: null,
    reviewContext: { actor: { ...actor }, headSha: head },
  };
  acceptGithubCommentRead(beginGithubCommentRead(scope.url), {
    comments: [],
    issueComments: [],
    status: negativeStatus,
  });
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Receipt leaked to switched actor",
  );
  actor = { id: 42, login: "browser-fixture" };
  await refreshGithubActor();
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Original actor lost confirmed receipt",
  );
  const wrongActorDetail = prDetailFixture(scope.url);
  if (wrongActorDetail.actor.status === "available") wrongActorDetail.actor.data.databaseId = 99;
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), wrongActorDetail);
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Same-login wrong numeric actor retired original bridge",
  );
  acceptGithubCommentRead(beginGithubCommentRead(scope.url), {
    comments: [],
    issueComments: [],
    status: { ...negativeStatus, reviewContext: undefined },
  });
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Unverified negative status retired receipt",
  );
  acceptGithubCommentRead(beginGithubCommentRead(scope.url), {
    comments: [],
    issueComments: [],
    status: { ...negativeStatus, reviewContext: { actor: { ...actor }, headSha: "c".repeat(40) } },
  });
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Another-head negative retired original bridge",
  );
  queryClient.setQueryData(
    queryKeys.pr.detail(scope.url),
    prDetailFixture(scope.url, "c".repeat(40)),
  );
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Old session head stayed approved after current head changed",
  );
  queryClient.setQueryData(queryKeys.pr.detail(scope.url), prDetailFixture(scope.url, head));
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), prDetailFixture(scope.url));
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Complete detail-only absence retained receipt",
  );
  resolveDetail(prDetailFixture(scope.url));
  const approved = prDetailFixture(scope.url);
  approved.reviews = {
    status: "available",
    complete: true,
    data: [
      {
        id: "R_123",
        author: actor.login,
        state: "APPROVED",
        body: "",
        commitSha: head,
        submittedAt: "2026-01-01T00:00:00Z",
        url: `${scope.url}#pullrequestreview-123`,
      },
    ],
  };
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !acceptGithubDetailRead(staleRead, prDetailFixture(scope.url)),
    "Older response accepted after fresh authority",
  );
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Fresh approved review not shown",
  );
  approved.reviews.data[0]!.state = "DISMISSED";
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
    "Dismissal did not clear confirmed approval",
  );
  approved.reviews.data[0]!.state = "CHANGES_REQUESTED";
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Changed review remained approved",
  );
  approved.reviews.data[0]!.state = "APPROVED";
  acceptGithubCommentRead(beginGithubCommentRead(scope.url), {
    comments: [],
    issueComments: [],
    status: { ...negativeStatus, reviewContext: { actor: { ...actor }, headSha: head } },
  });
  approved.reviewRequests = {
    status: "available",
    complete: true,
    data: [{ kind: "user", name: actor.login }],
  };
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Newer historical approval resurrected renewed request",
  );
  approved.reviewRequests = { status: "available", complete: false, data: [] };
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Incomplete requests resurrected approval",
  );
  approved.reviewRequests = { status: "unavailable", message: "Unknown requests" };
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Unknown requests resurrected approval",
  );
  approved.reviewRequests = {
    status: "available",
    complete: true,
    data: [{ kind: "team", name: "unknown-membership" }],
  };
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Team request resurrected approval",
  );
  approved.reviewRequests = { status: "available", complete: true, data: [] };
  approved.reviews.data.push({
    ...approved.reviews.data[0]!,
    id: "R_124",
    state: "COMMENTED",
    submittedAt: "2026-01-02T00:00:00Z",
    url: `${scope.url}#pullrequestreview-124`,
  });
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Later distinct COMMENTED review resurrected historical approval",
  );
  approved.reviews.data[1]!.submittedAt = approved.reviews.data[0]!.submittedAt;
  acceptGithubDetailRead(beginGithubCommentRead(scope.url), approved);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Equal-timestamp COMMENTED review resurrected ambiguous historical approval",
  );
  operation!.revision++;
  await githubWrites.snapshot(scope);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Synced metadata revision resurrected superseded receipt",
  );
  resolveExtras({
    comments: [],
    issueComments: [],
    status: {
      state: "open",
      draft: false,
      mergeable: true,
      title: "Fixture",
      body: "",
      author: "other",
      url: scope.url,
      headRef: "feature",
      checks: [],
      viewerApproval: null,
      reviewContext: { actor: { ...actor }, headSha: head },
    },
  });
  await wait(
    () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
    "Fresh authoritative absence did not supersede receipt",
  );
  dispose();
  return result();
}
