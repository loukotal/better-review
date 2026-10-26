import type { PrDetail, PrMergeInput } from "@better-review/shared";

import {
  acceptGithubCommentRead,
  acceptGithubDetailRead,
  beginGithubCommentRead,
  projectGithubComments,
} from "../lib/github-comment-views";
import { githubJournal, githubPrScope, refreshGithubActor } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
function button(assertions: Pick<ReturnType<typeof createAssertions>, "check">, name: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name,
  );
  assertions.check(value, `Missing button: ${name}`);
  return value!;
}

export async function testPrDetailOverviewIsLazyInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let core = 0,
    sessions = 0,
    models = 0;
  const detail = prDetailFixture(url);
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    searchParams: { keep: "retained" },
    procedures: {
      "prDetail.get": () => detail,
      "pr.core": () => {
        core++;
        return {
          diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          info: { owner: "browser-fixture", repo: "isolated", number: "1" },
          commits: [],
          headSha: "a".repeat(40),
          comparisonBaseSha: "b".repeat(40),
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
      "models.current": () => {
        models++;
        return { provider: "fixture", modelId: "offline", name: "Offline fixture" };
      },
    },
  });
  await wait(
    () => !!document.querySelector("[data-pr-overview] h1"),
    "Overview metadata did not load",
  );
  check(document.body.textContent?.includes("real Overview"), "Description missing");
  check(core === 0 && sessions === 0 && models === 0, "Overview created review work");
  check(
    !document.querySelector("diffs-container") && !document.getElementById("chat-panel"),
    "Overview mounted Changes",
  );
  check(
    !document.querySelector('button[title="Toggle file tree panel"]'),
    "Overview exposes files toolbar",
  );
  button(assertions, "Checks").click();
  await wait(
    () => document.body.textContent?.includes("No checks reported.") ?? false,
    "Checks tab not displayed",
  );
  check(core === 0 && sessions === 0, "Checks created review work");
  check(
    new URLSearchParams(location.search).get("keep") === "retained",
    "Tab switch removed query params",
  );
  history.back();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Back did not restore Overview");
  button(assertions, "Changes").click();
  await wait(
    () => !!document.querySelector("diffs-container") && !!document.getElementById("chat-panel"),
    "First Changes did not mount review",
  );
  const chat = document.getElementById("chat-panel");
  const diff = document.querySelector("diffs-container");
  const sessionCount = sessions;
  button(assertions, "Chat").click();
  await wait(
    () =>
      !!document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message review assistant"]:not(:disabled)',
      ),
    "Chat editor not ready",
  );
  const editor = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message review assistant"]',
  )!;
  editor.value = "Retained chat draft";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  editor.focus();
  editor.setSelectionRange(2, 7);
  button(assertions, "Overview").click();
  await wait(
    () => !!document.querySelector("[data-pr-overview]"),
    "Overview missing after Changes",
  );
  check(!!chat?.closest("[inert]"), "Hidden review is not inert");
  const shortcut = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    cancelable: true,
    bubbles: true,
  });
  window.dispatchEvent(shortcut);
  check(!shortcut.defaultPrevented, "Hidden diff intercepted browser search");
  button(assertions, "Changes").click();
  await wait(() => !chat?.closest("[inert]"), "Changes stayed inert");
  check(
    chat === document.getElementById("chat-panel") &&
      diff === document.querySelector("diffs-container"),
    "Tab switch rebuilt review subtree",
  );
  check(sessions === sessionCount && core === 1, "Tab switch repeated session/core work");
  await wait(() => document.activeElement === editor, "Chat focus not restored");
  check(
    editor.value === "Retained chat draft" &&
      editor.selectionStart === 2 &&
      editor.selectionEnd === 7,
    "Chat draft/caret lost across tabs",
  );
  return result();
}

export async function testPrDetailChecksAndPermissionsInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const detail = prDetailFixture(url);
  detail.checks = {
    status: "available",
    complete: false,
    data: [
      {
        id: "1",
        kind: "check-run",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: "https://github.com/check/1",
      },
      {
        id: "2",
        kind: "status-context",
        name: "deploy",
        status: "PENDING",
        conclusion: null,
        url: null,
      },
      {
        id: "3",
        kind: "check-run",
        name: "skipped",
        status: "COMPLETED",
        conclusion: "SKIPPED",
        url: null,
      },
      {
        id: "4",
        kind: "check-run",
        name: "cancelled",
        status: "COMPLETED",
        conclusion: "CANCELLED",
        url: null,
      },
      {
        id: "5",
        kind: "check-run",
        name: "broken",
        status: "COMPLETED",
        conclusion: "FAILURE",
        url: null,
      },
      {
        id: "6",
        kind: "check-run",
        name: "new status",
        status: "MYSTERY",
        conclusion: null,
        url: null,
      },
    ],
  };
  detail.mergeCapabilities = { status: "unavailable", message: "Repository permission denied" };
  let unavailable = false;
  await mountAppFixture({
    defaultTab: "checks",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () =>
        unavailable
          ? { ...detail, checks: { status: "unavailable", message: "Check API unavailable" } }
          : detail,
    },
  });
  await wait(
    () => document.body.textContent?.includes("Unknown") ?? false,
    "Unknown check status missing",
  );
  check(!!document.querySelector('a[href="https://github.com/check/1"]'), "Check URL missing");
  for (const value of ["Passed", "pending", "skipped", "cancelled", "failure", "incomplete"])
    check(document.body.textContent?.includes(value), `Missing check state ${value}`);
  unavailable = true;
  button(assertions, "Refresh checks").click();
  await wait(
    () => document.body.textContent?.includes("Check API unavailable") ?? false,
    "Checks error hidden",
  );
  button(assertions, "Overview").click();
  await wait(
    () => document.body.textContent?.includes("Repository permission denied") ?? false,
    "Merge permission failure hidden",
  );
  check(button(assertions, "Merge unavailable").disabled, "Unavailable merge enabled");
  check(
    !document.body.textContent?.includes("Admin Merge"),
    "Admin merge exposed without capability",
  );
  return result();
}

export async function testPrDetailMergeIsOneShotInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let detail: PrDetail = prDetailFixture(url);
  let writes = 0,
    reads = 0;
  let input: PrMergeInput | undefined;
  const attempt = (status: "uncertain" | "succeeded") => ({
    requestId: input!.requestId,
    url,
    expectedHeadSha: input!.expectedHeadSha,
    action: input!.action,
    status,
    message:
      status === "uncertain"
        ? "Connection lost after dispatch. Check outcome."
        : "GitHub reports merged",
    dispatched: true,
    updatedAt: new Date().toISOString(),
  });
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => detail,
      "prDetail.merge": (value) => {
        writes++;
        input = value as PrMergeInput;
        return attempt("uncertain");
      },
      "prDetail.reconcileMerge": () => {
        reads++;
        if (detail.metadata.status === "available")
          detail = {
            ...detail,
            metadata: { ...detail.metadata, data: { ...detail.metadata.data, state: "MERGED" } },
          };
        return attempt("succeeded");
      },
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [] }),
    },
  });
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
    "Merge panel missing",
  );
  button(assertions, "Create merge commit").click();
  await wait(
    () => document.body.textContent?.includes("Connection lost after dispatch") ?? false,
    "Uncertain result hidden",
  );
  check(writes === 1, "Merge not dispatched exactly once");
  check(
    input?.expectedHeadSha === "a".repeat(40) && input.expectedActor.id === "U_fixture_graphql",
    "Merge did not pin detail actor/head",
  );
  check(
    !!localStorage.getItem(`pr-merge-intent:${url}`),
    "Merge intent not persisted before dispatch",
  );
  button(assertions, "Checks").click();
  await wait(
    () => !!document.querySelector('section[aria-label="Pull request checks"]'),
    "Checks did not mount",
  );
  button(assertions, "Overview").click();
  await wait(
    () =>
      !![...document.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Check outcome",
      ),
    "Saved intent not restored",
  );
  check(writes === 1 && reads === 0, "Tab remount retried or reconciled automatically");
  button(assertions, "Check outcome").click();
  await wait(
    () => document.body.textContent?.includes("GitHub reports merged") ?? false,
    "Read-only outcome missing",
  );
  check(reads === 1 && writes === 1, "Outcome check retried merge");
  check(
    document.querySelector('section[aria-label="Merge pull request"] h2')?.textContent === "Merged",
    "Fresh merged metadata not displayed",
  );
  return result();
}

export async function testPrDetailReviewActionsUseOutboxInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let detail = prDetailFixture(url);
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => detail,
      "githubOutbox.enqueue": () => {
        throw new Error("Fixture offline; keep durable local intent");
      },
    },
  });
  await refreshGithubActor();
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Overview not ready");
  for (const [label, kind] of [
    ["Request changes", "request-changes"],
    ["Comment review", "review-comment"],
  ] as const) {
    button(assertions, label).click();
    await wait(
      () =>
        !!document.querySelector<HTMLTextAreaElement>('[aria-label="Review body"]:not(:disabled)'),
      "Review draft not ready",
    );
    const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Review body"]')!;
    check(button(assertions, "Submit review").disabled, "Blank review permitted");
    const capturedHead =
      detail.metadata.status === "available" ? detail.metadata.data.head.sha : "";
    if (detail.metadata.status === "available")
      detail = {
        ...detail,
        metadata: {
          ...detail.metadata,
          data: {
            ...detail.metadata.data,
            head: { ...detail.metadata.data.head, sha: "c".repeat(40) },
          },
        },
      };
    button(assertions, "Refresh details").click();
    await wait(
      () =>
        document
          .querySelector('section[aria-label="Merge pull request"]')
          ?.textContent?.includes("c".repeat(40)) ?? false,
      "Fresh detail head not applied",
    );
    editor.value = `Durable ${kind} review`;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    editor.form!.requestSubmit();
    await wait(
      () => !document.querySelector('[aria-label="Review body"]'),
      "Review editor did not queue locally",
    );
    const entries = await githubJournal.entries(githubPrScope(url));
    const action = entries.find((entry) => entry.command.action.kind === kind)?.command.action;
    check(
      action?.kind === kind && action.expectedHeadSha === capturedHead,
      "Review head changed after editor opened",
    );
    check(
      action?.kind === kind && action.body === `Durable ${kind} review`,
      "Review body not journaled",
    );
    check(
      document.body.textContent?.includes(`${label} pending`),
      "Queued review absent from projection",
    );
  }
  check(
    document
      .querySelector('section[aria-label="Review requirements"]')
      ?.textContent?.includes("REVIEW_REQUIRED"),
    "Queued review forged remote decision",
  );
  check(!document.querySelector("diffs-container"), "Review actions started diff/session work");
  return result();
}

export async function testPrDetailRejectedMergeDoesNotRetryInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const detail = prDetailFixture(url);
  let writes = 0;
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => detail,
      "prDetail.merge": (value) => {
        const input = value as PrMergeInput;
        writes++;
        return {
          ...input,
          status: "rejected",
          dispatched: false,
          message: "PR head changed. Refresh before merging.",
          updatedAt: new Date().toISOString(),
        };
      },
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [] }),
    },
  });
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
    "Merge panel missing",
  );
  button(assertions, "Create merge commit").click();
  await wait(
    () => document.body.textContent?.includes("PR head changed") ?? false,
    "Stale rejection hidden",
  );
  check(writes === 1, "Rejected merge retried");
  check(
    ![...document.querySelectorAll("button")].some(
      (entry) => entry.textContent === "Create merge commit",
    ),
    "Rejected one-shot intent offers blind retry",
  );
  check(
    document.querySelector('section[aria-label="Merge pull request"] h2')?.textContent !== "Merged",
    "Rejected merge optimistically marked merged",
  );
  return result();
}

export async function testPrDetailMergeReloadInBrowser(phase = "before") {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let writes = 0,
    reads = 0;
  const detail = prDetailFixture(url);
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => detail,
      "prDetail.merge": (value) => {
        writes++;
        const input = value as PrMergeInput;
        sessionStorage.setItem("merge-reload-id", input.requestId);
        return {
          ...input,
          status: "uncertain",
          message: "Dispatch uncertain; reload safely",
          dispatched: true,
          updatedAt: new Date().toISOString(),
        };
      },
      "prDetail.reconcileMerge": (value) => {
        reads++;
        const input = value as { url: string; requestId: string };
        check(
          input.requestId === sessionStorage.getItem("merge-reload-id"),
          "Reload generated a different merge identity",
        );
        return {
          ...input,
          expectedHeadSha: "a".repeat(40),
          action: { kind: "merge", method: "merge" },
          status: "uncertain",
          message: "Still uncertain; no write dispatched",
          dispatched: true,
          updatedAt: new Date().toISOString(),
          observed: { state: "MERGED", headSha: "b".repeat(40), queued: false },
        };
      },
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [] }),
    },
  });
  if (phase === "before") {
    await wait(
      () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
      "Merge panel missing",
    );
    button(assertions, "Create merge commit").click();
    await wait(
      () => document.body.textContent?.includes("Dispatch uncertain; reload safely") ?? false,
      "Uncertain response missing",
    );
    check(writes === 1, "Initial merge dispatch missing");
    return result();
  }
  await wait(
    () =>
      !![...document.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Check outcome",
      ),
    "Reload lost saved merge intent",
  );
  check(writes === 0 && reads === 0, "Reload automatically dispatched or reconciled");
  button(assertions, "Check outcome").click();
  await wait(
    () => document.body.textContent?.includes("Still uncertain; no write dispatched") ?? false,
    "Reload outcome check failed",
  );
  check(writes === 0 && reads === 1, "Reconciliation dispatched merge");
  check(
    document.querySelector('section[aria-label="Merge pull request"] h2')?.textContent ===
      "Observed merged" &&
      document.body.textContent?.includes(
        "does not confirm that this attempt merged the pinned head",
      ),
    "Observed merge falsely attributed to our pinned-head attempt",
  );
  return result();
}

export async function testPrDetailNavigationDiscardsLateResponsesInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  let release: (detail: PrDetail) => void = () => {};
  const delayed = new Promise<PrDetail>((resolve) => {
    release = resolve;
  });
  const nextUrl = url.replace("/1", "/2");
  const next = prDetailFixture(nextUrl, "c".repeat(40));
  if (next.metadata.status === "available") next.metadata.data.title = "Second pull request";
  let core = 0;
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": (input) => ((input as { url: string }).url === url ? delayed : next),
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "pr.core": () => {
        core++;
        throw new Error("Overview must not load core");
      },
    },
  });
  await wait(() => !!document.querySelector("[data-pr-overview]"), "First PR shell missing");
  history.pushState(null, "", `/review?prUrl=${encodeURIComponent(nextUrl)}&tab=overview`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await wait(
    () =>
      document
        .querySelector("[data-pr-overview] h1")
        ?.textContent?.includes("Second pull request") ?? false,
    "Second PR metadata missing",
  );
  release(prDetailFixture(url));
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    document.querySelector("[data-pr-overview] h1")?.textContent?.includes("Second pull request"),
    "Late first response replaced second PR",
  );
  check(
    document
      .querySelector('section[aria-label="Merge pull request"]')
      ?.textContent?.includes("c".repeat(40)),
    "Late response changed merge head",
  );
  check(
    core === 0 && !document.getElementById("chat-panel"),
    "Overview PR navigation created review work",
  );
  return result();
}

export async function testPrDetailUnknownDiscussionAndDismissedReviewInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const detail = prDetailFixture(url);
  detail.reviews = {
    status: "available",
    complete: false,
    data: [
      {
        id: "R_dismissed",
        author: "reviewer",
        state: "DISMISSED",
        body: "Earlier review was dismissed",
        submittedAt: "2026-01-01T00:00:00Z",
        url: `${url}#pullrequestreview-70`,
        commitSha: "a".repeat(40),
      },
    ],
  };
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: {
      status: null,
      issueComments: [],
      comments: [
        {
          id: 1,
          node_id: "RC_unknown",
          path: "src/example.ts",
          line: 9,
          original_line: 9,
          side: "RIGHT",
          body: "Discussion with unknown resolution",
          html_url: `${url}#discussion_r1`,
          user: { login: "reviewer", avatar_url: "" },
          created_at: "2026-01-01T00:00:00Z",
          canEdit: false,
        },
      ],
    },
    procedures: { "prDetail.get": () => detail },
  });
  await wait(
    () => document.body.textContent?.includes("Earlier review was dismissed") ?? false,
    "Dismissed review missing",
  );
  check(
    document
      .querySelector('section[aria-label="Review events"]')
      ?.textContent?.includes("dismissed"),
    "Dismissed state dropped",
  );
  check(
    document.body.textContent?.includes("Review activity is incomplete"),
    "Incomplete review evidence hidden",
  );
  check(
    document.body.textContent?.includes("Thread resolution unknown"),
    "Unknown thread mislabeled unresolved",
  );
  check(
    ![...document.querySelectorAll("button")].some(
      (entry) => entry.textContent?.trim() === "Resolve",
    ),
    "Unknown thread offered guessed resolution action",
  );
  button(assertions, "Unresolved").click();
  await wait(
    () => !document.body.textContent?.includes("Discussion with unknown resolution"),
    "Unknown thread counted as known unresolved",
  );
  button(assertions, "All").click();
  await wait(
    () => !!document.querySelector('[data-github-comment-key="remote:review-comment:1"]'),
    "All discussions did not restore unknown thread",
  );
  button(assertions, "src/example.ts:9 · RIGHT · revision unavailable").click();
  await wait(
    () =>
      document.body.textContent?.includes("GitHub did not provide a trustworthy source revision") ??
      false,
    "Unknown source was silently mapped to HEAD",
  );
  check(
    new URLSearchParams(location.search).get("tab") === "changes",
    "Source click did not activate Changes",
  );
  return result();
}

export async function testPrDetailMergeDisabledStatesInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let detail = prDetailFixture(url);
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: { "prDetail.get": () => detail, "prDetail.refresh": () => detail },
  });
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
    "Merge panel missing",
  );
  const labels = {
    CLOSED: "Closed",
    MERGED: "Merged",
    DRAFT: "Draft: not ready to merge",
    CONFLICTING: "Resolve conflicts to merge",
    QUEUED: "Already queued",
    UNKNOWN: "Merge unavailable",
  };
  for (const state of ["CLOSED", "MERGED", "DRAFT", "CONFLICTING", "QUEUED", "UNKNOWN"] as const) {
    detail = prDetailFixture(url);
    if (detail.metadata.status === "available") {
      if (state === "CLOSED" || state === "MERGED") detail.metadata.data.state = state;
      if (state === "DRAFT") detail.metadata.data.draft = true;
    }
    if (detail.mergeCapabilities.status === "available") {
      if (state === "CONFLICTING") {
        detail.mergeCapabilities.data.mergeable = state;
        detail.mergeCapabilities.data.actions.forEach((entry) => {
          entry.enabled = false;
        });
      }
      if (state === "QUEUED")
        detail.mergeCapabilities.data.queueEntry = { id: "queue1", position: 2 };
    }
    if (state === "UNKNOWN")
      detail.mergeCapabilities = { status: "unavailable", message: "Merge state unknown" };
    button(assertions, "Refresh details").click();
    await wait(
      () =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            'section[aria-label="Merge pull request"] button',
          ),
        ].some((entry) => entry.textContent === labels[state]),
      `Missing ${state} merge state`,
    );
    check(button(assertions, labels[state]).disabled, `${state} merge action enabled`);
  }
  return result();
}

export async function testPrDetailHistoricalSourceKeepsProvenanceInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const historical = "c".repeat(40);
  const comment = {
    id: 2,
    node_id: "RC_historic",
    path: "src/example.ts",
    line: null,
    original_line: 200,
    side: "RIGHT" as const,
    original_commit_id: historical,
    commit_id: "a".repeat(40),
    body: "Historical source comment",
    html_url: `${url}#discussion_r2`,
    user: { login: "reviewer", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    canEdit: false,
  };
  let request:
    | { sessionId: string; path: string; line: number; side: string; ref: string }
    | undefined;
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: {
      status: null,
      issueComments: [],
      comments: [
        comment,
        {
          ...comment,
          id: 3,
          node_id: "RC_historic_left",
          side: "LEFT",
          body: "Historical deleted-side comment",
        },
      ],
    },
    procedures: {
      "prReview.navigateSource": (input) => {
        request = input as typeof request;
        return { status: "missing", notice: "Original source snapshot unavailable" };
      },
    },
  });
  await wait(
    () => document.body.textContent?.includes("Historical source comment") ?? false,
    "Historical discussion missing",
  );
  check(
    !request && !document.getElementById("chat-panel"),
    "Overview resolved source or created session implicitly",
  );
  button(assertions, "src/example.ts:200 · RIGHT · ccccccc (original location)").click();
  await wait(() => !!request, "Historical source did not navigate after Changes activation");
  check(
    new URLSearchParams(location.search).get("tab") === "changes",
    "Source navigation did not activate Changes",
  );
  check(
    request?.ref === historical &&
      request.line === 200 &&
      request.side === "RIGHT" &&
      request.path === "src/example.ts",
    "Historical source remapped to current head/line",
  );
  check(request?.sessionId === "bootstrap", "Source navigation lost active session provenance");
  await wait(
    () => document.body.textContent?.includes("Original source snapshot unavailable") ?? false,
    "Missing exact source was hidden",
  );
  button(assertions, "Overview").click();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Overview did not return");
  button(assertions, "src/example.ts:200 · LEFT · ccccccc (original location)").click();
  await wait(
    () =>
      document.body.textContent?.includes("not the immutable deleted-side source revision") ??
      false,
    "Historical LEFT source falsely used its comparison head",
  );
  check(request?.side === "RIGHT", "Historical LEFT coordinate sent as exact HEAD source");
  return result();
}

export async function testPrDetailProjectionIndependentReadsInBrowser() {
  const { check, result } = createAssertions(5000);
  for (const detailFirst of [true, false]) {
    const current = `https://github.com/browser-fixture/isolated/pull/${detailFirst ? 91 : 92}`;
    const detail = prDetailFixture(current);
    detail.reviews = {
      status: "available",
      complete: true,
      data: [
        {
          id: "R1",
          author: "reviewer",
          state: "DISMISSED",
          body: "Dismissed remotely",
          submittedAt: null,
          url: `${current}#pullrequestreview-70`,
          commitSha: "a".repeat(40),
        },
      ],
    };
    const issue = {
      id: 10,
      body: "Fresh conversation",
      html_url: `${current}#issuecomment-10`,
      user: { login: "reviewer", avatar_url: "" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      canEdit: false,
    };
    const commentsToken = beginGithubCommentRead(current);
    const detailToken = beginGithubCommentRead(current);
    const acceptComments = () =>
      acceptGithubCommentRead(commentsToken, { comments: [], issueComments: [issue] });
    const acceptDetail = () => acceptGithubDetailRead(detailToken, detail);
    check(
      detailFirst ? acceptDetail() && acceptComments() : acceptComments() && acceptDetail(),
      "Sibling resource rejected fresh evidence due to response order",
    );
    const view = projectGithubComments(current);
    check(
      view.comments[0]?.body === "Fresh conversation" && view.reviews[0]?.state === "DISMISSED",
      "Merged detail/extras snapshot lost sibling evidence or dismissed state",
    );
    const older = beginGithubCommentRead(current),
      newer = beginGithubCommentRead(current);
    check(
      acceptGithubCommentRead(newer, {
        comments: [],
        issueComments: [{ ...issue, body: "Newer" }],
      }),
      "Newer comments read rejected",
    );
    check(
      !acceptGithubCommentRead(older, {
        comments: [],
        issueComments: [{ ...issue, body: "Older" }],
      }),
      "Older comments read overwrote newer evidence",
    );
    check(
      projectGithubComments(current).comments[0]?.body === "Newer",
      "Old comments leaked through resource fence",
    );
  }
  return result();
}
