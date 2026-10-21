import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePrTab,
  prListReturnPath,
  prPageHref,
  prListLinkState,
  advancePrLinkState,
  prListBackSteps,
  prQueryChanges,
} from "./pr-navigation";

test("bare PR opens Changes; explicit tabs beat default and legacy review links", () => {
  assert.equal(resolvePrTab({ prUrl: "pr" }), "changes");
  assert.equal(resolvePrTab({ tab: "unknown" }), "changes");
  for (const legacy of [
    { sessionId: "session" },
    { mode: "commit" },
    { commit: "abc" },
    { showChat: "1" },
  ]) {
    assert.equal(resolvePrTab(legacy), "changes");
    assert.equal(resolvePrTab({ ...legacy, tab: "overview" }), "overview");
    assert.equal(resolvePrTab({ ...legacy, tab: "checks" }), "checks");
  }
});

test("list-origin state tracks intentional pushes, retains user state, and never copies router depth", () => {
  const path = "/?repo=owner%2Frepo";
  const first = prListLinkState(path, { custom: "kept", _depth: 40 });
  assert.equal(prListBackSteps(first, path), 1);
  assert.equal("custom" in first && first.custom, "kept");
  assert.equal("_depth" in first, false);
  const third = advancePrLinkState(advancePrLinkState(first));
  assert.equal(prListBackSteps(third, path), 3);
  assert.equal(prListBackSteps(third, "/?other=filter"), undefined);
  for (const state of [
    undefined,
    null,
    { prListOrigin: { path: "//evil.test", steps: 1 } },
    { prListOrigin: { path: "/", steps: -2 } },
    { prListOrigin: { path: "/", steps: 1.5 } },
  ])
    assert.equal(prListBackSteps(state, "/"), undefined);
});

test("no-op query updates do not rewrite encoded URLs or push duplicate history", () => {
  assert.equal(
    prQueryChanges("?tab=checks&prUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1", {
      tab: "checks",
    }),
    false,
  );
  assert.equal(
    prQueryChanges("?mode=commit&commit=abcdef", { mode: undefined, commit: undefined }),
    true,
  );
  assert.equal(prQueryChanges("?keep=encoded%20space", { mode: undefined }), false);
  assert.equal(prQueryChanges("?tab=changes&tab=checks", { tab: "checks" }), true);
});

test("Back return paths preserve list filters and reject external/non-list destinations", () => {
  assert.equal(
    prListReturnPath("/?mine=1&repo=owner%2Frepo#queue"),
    "/?mine=1&repo=owner%2Frepo#queue",
  );
  for (const value of [
    undefined,
    [],
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test/",
    "/review?prUrl=other",
    "javascript:alert(1)",
  ])
    assert.equal(prListReturnPath(value), "/");
});

test("review/detail links keep native hrefs and explicit destination/session context", () => {
  const url = "https://github.com/owner/repo/pull/1";
  const details = new URL(
    prPageHref(url, { tab: "overview", returnTo: "/?repo=owner%2Frepo" }),
    "https://better-review.invalid",
  );
  assert.equal(details.searchParams.get("tab"), "overview");
  assert.equal(details.searchParams.get("returnTo"), "/?repo=owner%2Frepo");
  const review = new URL(prPageHref(url, { sessionId: "saved-session", showChat: true }), details);
  assert.equal(resolvePrTab(Object.fromEntries(review.searchParams)), "changes");
  assert.equal(review.searchParams.get("sessionId"), "saved-session");
  assert.equal(review.searchParams.get("prUrl"), url);
});
