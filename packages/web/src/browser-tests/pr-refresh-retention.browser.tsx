import type { PrDetail } from "@better-review/shared";

import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { queryClient, queryKeys } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
function fixture(): PrDetail {
  const detail = prDetailFixture(url);
  detail.checks = {
    status: "available",
    complete: true,
    data: [
      {
        id: "stable-check",
        kind: "check-run",
        name: "Stable visible check",
        status: "IN_PROGRESS",
        conclusion: null,
        url: "https://github.com/browser-fixture/isolated/actions/runs/1",
      },
    ],
  };
  return detail;
}
const refresh = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Refresh checks",
  )!;

export async function testPrCachedChecksSurviveHeldReadAndNoopRefreshInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const detail = fixture();
  queryClient.setQueryData(queryKeys.pr.detail(url), detail, { updatedAt: Date.now() - 600_000 });
  let release!: (value: PrDetail) => void;
  const held = new Promise<PrDetail>((resolve) => {
    release = resolve;
  });
  let reads = 0,
    refreshes = 0;
  await mountAppFixture({
    defaultTab: "checks",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => {
        reads++;
        return held;
      },
      "prDetail.refresh": () => {
        refreshes++;
        return structuredClone(detail);
      },
    },
  });
  await wait(
    () => !!document.querySelector("li[data-check-kind]"),
    "Cached checks disappeared during held background read",
  );
  const heading = document.querySelector("main h1"),
    row = document.querySelector("li[data-check-kind]");
  check(
    heading && row?.textContent?.includes("Stable visible check"),
    "Cached heading/check unavailable while refreshing",
  );
  release(structuredClone(detail));
  await wait(
    () =>
      reads === 1 && queryClient.getQueryState(queryKeys.pr.detail(url))?.fetchStatus === "idle",
    "Held read did not settle",
  );
  await new Promise(requestAnimationFrame);
  check(
    document.querySelector("main h1") === heading &&
      document.querySelector("li[data-check-kind]") === row,
    "Unchanged background detail response replaced visible DOM",
  );
  for (let index = 0; index < 3; index++) {
    refresh().click();
    await wait(
      () => refreshes === index + 1 && !refresh().disabled,
      "Manual refresh did not settle",
    );
    check(
      document.querySelector("li[data-check-kind]") === row,
      "No-op refresh remounted check rows",
    );
  }
  for (let index = 0; index < 3; index++) {
    await refreshGithubActor();
    await githubWrites.snapshot(githubPrScope(url));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    reads === 1 && refreshes === 3 && document.querySelector("li[data-check-kind]") === row,
    "Identity/outbox/focus updates refetched or remounted stable detail",
  );
  return result();
}

export async function testPrPartialReadFailureKeepsKnownChecksButNewHeadClearsThemInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const original = fixture();
  let next = original;
  await mountAppFixture({
    defaultTab: "checks",
    waitForFiles: false,
    procedures: { "prDetail.get": () => original, "prDetail.refresh": () => next },
  });
  await wait(() => !!document.querySelector("li[data-check-kind]"), "Initial checks missing");
  next = {
    ...original,
    checks: { status: "unavailable", message: "Fixture checks read temporarily unavailable" },
  };
  refresh().click();
  await wait(() => !refresh().disabled, "Partial refresh did not settle");
  check(
    document.body.textContent?.includes("Stable visible check"),
    "Partial read failure erased known same-head checks",
  );
  check(
    document.body.textContent?.includes("Fixture checks read temporarily unavailable"),
    "Stale checks lack a read-failure notice",
  );
  next = {
    ...next,
    metadata:
      original.metadata.status === "available"
        ? {
            ...original.metadata,
            data: {
              ...original.metadata.data,
              head: { ...original.metadata.data.head, sha: "c".repeat(40) },
            },
          }
        : original.metadata,
  };
  refresh().click();
  await wait(() => !refresh().disabled, "New-head refresh did not settle");
  check(
    !document.body.textContent?.includes("Stable visible check"),
    "Old-head checks leaked into a new PR head",
  );
  return result();
}
