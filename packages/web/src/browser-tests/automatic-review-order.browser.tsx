import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { ReviewSnapshot } from "@better-review/shared";

import { ChatPanel } from "../ChatPanel";
import {
  AUTO_ORDER_PREFERENCE_KEY,
  type AvailableReviewOrder,
} from "../lib/automatic-review-order";
import { getReviewOrder, restoreCache } from "../lib/query";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    clickAndTypeBrowserControl(selector: string, text: string): Promise<void>;
  }
}

const url = "https://github.com/browser-fixture/isolated/pull/1";
const head = "a".repeat(40);
const paths = ["src/first.ts", "src/second.ts", "src/third.ts"];
const rawDiff = paths
  .map(
    (path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,80 +1,80 @@\n-old\n+new\n${Array.from({ length: 79 }, (_, i) => ` line ${i}`).join("\n")}\n`,
  )
  .join("");

export async function testDelayedAutomaticReviewOrderInBrowser() {
  return testAutomaticReviewOrderInBrowser("delayed");
}

export async function testAutomaticReviewOrderInBrowser(mode = "existing") {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 300 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const reversed = [paths[2], paths[0], paths[1]];
  const complete: ReviewSnapshot = {
    sessionId: "bootstrap",
    revision: head,
    running: false,
    compacting: false,
    settlements: [{ submissionId: "run", outcome: "completed" }],
    messages: [
      {
        id: "order",
        role: "assistant",
        submissionId: "run",
        metadata: { revision: head, timestamp: "2026-01-01" },
        parts: [
          { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(reversed)}<</REVIEW_ORDER>>` },
        ],
      },
    ],
  };
  const manual = [paths[1], paths[0], paths[2]];
  complete.messages.unshift({
    ...complete.messages[0],
    id: "historical-manual-order",
    submissionId: undefined,
    metadata: { revision: "old-head", timestamp: "2025-01-01" },
    parts: [{ type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(manual)}<</REVIEW_ORDER>>` }],
  });
  let snapshot: ReviewSnapshot =
    mode === "delayed" ? { ...complete, running: true, settlements: [] } : complete;
  localStorage.removeItem(AUTO_ORDER_PREFERENCE_KEY);
  localStorage.removeItem("better-review:applied-review-orders");
  await mountAppFixture({
    diff: rawDiff,
    reviewSnapshot: () => snapshot,
    extras: {
      comments: [
        {
          id: 20,
          node_id: "fixture-review-node",
          body: "Inline fixture",
          path: paths[1],
          line: 9,
          original_line: 9,
          side: "RIGHT",
          canEdit: true,
          html_url: `${url}#discussion_r20`,
          user: { login: "browser-fixture", avatar_url: "" },
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      issueComments: [],
      status: null,
    },
  });
  const fileElements = () => [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')];
  const order = () =>
    fileElements()
      .map((element) => decodeURIComponent(element.id.slice(5)))
      .join(",");
  await wait(() => fileElements().length === 3, "Three files not mounted");
  check(order() === paths.join(","), "Default off reordered files");
  const originalNodes = fileElements();
  const anchor = originalNodes[1];
  const scroll = anchor.closest(".overflow-y-auto.pb-3") as HTMLElement;
  await new Promise((resolve) => setTimeout(resolve, 500));
  scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 50;
  await new Promise(requestAnimationFrame);
  const offset = anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const settings = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Review settings"]',
  )!;
  settings.click();
  await wait(
    () => !!document.querySelector('[role="dialog"][aria-label="Review settings"]:popover-open'),
    "Settings did not open",
  );
  const toggle = document.querySelector<HTMLInputElement>(
    '[role="dialog"][aria-label="Review settings"] input',
  )!;
  check(!toggle.checked, "Preference did not default off");
  toggle.click();
  let editor: HTMLTextAreaElement | undefined;
  if (mode === "delayed") {
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(order() === paths.join(","), "Applied a streaming order");
    const card = document.querySelector('[data-github-comment-key="remote:review-comment:20"]')!;
    [...card.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Edit")!
      .click();
    await wait(() => !!card.querySelector("textarea:not(:disabled)"), "Inline editor did not open");
    editor = card.querySelector("textarea")!;
    editor.value = "unsent editor text";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(3, 7);
    check(
      document.activeElement === editor,
      `Editor not focusable before reorder: disabled=${editor.disabled}`,
    );
    snapshot = complete;
  }
  await wait(() => order() === reversed.join(","), "Existing/completed order not applied");
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  check(
    fileElements().every((element) => originalNodes.includes(element)),
    "Reorder remounted file/editor nodes",
  );
  if (editor) {
    check(
      editor.isConnected && document.activeElement === editor,
      `Reorder lost focused editor: connected=${editor.isConnected}, active=${document.activeElement?.outerHTML.slice(0, 180)}`,
    );
    check(
      editor.value === "unsent editor text" &&
        editor.selectionStart === 3 &&
        editor.selectionEnd === 7,
      "Reorder lost draft or caret",
    );
  }
  check(
    Math.abs(anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset) < 3,
    `Visible file scroll anchor jumped: before ${offset}, after ${anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top}`,
  );
  check(
    JSON.parse(localStorage.getItem(AUTO_ORDER_PREFERENCE_KEY)!).enabled === true,
    "Preference not persisted",
  );
  toggle.focus();
  await window.dismissBrowserPopover("escape");
  await wait(
    () => !document.querySelector('[aria-label="Review settings"]:popover-open'),
    "Escape did not close settings",
  );
  await wait(() => document.activeElement === settings, "Escape did not return focus");
  // Exercise the production manual Apply order action after automatic application.
  document.querySelector<HTMLButtonElement>('[aria-controls="chat-panel"]')!.click();
  const apply = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Apply order"),
    );
  await wait(() => !!apply(), "Manual order action disappeared");
  apply()!.click();
  const saved = getReviewOrder(url);
  check(saved?.join(",") === manual.join(","), "Manual apply unavailable after auto");
  await wait(() => order() === manual.join(","), "Manual override did not reorder DOM");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === manual.join(","), "Repeated snapshots undid manual override");
  settings.click();
  await wait(
    () => !!document.querySelector('[aria-label="Review settings"]:popover-open'),
    "Reopen failed",
  );
  toggle.click();
  snapshot = {
    ...complete,
    messages: [
      {
        ...complete.messages[1],
        id: "new-order",
        parts: [
          { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(paths)}<</REVIEW_ORDER>>` },
        ],
      },
    ],
  };
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === manual.join(","), "Turning off reset/applied another order");
  const outsideSelector = editor
    ? '[data-github-comment-key="remote:review-comment:20"] textarea'
    : '[aria-label="Message review assistant"]';
  await window.clickAndTypeBrowserControl(outsideSelector, "outside click typing");
  await wait(
    () => !document.querySelector('[aria-label="Review settings"]:popover-open'),
    "Outside click did not close settings",
  );
  const outsideEditor = document.querySelector<HTMLTextAreaElement>(outsideSelector)!;
  check(
    document.activeElement === outsideEditor &&
      outsideEditor.value.includes("outside click typing"),
    "Outside dismissal stole editor focus or typing",
  );
  return { passed };
}

/** The runner reloads the document between phases, preserving only browser storage. */
export async function testAutomaticReviewOrderReloadInBrowser(phase = "before") {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const ai = [paths[2], paths[0], paths[1]],
    manual = [paths[1], paths[0], paths[2]];
  restoreCache();
  if (phase === "after")
    await wait(
      () => getReviewOrder(url)?.join(",") === manual.join(","),
      "Query cache did not restore manual order",
    );
  const snapshot: ReviewSnapshot = {
    sessionId: "bootstrap",
    revision: head,
    running: false,
    compacting: false,
    settlements: [],
    messages: [manual, ai].map((order, index) => ({
      id: `reload-${index}`,
      role: "assistant",
      metadata: { revision: index ? head : "old", timestamp: "2026-01-01" },
      parts: [{ type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(order)}<</REVIEW_ORDER>>` }],
    })),
  };
  if (phase === "before") {
    localStorage.setItem(AUTO_ORDER_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: true }));
    localStorage.removeItem("better-review:applied-review-orders");
  }
  await mountAppFixture({ diff: rawDiff, reviewSnapshot: () => snapshot });
  const order = () =>
    [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')]
      .map((element) => decodeURIComponent(element.id.slice(5)))
      .join(",");
  if (phase === "before") {
    await wait(
      () => order() === ai.join(","),
      "Saved enabled preference did not apply existing order",
    );
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Apply order"),
    );
    check(button, "Manual action missing");
    button!.click();
    await wait(() => order() === manual.join(","), "Manual override failed before reload");
    await new Promise((resolve) => setTimeout(resolve, 200));
  } else {
    await wait(() => order() === manual.join(","), "Reload lost manual order");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    check(order() === manual.join(","), "Reload reapplied consumed AI order");
    document.querySelector<HTMLButtonElement>('button[aria-label="Review settings"]')!.click();
    check(
      document.querySelector<HTMLInputElement>('[aria-label="Review settings"] input')?.checked,
      "Reload lost enabled toggle",
    );
  }
  return { passed };
}

export async function testAutomaticReviewOrderPrSwitchInBrowser() {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const secondUrl = url.replace("/1", "/2");
  localStorage.setItem(AUTO_ORDER_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: true }));
  localStorage.removeItem("better-review:applied-review-orders");
  const ai = [...paths].reverse();
  const stale: ReviewSnapshot = {
    sessionId: "bootstrap",
    revision: head,
    running: false,
    compacting: false,
    settlements: [],
    messages: [
      {
        id: "pr1-order",
        role: "assistant",
        metadata: { timestamp: "2026-01-01", revision: head },
        parts: [{ type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(ai)}<</REVIEW_ORDER>>` }],
      },
    ],
  };
  const dispose = await mountAppFixture({
    diff: rawDiff,
    reviewSnapshot: () => stale,
  });
  const order = () =>
    [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')]
      .map((element) => decodeURIComponent(element.id.slice(5)))
      .join(",");
  await wait(() => order() === ai.join(","), "Initial PR order did not apply");
  dispose();
  await mountAppFixture({
    prUrl: secondUrl,
    diff: rawDiff,
    reviewSnapshot: () => stale,
    procedures: {
      "prReview.getOrCreateSession": () => ({
        session: { id: "bootstrap-other" },
        sessions: [],
        headSha: head,
        sessionHeadSha: head,
        sessionScope: { mode: "full", commitSha: null },
      }),
    },
  });
  await wait(
    () => location.search.includes(encodeURIComponent(secondUrl)),
    "Second PR did not load",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === paths.join(","), "Previous PR/session order leaked into next PR");
  check(getReviewOrder(secondUrl) === null, "Stale order persisted for second PR");
  return { passed };
}

/** Hydrate/switch through production tRPC receipts. All conversations share the viewed head SHA. */
export async function testAutomaticReviewOrderSavedScopeInBrowser() {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  localStorage.setItem(AUTO_ORDER_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: true }));
  localStorage.removeItem("better-review:applied-review-orders");
  const ids = ["bootstrap-commit", "bootstrap-unknown", "bootstrap-full"];
  const partial = [paths[2], paths[0]],
    full = [paths[1], paths[2], paths[0]];
  const sessions = ids.map((id, index) => ({
    id,
    headSha: head,
    createdAt: index + 1,
    hidden: false,
  }));
  const receipt = (id: string) => ({
    session: { id },
    sessions,
    headSha: head,
    sessionHeadSha: head,
    ...(id === "bootstrap-unknown"
      ? {}
      : {
          sessionScope:
            id === "bootstrap-commit"
              ? { mode: "commit", commitSha: head }
              : { mode: "full", commitSha: null },
        }),
  });
  await mountAppFixture({
    diff: rawDiff,
    procedures: {
      "prReview.getOrCreateSession": () => receipt(ids[0]),
      "prReview.switch": (input) => {
        if (
          !input ||
          typeof input !== "object" ||
          !("sessionId" in input) ||
          typeof input.sessionId !== "string"
        )
          throw Error("Missing session ID");
        return receipt(input.sessionId);
      },
    },
    reviewSnapshot: (sessionId) => ({
      sessionId,
      revision: head,
      running: false,
      compacting: false,
      settlements: [],
      messages: [
        {
          id: `${sessionId}-order`,
          role: "assistant",
          metadata: { revision: head, timestamp: "2026-01-01" },
          parts: [
            {
              type: "text",
              text: `<<REVIEW_ORDER>>${JSON.stringify(sessionId === "bootstrap-full" ? full : partial)}<</REVIEW_ORDER>>`,
            },
          ],
        },
      ],
    }),
  });
  document.querySelector<HTMLButtonElement>('[aria-controls="chat-panel"]')!.click();
  const order = () =>
    [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')]
      .map((element) => decodeURIComponent(element.id.slice(5)))
      .join(",");
  const apply = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Apply order",
    );
  await wait(() => !!apply(), "Commit transcript did not hydrate in full PR view");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === paths.join(","), "Commit-at-head order automatically applied to full PR");
  apply()!.click();
  const manualOrder = [paths[2], paths[0], paths[1]].join(",");
  await wait(() => order() === manualOrder, "Historical/wrong-scope manual apply disappeared");
  const select = async (index: number) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Session ${index}"]`,
    )!;
    check(trigger, "Session selector not available");
    trigger.click();
    const choice = [
      ...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button"),
    ].find((button) => button.textContent?.trim().startsWith(`Session ${index + 1}`));
    check(choice, "Saved session not listed");
    choice!.click();
    await wait(
      () => !!document.querySelector(`button[aria-label="Session ${index + 1}"]`),
      "Saved session switch did not hydrate",
    );
  };
  await select(1);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === manualOrder, "Unknown saved scope guessed from full PR UI");
  await select(2);
  await wait(() => order() === full.join(","), "Matching saved full PR order was rejected");
  return { passed };
}

export async function testAutomaticReviewOrderPullChangedHeadInBrowser() {
  return testAutomaticReviewOrderPullLatestInBrowser("changed-head");
}

/** Same-SHA commit-to-full conversion cannot replay pre-conversion orders. */
export async function testAutomaticReviewOrderPullLatestInBrowser(mode = "same-head") {
  let passed = 0,
    pulls = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const latest = mode === "changed-head" ? "c".repeat(40) : head;
  const oldOrder = [paths[2], paths[0]],
    fullOrder = [paths[1], paths[2], paths[0]];
  let snapshot: ReviewSnapshot = {
    sessionId: "bootstrap",
    revision: head,
    running: false,
    compacting: false,
    settlements: [{ submissionId: "old-commit", outcome: "completed" }],
    messages: [
      {
        id: "old-commit-order",
        submissionId: "old-commit",
        role: "assistant",
        metadata: { timestamp: "2026-01-01", revision: head },
        parts: [
          { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(oldOrder)}<</REVIEW_ORDER>>` },
        ],
      },
    ],
  };
  localStorage.setItem(AUTO_ORDER_PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: true }));
  localStorage.removeItem("better-review:applied-review-orders");
  await mountAppFixture({
    diff: rawDiff,
    headSha: latest,
    reviewSnapshot: () => snapshot,
    procedures: {
      "prReview.getOrCreateSession": () => ({
        session: { id: "bootstrap" },
        sessions: [],
        headSha: latest,
        sessionHeadSha: head,
        sessionScope: { mode: "commit", commitSha: head },
      }),
      "prReview.pullLatest": () => ({
        changed: ++pulls === 1,
        headSha: latest,
        session: { id: "bootstrap" },
        sessionScope: { mode: "full", commitSha: null, afterSubmissionId: "full-continuation" },
      }),
    },
  });
  document.querySelector<HTMLButtonElement>('[aria-controls="chat-panel"]')!.click();
  const order = () =>
    [...document.querySelectorAll<HTMLElement>('[id^="file-src"]')]
      .map((element) => decodeURIComponent(element.id.slice(5)))
      .join(",");
  const pull = () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Review actions"]')!.click();
    [...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")]
      .find((button) => button.textContent?.includes("Pull latest & continue"))!
      .click();
  };
  await wait(
    () => document.body.textContent?.includes("Review order") ?? false,
    "Saved commit transcript did not arrive",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === paths.join(","), "Wrong-scope old commit order applied before Pull");
  pull();
  await wait(
    () =>
      document.body.textContent?.includes("Continuing the review in this conversation.") ?? false,
    "Pull scope conversion did not hydrate",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === paths.join(","), "Hydrating full scope replayed stale same-SHA commit order");
  snapshot = {
    ...snapshot,
    revision: latest,
    running: true,
    messages: [
      ...snapshot.messages,
      {
        id: "pull-boundary",
        submissionId: "full-continuation",
        role: "user",
        metadata: { timestamp: "2026-01-02", revision: latest },
        parts: [{ type: "text", text: "Pulled the latest full PR into this review session." }],
      },
      {
        id: "full-order",
        submissionId: "full-continuation",
        role: "assistant",
        metadata: { timestamp: "2026-01-02", revision: latest },
        parts: [
          { type: "text", text: `<<REVIEW_ORDER>>${JSON.stringify(fullOrder)}<</REVIEW_ORDER>>` },
        ],
      },
    ],
  };
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(order() === paths.join(","), "Partial converted full review applied before completion");
  snapshot = {
    ...snapshot,
    running: false,
    settlements: [
      ...snapshot.settlements,
      { submissionId: "full-continuation", outcome: "completed" },
    ],
  };
  await wait(
    () => order() === fullOrder.join(","),
    "Completed converted full review stayed blocked by stale commit scope",
  );
  await wait(
    () =>
      !document.querySelector<HTMLButtonElement>('button[aria-label="Review actions"]')?.disabled,
    "Completed review did not unlock actions",
  );
  pull();
  await wait(
    () => document.body.textContent?.includes("Up to date at") ?? false,
    "Unchanged Pull did not hydrate",
  );
  check(pulls === 2 && order() === fullOrder.join(","), "Unchanged Pull lost trusted scope/order");
  return { passed };
}

/** Keep ChatPanel mounted while PR props change; delay new hydration with the same head SHA. */
export async function testAutomaticReviewOrderInPlaceScopeInBrowser() {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const secondUrl = url.replace("/1", "/2");
  const receipt = (id: string) => ({
    session: { id },
    sessions: [],
    headSha: head,
    sessionHeadSha: head,
    sessionScope: { mode: "full", commitSha: null },
  });
  let release!: (value: ReturnType<typeof receipt>) => void;
  const delayed = new Promise<ReturnType<typeof receipt>>((resolve) => {
    release = resolve;
  });
  let pullRequests = 0;
  let releasePull!: (value: unknown) => void;
  const delayedPull = new Promise((resolve) => {
    releasePull = resolve;
  });
  const disposeApp = await mountAppFixture({
    procedures: {
      "prReview.pullLatest": () => {
        pullRequests++;
        return delayedPull;
      },
      "prReview.getOrCreateSession": (input) =>
        input && typeof input === "object" && "prUrl" in input && input.prUrl === secondUrl
          ? delayed
          : receipt("bootstrap-first"),
    },
    reviewSnapshot: (sessionId) => ({
      sessionId,
      revision: head,
      running: false,
      compacting: false,
      settlements: [],
      messages: [
        {
          id: `${sessionId}-order`,
          role: "assistant",
          metadata: { timestamp: "2026-01-01", revision: head },
          parts: [
            {
              type: "text",
              text: `<<REVIEW_ORDER>>${JSON.stringify([...paths].reverse())}<</REVIEW_ORDER>>`,
            },
          ],
        },
      ],
    }),
  });
  disposeApp();
  const [currentUrl, setCurrentUrl] = createSignal(url);
  const received: AvailableReviewOrder[] = [];
  const dispose = render(
    () => (
      <ChatPanel
        prUrl={currentUrl()}
        prNumber={currentUrl() === url ? 1 : 2}
        repoOwner="browser-fixture"
        repoName="isolated"
        files={paths}
        theme="vesper"
        reviewMode="full"
        displayedHeadSha={head}
        onAvailableReviewOrder={(order) => {
          if (order) received.push(order);
        }}
      />
    ),
    document.getElementById("root")!,
  );
  await wait(
    () => received.some((order) => order.prUrl === url),
    "Initial in-place transcript did not hydrate",
  );
  const panel = document.getElementById("chat-panel");
  document.querySelector<HTMLButtonElement>('button[aria-label="Review actions"]')!.click();
  [...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")]
    .find((button) => button.textContent?.includes("Pull latest & continue"))!
    .click();
  await wait(() => pullRequests === 1, "Delayed old PR Pull did not start");
  setCurrentUrl(secondUrl);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check(document.getElementById("chat-panel") === panel, "PR switch remounted ChatPanel");
  check(
    !received.some((order) => order.prUrl === secondUrl),
    "Old same-head transcript leaked before new PR hydration",
  );
  release(receipt("bootstrap-second"));
  await wait(
    () => received.some((order) => order.prUrl === secondUrl),
    "New PR order did not arrive",
  );
  check(
    received
      .filter((order) => order.prUrl === secondUrl)
      .every((order) => order.sessionId === "bootstrap-second"),
    "Late old session was relabelled as new PR",
  );
  const count = received.filter((order) => order.prUrl === secondUrl).length;
  releasePull({
    changed: true,
    headSha: head,
    session: { id: "bootstrap-first" },
    sessionScope: { mode: "full", commitSha: null, afterSubmissionId: "old-pr-continuation" },
  });
  await wait(
    () => received.filter((order) => order.prUrl === secondUrl).length > count,
    "Late Pull response poisoned new PR order scope",
  );
  check(
    !document.body.textContent?.includes("Continuing the review in this conversation."),
    "Late old PR Pull notice leaked into new conversation",
  );
  dispose();
  return { passed };
}
