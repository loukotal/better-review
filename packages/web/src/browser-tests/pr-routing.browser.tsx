import type { SearchedPr, PrStatus } from "@better-review/shared";

import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
const listPath = "/?mine=1&drafts=1&needsReview=0&repo=browser-fixture%2Fisolated";
function check(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
async function wait(test: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!test() && performance.now() < deadline) await new Promise(requestAnimationFrame);
  check(test(), message);
}
const prs: SearchedPr[] = Array.from({ length: 70 }, (_, index) => ({
  number: index + 1,
  headRefOid: "a".repeat(40),
  title: `Routing fixture ${index + 1}`,
  url: url.replace("/1", `/${index + 1}`),
  repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
  author: { login: "browser-fixture" },
  createdAt: "2026-01-01T00:00:00Z",
  isDraft: false,
  myReviewState: null,
  isAuthor: true,
  reviewRequested: true,
  additions: 1,
  deletions: 1,
  ciStatus: null,
}));
const procedures = {
  "prs.list": () => ({ prs, fetchedAt: Date.now() }),
  "prs.ciStatusBatch": () => ({ statuses: { [url]: { state: "NEUTRAL", passed: 0, total: 0 } } }),
  "prReview.automaticStatuses": () => ({}),
};

export async function testPrDetailHeaderBackPreservesListContextInBrowser() {
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    searchParams: { returnTo: listPath },
    procedures,
  });
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Detail not ready");
  const back = document.querySelector<HTMLAnchorElement>('a[aria-label="Back to pull requests"]');
  const existingReturn =
    back ?? document.querySelector<HTMLAnchorElement>('a[aria-label="Better Review home"]')!;
  existingReturn.click();
  await wait(() => location.pathname === "/", "Header return did not reach list");
  check(location.search === listPath.slice(1), "Existing detail header return drops list filters");
  check(back, "Detail lacks a visible accessible Back action");
  return { passed: 2 };
}

export async function testPrDetailDirectBackHasSafeFallbackInBrowser() {
  await mountAppFixture({ defaultTab: "overview", waitForFiles: false, procedures });
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Direct detail not ready");
  const back = document.querySelector<HTMLAnchorElement>('a[aria-label="Back to pull requests"]');
  check(back?.getAttribute("href") === "/", "Direct detail lacks deterministic list fallback");
  back!.click();
  await wait(
    () =>
      location.pathname === "/" && !!document.querySelector('[aria-label="Filter pull requests"]'),
    "Direct Back was a no-op",
  );
  return { passed: 2 };
}

export async function testPrListHasSeparateLazyDetailsAndDefaultReviewInBrowser() {
  let sessions = 0,
    core = 0;
  await mountAppFixture({
    initialPath: listPath,
    waitForFiles: false,
    procedures: {
      ...procedures,
      "pr.core": () => {
        core++;
        return {
          headSha: "a".repeat(40),
          comparisonBaseSha: "b".repeat(40),
          diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          info: { owner: "browser-fixture", repo: "isolated", number: "1" },
          commits: [],
        };
      },
      "prReview.getOrCreateSession": () => {
        sessions++;
        return {
          session: { id: "bootstrap" },
          sessions: [],
          headSha: "a".repeat(40),
          sessionHeadSha: "a".repeat(40),
          sessionScope: { mode: "full", commitSha: null },
        };
      },
    },
  });
  await wait(() => !!document.querySelector('a[href*="prUrl="]'), "List did not load");
  const details = document.querySelector<HTMLAnchorElement>('a[aria-label="PR details"]');
  check(details, "List has no separate PR details link");
  check(
    new URL(details!.href).searchParams.get("tab") === "overview",
    "Details link does not explicitly select Overview",
  );
  const primary = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((entry) =>
    entry.textContent?.includes("Routing fixture 1"),
  )!;
  check(
    new URL(primary.href).searchParams.get("tab") !== "overview",
    "Primary title opens detail instead of review",
  );
  await wait(
    () => !!document.querySelector('[aria-label="CI: 0/0 passed"]'),
    "Neutral CI fixture not loaded",
  );
  check(
    document.querySelector('[aria-label="CI: 0/0 passed"]')?.textContent === "○",
    "Unknown/empty CI count shown as all passed",
  );
  const main = document.querySelector<HTMLElement>("main")!;
  main.scrollTop = 500;
  const savedScroll = main.scrollTop;
  check(savedScroll > 0, "List scroll fixture has no overflow");
  details!.click();
  await wait(
    () => !!document.querySelector("[data-pr-overview] h1"),
    "Details link did not open Overview",
  );
  check(
    core === 0 && sessions === 0 && !document.getElementById("chat-panel"),
    "List details started review work",
  );
  document.querySelector<HTMLAnchorElement>('a[aria-label="Back to pull requests"]')!.click();
  await wait(
    () =>
      location.pathname === "/" && !!document.querySelector('[aria-label="Filter pull requests"]'),
    "Back did not restore list",
  );
  check(location.search === listPath.slice(1), "Back dropped filters");
  await wait(
    () => document.querySelector("main")!.scrollTop === savedScroll,
    "Back dropped list scroll position",
  );
  const restoredPrimary = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((entry) =>
    entry.textContent?.includes("Routing fixture 1"),
  )!;
  restoredPrimary.click();
  await wait(
    () => !!document.querySelector("diffs-container") && !!document.getElementById("chat-panel"),
    "Primary title did not open review",
  );
  check(!document.querySelector("[data-pr-overview]"), "Primary title still defaults to Overview");
  return { passed: 9 };
}

export async function testBarePrUrlDefaultsToReviewInBrowser() {
  await mountAppFixture({ defaultTab: null, waitForFiles: false });
  await wait(
    () => !!document.querySelector("diffs-container") && !!document.getElementById("chat-panel"),
    "Bare PR URL did not open Changes/review",
  );
  check(!document.querySelector("[data-pr-overview]"), "Bare PR URL defaulted to detail");
  return { passed: 1 };
}

export async function testReviewChecksIndicatorOpensActualChecksInBrowser() {
  const detail = prDetailFixture(url);
  detail.checks = {
    status: "available",
    complete: true,
    data: [
      {
        id: "failed",
        kind: "check-run",
        name: "Functions-3rd-Party-Integration",
        status: "COMPLETED",
        conclusion: "FAILURE",
        url: `${url}/checks?check_run_id=1`,
      },
      {
        id: "running",
        kind: "check-run",
        name: "E2E-Ci",
        status: "IN_PROGRESS",
        conclusion: null,
        url: `${url}/checks?check_run_id=2`,
      },
      {
        id: "context",
        kind: "status-context",
        name: "deploy/preview",
        status: "PENDING",
        conclusion: null,
        url: `${url}/checks?check_run_id=3`,
      },
    ],
  };
  const status: PrStatus = {
    state: "open",
    draft: false,
    mergeable: true,
    title: "Checks routing",
    body: "",
    author: "author",
    url,
    headRef: "feature",
    checks: [
      { name: "Functions-3rd-Party-Integration", status: "completed", conclusion: "failure" },
      { name: "E2E-Ci", status: "in_progress", conclusion: null },
    ],
  };
  await mountAppFixture({
    extras: { comments: [], issueComments: [], status },
    procedures: { "prDetail.get": () => detail },
  });
  const checks = document.querySelector<HTMLButtonElement>(
    'button[aria-label="View pull request checks"]',
  );
  check(checks, "Review CI indicator is not actionable");
  checks!.click();
  await wait(
    () => !!document.querySelector('section[aria-label="Pull request checks"]'),
    "CI indicator did not activate Checks",
  );
  check(
    new URLSearchParams(location.search).get("tab") === "checks",
    "Checks selection missing from URL",
  );
  check(
    !!document.querySelector(`a[href="${url}/checks?check_run_id=1"]`),
    "Backend check-run URL not rendered",
  );
  check(
    !!document.querySelector(`a[href="${url}/checks?check_run_id=3"]`),
    "Backend status-context URL not rendered",
  );
  check(
    document.body.textContent?.includes("Functions-3rd-Party-Integration") &&
      document.body.textContent?.includes("E2E-Ci"),
    "Actual CheckRun contract not displayed",
  );
  return { passed: 5 };
}

export async function testPrChecksPrioritizeFailureAndRunningContractInBrowser() {
  let detail = prDetailFixture(url);
  detail.checks = {
    status: "available",
    complete: true,
    data: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `passed-${index}`,
        kind: "check-run" as const,
        name: `Passing job ${index + 1}`,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: `https://github.com/browser-fixture/isolated/actions/runs/${index + 1}`,
      })),
      {
        id: "skip1",
        kind: "check-run",
        name: "Preview-Deploy-Demo",
        status: "COMPLETED",
        conclusion: "SKIPPED",
        url: null,
      },
      {
        id: "skip2",
        kind: "check-run",
        name: "Preview-Deploy-Production",
        status: "COMPLETED",
        conclusion: "SKIPPED",
        url: null,
      },
      {
        id: "failure",
        kind: "check-run",
        name: "Functions-3rd-Party-Integration",
        status: "COMPLETED",
        conclusion: "FAILURE",
        url: "https://github.com/browser-fixture/isolated/actions/runs/13",
      },
      {
        id: "running",
        kind: "check-run",
        name: "E2E-Ci",
        status: "IN_PROGRESS",
        conclusion: null,
        url: "https://github.com/browser-fixture/isolated/actions/runs/14",
      },
    ],
  };
  let reads = 0,
    sessions = 0;
  await mountAppFixture({
    defaultTab: "checks",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => {
        reads++;
        return detail;
      },
      "prReview.getOrCreateSession": () => {
        sessions++;
        throw new Error("Checks must not mount review");
      },
    },
  });
  await wait(
    () => !!document.querySelector('[aria-label="Check summary"]'),
    "Check contract did not render",
  );
  const summary = document.querySelector('[aria-label="Check summary"]')!.textContent!;
  check(
    summary.includes("1 failed") &&
      summary.includes("1 pending") &&
      summary.includes("12 passed") &&
      summary.includes("2 skipped"),
    "Check summary misclassified backend evidence",
  );
  const section = document.querySelector('section[aria-label="Pull request checks"]')!;
  check(
    section.querySelector("li")?.textContent?.includes("Functions-3rd-Party-Integration"),
    "Failure hidden below passed checks",
  );
  const passed = [...section.querySelectorAll("details")].find((entry) =>
    entry.querySelector("summary")?.textContent?.startsWith("Passed"),
  )!;
  check(!passed.open, "Passed checks obscure failure/running jobs by default");
  await new Promise<void>((resolve) => {
    passed.addEventListener("toggle", () => resolve(), { once: true });
    passed.querySelector("summary")!.click();
  });
  const refresh = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Refresh checks",
    )!;
  refresh().click();
  await wait(() => reads === 1, "Refresh checks did not invoke fresh read");
  await wait(() => !refresh().disabled, "Refresh did not settle");
  check(passed.open && passed.isConnected, "Refreshing reset expanded check groups");
  detail = {
    ...detail,
    checks: { status: "unavailable", message: "Checks temporarily unavailable from GitHub" },
  };
  refresh().click();
  await wait(
    () => section.textContent?.includes("Checks temporarily unavailable from GitHub") ?? false,
    "Backend section error not rendered",
  );
  check(
    !!section.querySelector('[aria-label="Check summary"]') &&
      section.textContent?.includes("Showing previous results"),
    "Same-head read failure erased known results or hid their stale status",
  );
  check(
    sessions === 0 && !document.getElementById("chat-panel"),
    "Checks navigation started a review session",
  );
  return { passed: 6 };
}

export async function testPrChecksReadFailureHasReadOnlyRetryInBrowser() {
  let reads = 0,
    sessions = 0;
  const detail = prDetailFixture(url);
  detail.checks = { status: "available", complete: false, data: [] };
  await mountAppFixture({
    defaultTab: "checks",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => {
        throw new Error("Fixture initial detail read failed");
      },
      "prDetail.refresh": () => {
        reads++;
        return detail;
      },
      "prReview.getOrCreateSession": () => {
        sessions++;
        throw new Error("Checks must not create a session");
      },
    },
  });
  const section = () => document.querySelector('section[aria-label="Pull request checks"]')!;
  await wait(
    () => section()?.textContent?.includes("Checks unavailable") ?? false,
    "Initial read error left Checks loading forever",
  );
  check(!section().textContent?.includes("Loading checks"), "Loading state hid read failure");
  check(
    document.querySelectorAll('[role="alert"]').length === 1,
    "Read error duplicated across detail/checks sections",
  );
  [...section().querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.trim() === "Refresh checks")!
    .click();
  await wait(
    () => section().textContent?.includes("Missing results are unknown, not passed") ?? false,
    "Retry did not render partial backend contract",
  );
  check(
    reads === 1 && sessions === 0 && !document.getElementById("chat-panel"),
    "Check retry started review work or duplicated read",
  );
  check(
    !section().querySelector('[aria-label="Check summary"]') &&
      !section().textContent?.includes("No checks reported."),
    "Incomplete empty checks were presented as complete",
  );
  return { passed: 4 };
}
