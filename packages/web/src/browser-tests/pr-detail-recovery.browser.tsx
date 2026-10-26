import type { PrMergeInput } from "@better-review/shared";

import { refreshPrDetail, queryClient, queryKeys } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
function findButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
}
function button(assertions: Pick<ReturnType<typeof createAssertions>, "check">, label: string) {
  const found = findButton(label);
  assertions.check(found, `Missing button: ${label}`);
  return found!;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function testPrDetailRejectedMergeNewAttemptInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  let detail = prDetailFixture(url);
  const commands: PrMergeInput[] = [];
  let applied = 0;
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.get": () => detail,
      "prDetail.refresh": () => detail,
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [] }),
      "prDetail.merge": (value) => {
        const input = value as PrMergeInput;
        commands.push(input);
        if (commands.length > 1) applied++;
        return {
          ...input,
          status: commands.length === 1 ? "rejected" : "uncertain",
          dispatched: commands.length > 1,
          message:
            commands.length === 1 ? "Preflight rejected old head" : "Uncertain after dispatch",
          updatedAt: new Date().toISOString(),
        };
      },
    },
  });
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
    "Merge panel not ready",
  );
  button(assertions, "Create merge commit").click();
  await wait(
    () => document.body.textContent?.includes("Preflight rejected old head") ?? false,
    "Rejection missing",
  );
  check(applied === 0, "Preflight rejection dispatched");
  // Keep polling lookups uncounted; the wait counts terminal success once.
  await wait(() => {
    const outcome = findButton("Check outcome");
    if (!outcome) throw new Error("Missing button: Check outcome");
    return !outcome.disabled;
  }, "Rejected attempt refresh did not settle");
  detail = prDetailFixture(url, "c".repeat(40));
  if (detail.actor.status === "available")
    detail.actor.data = { id: "U_new_actor", login: "new-actor" };
  button(assertions, "Refresh details").click();
  await wait(() => {
    const cached = queryClient.getQueryData<ReturnType<typeof prDetailFixture>>(
      queryKeys.pr.detail(url),
    );
    return cached?.actor.status === "available" && cached.actor.data.id === "U_new_actor";
  }, "Fresh actor not loaded");
  check(commands.length === 1, "Refresh retried rejected attempt");
  button(assertions, "Checks").click();
  await wait(
    () => !!document.querySelector('section[aria-label="Pull request checks"]'),
    "Checks not mounted",
  );
  button(assertions, "Overview").click();
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"]'),
    "Overview not restored",
  );
  check(commands.length === 1, "Remount retried rejected attempt");
  button(assertions, "New merge attempt").click();
  await wait(() => commands.length === 2, "Explicit new attempt did not dispatch");
  check(commands[1]!.requestId !== commands[0]!.requestId, "New attempt reused old UUID");
  check(
    commands[1]!.expectedHeadSha === "c".repeat(40) &&
      commands[1]!.expectedActor.id === "U_new_actor",
    "New attempt did not pin fresh actor/head",
  );
  const history = localStorage.getItem(`pr-merge-intent:${url}:history:${commands[0]!.requestId}`);
  check(
    history && JSON.parse(history).outcome.status === "rejected",
    "Old rejected history overwritten",
  );
  await wait(
    () => document.body.textContent?.includes("Uncertain after dispatch") ?? false,
    "Second outcome missing",
  );
  check(
    applied === 1 &&
      ![...document.querySelectorAll("button")].some(
        (entry) => entry.textContent === "New merge attempt",
      ),
    "Uncertain attempt permits another dispatch",
  );
  return result();
}

export async function testPrDetailHistoryRestoresEditorFocusInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  await mountAppFixture({ searchParams: { showChat: "1" } });
  await wait(
    () =>
      !!document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message review assistant"]:not(:disabled)',
      ),
    "Chat not ready",
  );
  const initialEditor = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message review assistant"]',
  )!;
  initialEditor.focus();
  initialEditor.setSelectionRange(0, 0);
  button(assertions, "Overview").click();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Overview missing");
  button(assertions, "Changes").click();
  await wait(
    () => !document.getElementById("chat-panel")?.closest("[inert]"),
    "Changes not active",
  );
  const editor = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Message review assistant"]',
  )!;
  editor.value = "History retained draft";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  editor.focus();
  editor.setSelectionRange(3, 10, "backward");
  history.back();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Back did not restore Overview");
  history.forward();
  await wait(
    () => !document.getElementById("chat-panel")?.closest("[inert]"),
    "Forward did not restore Changes",
  );
  await new Promise(requestAnimationFrame);
  check(document.activeElement === editor, "History navigation lost editor focus");
  check(
    editor.value === "History retained draft" &&
      editor.selectionStart === 3 &&
      editor.selectionEnd === 10 &&
      editor.selectionDirection === "backward",
    "History navigation lost draft/caret",
  );
  history.back();
  await wait(() => !!document.querySelector("[data-pr-overview]"), "Second Back failed");
  const external = document.createElement("textarea");
  document.body.append(external);
  external.focus();
  history.forward();
  await wait(
    () => !document.getElementById("chat-panel")?.closest("[inert]"),
    "Second Forward failed",
  );
  await new Promise(requestAnimationFrame);
  check(document.activeElement === external, "History navigation stole unrelated editor focus");
  external.remove();
  return result();
}

export async function testPrDetailRefreshSingleFlightInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result: assertionResult } = assertions;
  const held = gate<ReturnType<typeof prDetailFixture>>();
  let reads = 0;
  let fail = false;
  const otherUrl = url.replace("/1", "/2");
  const perPr = new Map<string, number>();
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.refresh": (value) => {
        const current = (value as { url: string }).url;
        perPr.set(current, (perPr.get(current) ?? 0) + 1);
        if (current !== url) return prDetailFixture(current);
        reads++;
        if (fail) throw new Error("Fixture refresh unavailable");
        if (reads === 1) return held.promise;
        return prDetailFixture(current, "c".repeat(40));
      },
    },
  });
  await wait(() => !!document.querySelector("[data-pr-overview] h1"), "Overview not ready");
  for (let index = 0; index < 5; index++) button(assertions, "Refresh details").click();
  await wait(() => reads > 0, "Refresh did not start");
  await new Promise((resolve) => setTimeout(resolve, 40));
  check(reads === 1, `Five clicks dispatched ${reads} reads`);
  await refreshPrDetail(otherUrl);
  check(perPr.get(otherUrl) === 1 && reads === 1, "Independent PR refresh blocked or duplicated");
  const fresh = refreshPrDetail(url, { afterWrite: true });
  const joined = refreshPrDetail(url, { afterWrite: true });
  held.resolve(prDetailFixture(url, "b".repeat(40)));
  const [result] = await Promise.all([fresh, joined]);
  check(
    reads === 2 &&
      result.metadata.status === "available" &&
      result.metadata.data.head.sha === "c".repeat(40),
    "Confirmed write joined a pre-write read instead of one fresh follow-up",
  );
  const cached = queryClient.getQueryData<ReturnType<typeof prDetailFixture>>(
    queryKeys.pr.detail(url),
  );
  check(
    cached?.metadata.status === "available" && cached.metadata.data.head.sha === "c".repeat(40),
    "Pre-write read overwrote fresh detail cache",
  );
  fail = true;
  const failures = await Promise.allSettled([refreshPrDetail(url), refreshPrDetail(url)]);
  check(
    failures.every((entry) => entry.status === "rejected") && reads === 3,
    "Failed refresh did not share flight",
  );
  fail = false;
  await refreshPrDetail(url);
  check(reads === 4, "Failed refresh did not release per-PR key");
  return assertionResult();
}

export async function testPrDetailConfirmedMergeQueuesFreshReadInBrowser() {
  const assertions = createAssertions(5000);
  const { check, wait, result } = assertions;
  const held = gate<ReturnType<typeof prDetailFixture>>();
  let reads = 0,
    writes = 0;
  const fresh = prDetailFixture(url);
  if (fresh.metadata.status === "available") {
    fresh.metadata.data.title = "Post-write fresh snapshot";
    fresh.metadata.data.state = "MERGED";
  }
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    procedures: {
      "prDetail.refresh": () => (++reads === 1 ? held.promise : fresh),
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [] }),
      "prDetail.merge": (value) => {
        writes++;
        return {
          ...(value as PrMergeInput),
          status: "succeeded",
          dispatched: true,
          message: "Merge confirmed",
          updatedAt: new Date().toISOString(),
        };
      },
    },
  });
  await wait(
    () => !!document.querySelector('section[aria-label="Merge pull request"] button'),
    "Merge not ready",
  );
  button(assertions, "Refresh details").click();
  await wait(() => reads === 1, "Pre-write read did not start");
  button(assertions, "Create merge commit").click();
  await wait(
    () => document.body.textContent?.includes("Merge confirmed") ?? false,
    "Write confirmation missing",
  );
  await new Promise(requestAnimationFrame);
  let staleUi = false,
    staleCache = false;
  const observer = new MutationObserver(() => {
    staleUi ||=
      document
        .querySelector("[data-pr-overview] h1")
        ?.textContent?.includes("Pre-write stale snapshot") ?? false;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    const value = queryClient.getQueryData<ReturnType<typeof prDetailFixture>>(
      queryKeys.pr.detail(url),
    );
    staleCache ||=
      value?.metadata.status === "available" &&
      value.metadata.data.title === "Pre-write stale snapshot";
  });
  try {
    const old = prDetailFixture(url);
    if (old.metadata.status === "available") old.metadata.data.title = "Pre-write stale snapshot";
    held.resolve(old);
    await wait(
      () =>
        document
          .querySelector("[data-pr-overview] h1")
          ?.textContent?.includes("Post-write fresh snapshot") ?? false,
      "Confirmed merge did not apply fresh follow-up",
    );
    check(reads === 2 && writes === 1, "Write confirmation did not queue exactly one fresh read");
    check(!staleUi && !staleCache, "Pre-write response published after confirmed merge");
    return result();
  } finally {
    observer.disconnect();
    unsubscribe();
  }
}
