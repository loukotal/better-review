import type { SearchedPr } from "@better-review/shared";
import type { GithubOutboxCommand, GithubOutboxOperation } from "@better-review/shared";

import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope, githubWrites } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

declare global {
  interface Window {
    activateBrowserLinkWithEnter(selector: string): Promise<void>;
  }
}
const url = "https://github.com/browser-fixture/isolated/pull/1";
const list = "/?mine=1&needsReview=0&repo=browser-fixture%2Fisolated";
const prs: SearchedPr[] = Array.from({ length: 60 }, (_, index) => ({
  number: index + 1,
  headRefOid: "a".repeat(40),
  title: `History PR ${index + 1}`,
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
  "prs.ciStatusBatch": () => ({ statuses: { [url]: { state: "FAILURE", passed: 0, total: 1 } } }),
  "prReview.automaticStatuses": () => ({}),
};
function button(assertions: Pick<ReturnType<typeof createAssertions>, "check">, label: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  assertions.check(value, `Missing ${label}`);
  return value!;
}
const here = () => location.pathname + location.search + location.hash;
const back = () =>
  document.querySelector<HTMLAnchorElement>('a[aria-label="Back to pull requests"]')!;
async function mountedList(assertions: Pick<ReturnType<typeof createAssertions>, "wait">) {
  await assertions.wait(
    () =>
      location.pathname === "/" && !!document.querySelector('[aria-label="Filter pull requests"]'),
    "List not mounted",
  );
}

export async function testQueuePrLinkReturnsToFreshListScrollAndFiltersInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const scope = githubPrScope(url);
  const journal = createIndexedDbGithubJournal();
  const command: GithubOutboxCommand = {
    scope,
    operationId: crypto.randomUUID(),
    expectedActor: { id: 42, login: "browser-fixture" },
    dependencies: [],
    action: { kind: "issue-comment", body: "Pending queue fixture" },
  };
  const operation: GithubOutboxOperation = {
    command,
    status: "queued",
    revision: 1,
    sequence: 1,
    attempts: 0,
    retryMode: "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await journal.admit(command);
  await journal.acknowledge(operation);
  await journal.close();
  sessionStorage.setItem(`pr-list-scroll:${list}`, "11");
  await mountAppFixture({
    initialPath: list,
    waitForFiles: false,
    procedures: {
      ...procedures,
      "githubOutbox.snapshot": () => ({ scope, revision: 1, operations: [operation] }),
    },
  });
  await mountedList(assertions);
  await githubWrites.recoverAll();
  await wait(
    () => document.querySelector("main")!.scrollTop === 11,
    "Initial stale offset not restored",
  );
  const scroll = document.querySelector("main")!;
  scroll.scrollTop = 570;
  check(scroll.scrollTop === 570, "List fixture cannot scroll");
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => !!document.querySelector('[popover]:popover-open a[href*="prUrl="]'),
    "Queue PR link missing",
  );
  document.querySelector<HTMLAnchorElement>('[popover]:popover-open a[href*="prUrl="]')!.click();
  await wait(
    () => location.pathname === "/review" && !!document.querySelector("[data-pr-overview]"),
    "Queue PR link did not open Overview",
  );
  check(
    new URLSearchParams(location.search).get("returnTo") === list,
    "Queue link dropped list filters",
  );
  back().click();
  await mountedList(assertions);
  check(here() === list, "Queue Back lost exact filter URL");
  await wait(
    () => document.querySelector("main")!.scrollTop === 570,
    `Queue Back restored stale scroll (${document.querySelector("main")!.scrollTop}), not departure offset`,
  );
  return result();
}

export async function testPrListCiLinkHasOneHistoryEntryAndReturnsInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let sessions = 0,
    core = 0;
  const detail = prDetailFixture(url);
  detail.checks = {
    status: "available",
    complete: true,
    data: [
      {
        id: "1",
        kind: "check-run",
        name: "History CI failure",
        status: "COMPLETED",
        conclusion: "FAILURE",
        url: "https://github.com/browser-fixture/isolated/actions/runs/1",
      },
    ],
  };
  await mountAppFixture({
    initialPath: list,
    waitForFiles: false,
    procedures: {
      ...procedures,
      "prDetail.get": () => detail,
      "pr.core": () => {
        core++;
        throw new Error("CI link must not load core");
      },
      "prReview.getOrCreateSession": () => {
        sessions++;
        throw new Error("CI link must not create a session");
      },
    },
  });
  await wait(() => !!document.querySelector('[aria-label="CI: 0/1 passed"]'), "List CI not loaded");
  const length = history.length;
  const scroll = document.querySelector("main")!;
  scroll.scrollTop = 400;
  document.querySelector<HTMLElement>('[aria-label="CI: 0/1 passed"]')!.click();
  await wait(() => location.pathname === "/review", "CI status did not navigate");
  check(
    new URLSearchParams(location.search).get("tab") === "checks",
    `CI status followed title route: ${here()}`,
  );
  await wait(
    () => document.body.textContent?.includes("History CI failure") ?? false,
    "Checks content not rendered",
  );
  const checksUrl = here();
  check(history.length === length + 1, "CI link added hidden redirect/history entries");
  check(
    core === 0 && sessions === 0 && !document.querySelector("diffs-container"),
    "CI link implicitly entered review",
  );
  back().click();
  await mountedList(assertions);
  check(
    here() === list && history.length === length + 1,
    "UI Back pushed a new list entry instead of returning",
  );
  await wait(() => document.querySelector("main")!.scrollTop === 400, "UI Back lost list scroll");
  history.forward();
  await wait(
    () =>
      here() === checksUrl && !!document.querySelector('section[aria-label="Pull request checks"]'),
    "Forward did not restore original Checks entry",
  );
  history.back();
  await mountedList(assertions);
  check(here() === list, "Browser Back looped through a redirect or duplicate entry");
  return result();
}

export async function testPrDetailBackSkipsTabsWithoutPushingLoopInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  await mountAppFixture({ initialPath: list, waitForFiles: false, procedures });
  await mountedList(assertions);
  await wait(() => !!document.querySelector('a[aria-label="PR details"]'), "Details link missing");
  document.querySelector<HTMLAnchorElement>('a[aria-label="PR details"]')!.click();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Detail not mounted");
  const overviewUrl = here();
  button(assertions, "Checks").click();
  await wait(
    () => new URLSearchParams(location.search).get("tab") === "checks",
    "Checks tab missing",
  );
  const checksUrl = here();
  const length = history.length;
  back().click();
  await mountedList(assertions);
  check(here() === list && history.length === length, "Detail Back appended list to history");
  history.forward();
  await wait(
    () => here() === overviewUrl && !!document.querySelector("[data-pr-overview]"),
    "Forward lost Overview entry",
  );
  history.forward();
  await wait(() => here() === checksUrl, "Forward lost Checks entry");
  history.back();
  await wait(() => here() === overviewUrl, "Back from Checks did not restore Overview");
  history.back();
  await mountedList(assertions);
  return result();
}

export async function testPrCanonicalLinkDoesNotTrapBrowserBackInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const mixed = prs.map((pr, index) =>
    index === 0 ? { ...pr, url: "https://github.com/Browser-Fixture/Isolated/pull/1" } : pr,
  );
  await mountAppFixture({
    initialPath: list,
    waitForFiles: false,
    procedures: { ...procedures, "prs.list": () => ({ prs: mixed, fetchedAt: Date.now() }) },
  });
  await mountedList(assertions);
  await wait(
    () =>
      [...document.querySelectorAll("a")].some((entry) =>
        entry.textContent?.includes("History PR 1"),
      ),
    "Primary link missing",
  );
  const length = history.length;
  [...document.querySelectorAll<HTMLAnchorElement>("a")]
    .find((entry) => entry.textContent?.includes("History PR 1"))!
    .click();
  await wait(() => !!document.querySelector("diffs-container"), "Review did not load");
  check(history.length === length + 1, `Canonicalization inserted history entry: ${here()}`);
  history.back();
  await mountedList(assertions);
  check(here() === list, "Canonical PR link traps browser Back");
  return result();
}

export async function testPrModeHistoryRestoresSessionCommitAndDraftInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  await mountAppFixture({
    searchParams: {
      mode: "commit",
      commit: "b".repeat(40),
      sessionId: "bootstrap",
      showChat: "1",
      returnTo: list,
    },
    procedures: {
      "prReview.selectSession": () => ({
        session: { id: "bootstrap" },
        sessions: [],
        headSha: "a".repeat(40),
        sessionHeadSha: "a".repeat(40),
        sessionScope: { mode: "commit", commitSha: "b".repeat(40) },
      }),
    },
  });
  await wait(
    () =>
      document
        .querySelector('[aria-label="Review scope"] button[aria-pressed="true"]')
        ?.textContent?.startsWith("By commit") ?? false,
    "Commit deep link not selected",
  );
  const initial = here();
  const initialLength = history.length;
  const editor = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message review assistant"]',
  )!;
  editor.value = "History draft";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  button(assertions, "Overview").click();
  await wait(
    () => new URLSearchParams(location.search).get("tab") === "overview",
    "Overview tab did not navigate",
  );
  const overview = here();
  button(assertions, "Checks").click();
  await wait(
    () => new URLSearchParams(location.search).get("tab") === "checks",
    "Checks tab did not navigate",
  );
  const checksUrl = here();
  button(assertions, "Changes").click();
  await wait(
    () => new URLSearchParams(location.search).get("tab") === "changes",
    "Changes tab did not navigate",
  );
  const changes = here();
  check(
    history.length === initialLength + 3 &&
      new URLSearchParams(location.search).get("commit") === "b".repeat(40),
    "Tabs added hidden entries or rewrote the shared commit reference",
  );
  button(assertions, "Changes").click();
  await new Promise(requestAnimationFrame);
  check(history.length === initialLength + 3, "Clicking active tab added a duplicate entry");
  button(assertions, "Full PR").click();
  await wait(() => !new URLSearchParams(location.search).has("mode"), "Full PR route not selected");
  const full = here();
  history.back();
  await wait(
    () => new URLSearchParams(location.search).get("mode") === "commit",
    "Back did not restore commit URL",
  );
  check(
    document
      .querySelector('[aria-label="Review scope"] button[aria-pressed="true"]')
      ?.textContent?.startsWith("By commit"),
    "Back restored commit URL but left full-PR UI selected",
  );
  check(
    new URLSearchParams(location.search).get("sessionId") === "bootstrap" &&
      new URLSearchParams(location.search).get("returnTo") === list,
    "History lost saved session/list context",
  );
  history.forward();
  await wait(() => here() === full, "Forward did not restore Full PR route");
  check(
    document.querySelector('[aria-label="Review scope"] button[aria-pressed="true"]')
      ?.textContent === "Full PR",
    "Forward did not restore Full PR UI",
  );
  check(
    editor.isConnected && editor.value === "History draft",
    "History mode change rebuilt editor or lost draft",
  );
  check(initial.includes("sessionId="), "Fixture did not enter saved review");
  history.back();
  await wait(() => here() === changes, "Back lost Changes URL");
  history.back();
  await wait(() => here() === checksUrl, "Back lost Checks URL");
  history.back();
  await wait(() => here() === overview, "Back lost Overview URL");
  history.back();
  await wait(() => here() === initial, "Back failed to reach original saved-session link");
  check(
    editor.isConnected && editor.value === "History draft",
    "Repeated traversal lost same-PR draft",
  );
  return result();
}

export async function testPrCiAndInfoLinksKeepNativeKeyboardAndModifierBehaviorInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  await mountAppFixture({ initialPath: list, waitForFiles: false, procedures });
  await wait(
    () => !!document.querySelector('[aria-label="CI: 0/1 passed"]'),
    "CI fixture not ready",
  );
  const ci = document.querySelector<HTMLAnchorElement>('a[aria-label="View checks for PR 1"]')!;
  const info = document.querySelector<HTMLAnchorElement>('a[aria-label="PR details"]')!;
  check(
    ci && new URL(ci.href).searchParams.get("tab") === "checks",
    "CI link lacks native Checks href",
  );
  check(
    new URL(ci.href).searchParams.get("returnTo") === list && !ci.parentElement?.closest("a"),
    "CI href lost filters or is nested inside title link",
  );
  check(
    info?.querySelector("svg") &&
      info.title === "PR details" &&
      new URL(info.href).searchParams.get("tab") === "overview",
    "Info icon does not link to accessible PR details",
  );
  check(!info.parentElement?.closest("a"), "Info action is nested inside title link");
  for (const modifiers of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    let captured = true;
    document.addEventListener(
      "click",
      (event) => {
        captured = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    ci.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }));
    check(!captured && here() === list, "App captured native modified/middle link click");
  }
  await window.activateBrowserLinkWithEnter('a[aria-label="View checks for PR 1"]');
  await wait(
    () =>
      new URLSearchParams(location.search).get("tab") === "checks" &&
      !!document.querySelector('section[aria-label="Pull request checks"]'),
    "Keyboard Enter did not open Checks",
  );
  return result();
}

export async function testPrSourceAndExternalLinksDoNotPolluteHistoryInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  await mountAppFixture({
    searchParams: { showChat: "1", keep: "history-context" },
    reviewSnapshot: (sessionId) => ({
      sessionId,
      revision: "a".repeat(40),
      running: false,
      compacting: false,
      settlements: [],
      messages: [
        {
          id: "history-file-link",
          role: "assistant",
          metadata: { timestamp: "2026-01-01", revision: "a".repeat(40) },
          parts: [
            {
              type: "text",
              text: "See [src/example.ts:9](src/example.ts#L9) and [GitHub discussion](https://github.com/browser-fixture/isolated/pull/1#discussion_r2).",
            },
          ],
        },
      ],
    }),
    procedures: {
      "prReview.navigateSource": () => ({ status: "missing", notice: "Pinned source unavailable" }),
    },
  });
  await wait(
    () => !!document.querySelector('[data-chat-file="src/example.ts"]'),
    "Chat file reference not rendered",
  );
  const initial = here(),
    length = history.length;
  document.querySelector<HTMLElement>('[data-chat-file="src/example.ts"]')!.click();
  await new Promise(requestAnimationFrame);
  check(
    here() === initial && history.length === length && !location.hash,
    "Internal source reference added a hash or history entry",
  );
  const external = document.querySelector<HTMLAnchorElement>(
    'a[href="https://github.com/browser-fixture/isolated/pull/1#discussion_r2"]',
  )!;
  check(
    external?.target === "_blank" && external.rel.includes("noopener"),
    "External GitHub link lost native separate-target behavior",
  );
  let captured = true;
  document.addEventListener(
    "click",
    (event) => {
      captured = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  external.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  check(
    !captured && here() === initial && history.length === length,
    "App captured external link or polluted review history",
  );
  return result();
}
