import type { SearchedPr } from "@better-review/shared";

import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

export async function testApprovedPrListBadgeFitsInBrowser() {
  const { check, wait, result } = createAssertions(5000);
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
  await mountAppFixture({
    initialPath: "/?mine=1&needsReview=0",
    waitForFiles: false,
    procedures: {
      "prs.list": () => ({ prs: [pr], fetchedAt: Date.now() }),
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({}),
    },
  });
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
    for (const width of [1280, 852, 768, 640, 393, 320]) {
      await window.setBrowserReviewViewport(width, 900);
      await new Promise(requestAnimationFrame);
      const titleBox = label.getBoundingClientRect();
      const badgeBox = badge.getBoundingClientRect();
      check(
        document.documentElement.scrollWidth <= innerWidth,
        `${width}px: list must not overflow the page`,
      );
      check(
        badgeBox.width >= 75 && badgeBox.right <= innerWidth,
        `${width}px: Approved badge must remain fully visible`,
      );
      if (width >= 640) {
        check(
          Math.abs(titleBox.top + titleBox.height / 2 - badgeBox.top - badgeBox.height / 2) < 2,
          `${width}px: Approved must share the title row, rather than wrapping below it`,
        );
        check(
          label.scrollWidth > label.clientWidth,
          `${width}px: long title truncates before displacing its badge`,
        );
      }
    }
    return result();
  } finally {
    await window.setBrowserReviewViewport(1280, 900);
  }
}
