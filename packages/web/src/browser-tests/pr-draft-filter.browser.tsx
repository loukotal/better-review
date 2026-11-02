import type { SearchedPr } from "@better-review/shared";

import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

export async function testPrDraftFilterToggleAndReturnInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  let prs: SearchedPr[] = [false, true, true].map((isDraft, index) => ({
    number: index + 1,
    headRefOid: "a".repeat(40),
    title: `Draft filter fixture ${index + 1}`,
    url: `https://github.com/browser-fixture/isolated/pull/${index + 1}`,
    repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
    author: { login: "browser-fixture" },
    createdAt: "2026-01-01T00:00:00Z",
    isDraft,
    myReviewState: null,
    isAuthor: true,
    reviewRequested: index !== 2,
    additions: 1,
    deletions: 1,
    ciStatus: null,
  }));
  let refreshes = 0;
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "prs.list": () => ({ prs, fetchedAt: Date.now() }),
      "prs.refresh": () => {
        refreshes++;
        return { prs, fetchedAt: Date.now() };
      },
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({}),
    },
  });
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    )!;
  const titles = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href*="prUrl="]')]
      .map((entry) => entry.textContent?.match(/Draft filter fixture \d+/)?.[0])
      .filter(Boolean)
      .join(",");
  await wait(() => titles() === "Draft filter fixture 1", "Default list must exclude drafts");
  button("Drafts").click();
  await wait(
    () => titles() === "Draft filter fixture 1,Draft filter fixture 2",
    "Drafts toggle must include requested drafts alongside ready PRs",
  );
  check(button("Drafts").getAttribute("aria-pressed") === "true", "Drafts not active");
  check(new URLSearchParams(location.search).get("drafts") === "1", "Draft state missing from URL");
  button("Needs review").click();
  await wait(
    () => titles() === "Draft filter fixture 1,Draft filter fixture 2,Draft filter fixture 3",
    "Clearing Needs review must reveal authored drafts without a review request",
  );
  button("Authored by me").click();
  const repo = document.querySelector<HTMLSelectElement>('[aria-label="Filter by repository"]')!;
  repo.value = "browser-fixture/isolated";
  repo.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => !!new URLSearchParams(location.search).get("repo"), "Repo filter not applied");
  const listSearch = location.search;
  document.querySelector<HTMLAnchorElement>('a[aria-label="PR details"]')!.click();
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Details not ready");
  document.querySelector<HTMLAnchorElement>('a[aria-label="Back to pull requests"]')!.click();
  await wait(() => titles().includes("Draft filter fixture 3"), "Back lost included drafts");
  check(location.search === listSearch, "Back lost list filters");
  check(button("Drafts").getAttribute("aria-pressed") === "true", "Back lost active draft state");
  button("Drafts").click();
  await wait(() => titles() === "Draft filter fixture 1", "Turning Drafts off must hide drafts");
  prs = prs.map((pr) => (pr.number === 2 ? { ...pr, isDraft: false } : pr));
  await wait(() => !button("Refresh").disabled, "List read did not settle");
  button("Refresh").click();
  await wait(
    () => titles() === "Draft filter fixture 1,Draft filter fixture 2",
    "Refresh must show a former draft after its stage changes",
  );
  check(refreshes === 1, "Refresh did not read the fresh list exactly once");
  const params = new URLSearchParams(location.search);
  check(
    params.get("mine") === "1" &&
      params.get("needsReview") === "0" &&
      params.get("repo") === "browser-fixture/isolated" &&
      !params.has("drafts"),
    "Draft toggle changed unrelated filters",
  );
  return result();
}
