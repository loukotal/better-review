import {
  isGithubOutboxCommand,
  type GithubOutboxOperation,
  type SearchedPr,
  type GithubWriteAction,
} from "@better-review/shared";

import {
  githubWrites,
  githubPrScope,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

const url = "https://github.com/browser-fixture/isolated/pull/1";
async function wait(predicate: () => boolean, message: string) {
  for (let i = 0; i < 240 && !predicate(); i++) await new Promise(requestAnimationFrame);
  if (!predicate()) throw new Error(message);
}
async function exercise(kind: "approve" | "issue-comment", failed = false) {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const scope = githubPrScope(url);
  let release!: () => void;
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0,
    lists = 0,
    extras = 0,
    confirmed = false;
  const operations: GithubOutboxOperation[] = [];
  const list = () => ({
    fetchedAt: Date.now(),
    prs: [
      {
        url,
        headRefOid: "a".repeat(40),
        number: 1,
        title: "Persistent queue fixture",
        repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
        author: { login: "another-user" },
        createdAt: "2026-01-01T00:00:00Z",
        isDraft: false,
        isAuthor: false,
        reviewRequested: true,
        myReviewState: confirmed ? "APPROVED" : null,
        reviewDecision: confirmed ? "APPROVED" : "REVIEW_REQUIRED",
        additions: 1,
        deletions: 1,
        ciStatus: null,
      } satisfies SearchedPr,
    ],
  });
  await mountAppFixture({
    procedures: {
      "prs.list": list,
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({}),
      "prs.refresh": () => {
        lists++;
        return list();
      },
      "pr.extras": () => {
        extras++;
        return { comments: [], issueComments: [], status: null };
      },
      "githubOutbox.enqueue": async (command) => {
        posts++;
        await admission;
        if (!isGithubOutboxCommand(command)) throw new Error("Invalid fixture command");
        const operation: GithubOutboxOperation = {
          command,
          status: "queued",
          revision: 1,
          sequence: operations.length + 1,
          attempts: 0,
          retryMode: "manual",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        operations.push(operation);
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operations.reduce((n, item) => n + item.revision, 0),
        operations: structuredClone(operations),
      }),
    },
  });
  await refreshGithubActor();
  const action: GithubWriteAction =
    kind === "approve"
      ? { kind, body: "", expectedHeadSha: "a".repeat(40) }
      : { kind, body: "Saved comment" };
  await queueGithubWrite(url, action);
  await wait(() => posts === 1, "Admission POST did not start");
  const control = document.querySelector("[data-global-github-queue]");
  document.querySelector<HTMLAnchorElement>('a[aria-label="Better Review home"]')!.click();
  await wait(
    () => location.pathname === "/" && !!document.querySelector('a[href*="prUrl="]'),
    "List did not mount",
  );
  check(
    document.querySelector("[data-global-github-queue]") === control,
    "Queue control remounted across routes",
  );
  check(
    !!document.querySelector(
      '[data-global-github-queue] [data-github-sync-status="local-pending"]',
    ),
    "Global queue lost pre-ack intent",
  );
  check(
    !!document.querySelector('main [data-github-sync-status="local-pending"]'),
    "List row lacks pending state",
  );
  check(
    !document.querySelector('span[title="GitHub\'s current overall review decision is Approved."]'),
    "Pending action falsely approved row",
  );
  release();
  await githubWrites.recoverAll();
  await wait(() => operations.length === 1, "Admission did not finish");
  operations[0]!.status = failed ? "retry-failed" : "synced";
  operations[0]!.revision++;
  confirmed = kind === "approve" && !failed;
  const baseline = extras;
  await githubWrites.recoverAll();
  if (confirmed) {
    await wait(
      () =>
        lists === 1 &&
        ![...document.querySelectorAll("a")].some((link) =>
          link.textContent?.includes("Persistent queue fixture"),
        ),
      "Confirmed approval did not update needs-review filter",
    );
    const toggle = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Needs review"),
    );
    if (!toggle) throw new Error("Needs-review filter missing");
    toggle.click();
    await wait(
      () =>
        !!document.querySelector(
          'span[title="GitHub\'s current overall review decision is Approved."]',
        ),
      "Confirmed approval badge missing after clearing filter",
    );
    passed += 2;
  } else if (!failed)
    await wait(() => extras > baseline, "Comment completion did not refresh affected extras");
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (let n = 0; n < 3; n++) await githubWrites.recoverAll();
  check(posts === 1, `Write replayed: ${posts} POSTs`);
  check(lists === (confirmed ? 1 : 0), `Unexpected list refreshes: ${lists}`);
  if (failed)
    check(
      !document.querySelector(
        'span[title="GitHub\'s current overall review decision is Approved."]',
      ),
      "Failed approval falsely approved row",
    );
  return { passed };
}
export function testGlobalQueueApprovalCompletesAfterLeavingBeforeAckInBrowser() {
  return exercise("approve");
}
export function testGlobalQueueFailedApprovalDoesNotApproveListInBrowser() {
  return exercise("approve", true);
}
export function testGlobalQueueCommentCompletionDoesNotRefreshListInBrowser() {
  return exercise("issue-comment");
}
