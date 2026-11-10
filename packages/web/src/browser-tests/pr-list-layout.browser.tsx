import type { SearchedPr } from "@better-review/shared";

import { PR_LIST_LAYOUT_KEY } from "../lib/pr-list-layout";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    captureBrowserPrListLayout: (width: number) => Promise<void>;
  }
}

async function mountListFixture() {
  const title =
    "Use rent month in replacement receipt comments while retaining all existing transaction metadata";
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const pr: SearchedPr = {
    number: 1,
    headRefOid: "a".repeat(40),
    title,
    url,
    repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
    author: { login: "browser-fixture" },
    createdAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    myReviewState: null,
    isAuthor: true,
    reviewRequested: true,
    reviewDecision: "APPROVED",
    additions: 1037,
    deletions: 208,
    ciStatus: null,
  };
  let reads = 0;
  const dispose = await mountAppFixture({
    initialPath: "/?mine=1&needsReview=0",
    waitForFiles: false,
    procedures: {
      "prs.list": () => {
        reads++;
        return { prs: [pr], fetchedAt: Date.now() };
      },
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({ [url]: { state: "none" } }),
    },
  });
  return { title, url, dispose, reads: () => reads };
}

export async function testPrListPrioritizesFullTitleAndKeepsBadgesVisibleInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const { title, dispose } = await mountListFixture();
  try {
    await wait(
      () =>
        !!document.querySelector(
          'span[title="GitHub\'s current overall review decision is Approved."]',
        ),
      "Approved fixture did not load",
    );
    const badge = document.querySelector<HTMLElement>(
      'span[title="GitHub\'s current overall review decision is Approved."]',
    )!;
    const primary = badge.closest("a")!;
    const label = [...primary.querySelectorAll("span")].find(
      (element) => element.textContent === title,
    )!;
    for (const width of [1920, 1280, 852, 768, 640, 393, 320]) {
      await window.setBrowserReviewViewport(width, 900);
      await new Promise(requestAnimationFrame);
      const titleBox = label.getBoundingClientRect();
      const badgeBox = badge.getBoundingClientRect();
      check(
        document.documentElement.scrollWidth <= innerWidth,
        `${width}px: list must not overflow the page`,
      );
      for (const control of document.querySelectorAll<HTMLElement>(
        '[aria-label="Review list layout"] button, #repo-filter',
      )) {
        const box = control.getBoundingClientRect();
        check(
          box.left >= 0 && box.right <= innerWidth,
          `${width}px: layout and repository controls must remain fully visible`,
        );
      }
      check(
        badgeBox.width >= 75 && badgeBox.right <= innerWidth,
        `${width}px: Approved badge must remain fully visible`,
      );
      check(
        getComputedStyle(label).whiteSpace !== "nowrap" &&
          getComputedStyle(label).webkitLineClamp === "none",
        `${width}px: important PR titles must wrap rather than truncate`,
      );
      check(
        label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1,
        `${width}px: the complete title must fit within its text area`,
      );
      check(
        badgeBox.top >= titleBox.bottom,
        `${width}px: status metadata must not take space from the title row`,
      );
      if (width >= 1280) {
        const list = document.querySelector<HTMLElement>("[data-pr-list-scroll] > div")!;
        check(
          titleBox.width > list.clientWidth * 0.7,
          `${width}px: title should receive most of the list width`,
        );
        if (width === 1920)
          check(
            list.clientWidth >= 1500,
            "Large screens should not leave most horizontal space unused",
          );
      }
      if (width === 1920 || width === 393) await window.captureBrowserPrListLayout(width);
    }
    return result();
  } finally {
    dispose();
    await window.setBrowserReviewViewport(1280, 900);
  }
}

export async function testReviewListLayoutChoicePersistsWithoutChangingNavigationInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const fixture = await mountListFixture();
  const choice = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Review list layout"] button'),
    ].find((button) => button.textContent?.trim() === name)!;
  try {
    await wait(
      () => !!document.querySelector('[data-pr-summary-layout="title-first"]'),
      "Default layout did not load",
    );
    check(
      choice("Title-first").getAttribute("aria-pressed") === "true",
      "Title-first is the default",
    );
    for (const name of ["Title-first", "Table"]) {
      const control = choice(name);
      check(
        !!control.querySelector('svg[aria-hidden="true"]'),
        `${name} uses a decorative layout icon`,
      );
      check(
        control.querySelector(".sr-only")?.textContent === name,
        `${name} retains its accessible label`,
      );
      check(control.title === `${name} layout`, `${name} has a hover tooltip`);
    }
    const primary = document
      .querySelector("[data-pr-summary-layout]")!
      .closest<HTMLAnchorElement>("a")!;
    const details = document.querySelector<HTMLAnchorElement>('a[aria-label="PR details"]')!;
    const href = primary.href;
    const search = location.search;
    const height = primary.getBoundingClientRect().height;
    const reads = fixture.reads();
    choice("Table").click();
    check(
      !!document.querySelector('[data-pr-summary-layout="table"]'),
      "Table selection changes the presentation",
    );
    check(localStorage.getItem(PR_LIST_LAYOUT_KEY) === "table", "Table choice is persisted");
    check(
      primary.isConnected && primary.href === href && location.search === search,
      "Changing layout preserves PR links and current filters",
    );
    check(fixture.reads() === reads, "Changing presentation must not refetch PRs");
    check(
      primary.getBoundingClientRect().height < height,
      "Table rows are denser than title-first rows",
    );
    for (const width of [1280, 852, 768, 640, 393, 320]) {
      await window.setBrowserReviewViewport(width, 900);
      await new Promise(requestAnimationFrame);
      const badge = primary.querySelector<HTMLElement>(
        'span[title="GitHub\'s current overall review decision is Approved."]',
      )!;
      check(
        document.documentElement.scrollWidth <= innerWidth,
        `${width}px: table layout must not overflow`,
      );
      check(
        badge.getBoundingClientRect().width >= 75 &&
          badge.getBoundingClientRect().right <= innerWidth,
        `${width}px: table layout retains its Approved badge`,
      );
    }
    await window.setBrowserReviewViewport(1280, 900);
    details.click();
    await wait(
      () => !!document.querySelector("[data-pr-overview] h1"),
      "PR details link stopped working",
    );
    document.querySelector<HTMLAnchorElement>('[aria-label="Back to pull requests"]')!.click();
    await wait(
      () => !!document.querySelector('[data-pr-summary-layout="table"]'),
      "Returning to Reviews lost the saved layout",
    );
    check(
      choice("Table").getAttribute("aria-pressed") === "true",
      "Remounted page restores the selected control",
    );
    choice("Title-first").click();
    check(
      !!document.querySelector('[data-pr-summary-layout="title-first"]') &&
        localStorage.getItem(PR_LIST_LAYOUT_KEY) === "title-first",
      "The choice can be switched back and persisted",
    );
    return result();
  } finally {
    fixture.dispose();
    await window.setBrowserReviewViewport(1280, 900);
  }
}
