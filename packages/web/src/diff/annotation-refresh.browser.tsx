import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { DiffViewer, DEFAULT_DIFF_SETTINGS } from "../DiffViewer";
import type { SelectedSource } from "../lib/ask-ai-selection";
import type { Annotation } from "../utils/parseReviewTokens";
import type { PRComment } from "./types";

function mountRefreshFixture() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:10px;overflow:auto;background:#111";
  document.body.append(host);
  const [annotations, setAnnotations] = createSignal<Annotation[]>([]);
  const [comments, setComments] = createSignal<PRComment[]>([]);
  const received: Annotation[] = [],
    selections: SelectedSource[] = [];
  const resolutions: { thread: string; resolved: boolean }[] = [];
  const dispose = render(
    () => (
      <DiffViewer
        rawDiff={
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n"
        }
        comments={comments()}
        aiAnnotations={annotations()}
        settings={DEFAULT_DIFF_SETTINGS}
        onAskAi={(selection) => selections.push(selection)}
        onCreateFindingComment={(annotation) => received.push(annotation)}
        onResolveThread={async (thread, resolved) => {
          resolutions.push({ thread, resolved });
        }}
        onAddComment={async () => {}}
        onReplyToComment={async () => {}}
        onEditComment={async () => {}}
        onDeleteComment={async () => {}}
      />
    ),
    host,
  );
  const settle = async () => {
    for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
  };
  const wait = async (condition: () => boolean) => {
    for (let frame = 0; frame < 180 && !condition(); frame++)
      await new Promise(requestAnimationFrame);
    if (!condition()) throw new Error("Actual diff annotation did not render");
  };
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
    passed++;
  };
  return {
    host,
    setAnnotations,
    setComments,
    received,
    selections,
    resolutions,
    settle,
    wait,
    check,
    result: () => ({ passed }),
    close: () => {
      dispose();
      host.remove();
      getSelection()?.removeAllRanges();
    },
  };
}

export async function testSameIdFindingOriginRefreshInBrowser() {
  const fixture = mountRefreshFixture();
  const { host, setAnnotations, received, settle, wait, check } = fixture;
  let annotation: Annotation = {
    id: "same-finding",
    file: "src/a.ts",
    line: 2,
    severity: "warning",
    message: "identical finding",
    origin: { sessionId: "old-session", revision: "a".repeat(40) },
  };
  const card = () =>
    host.querySelector<HTMLElement>('[aria-label="Prepare comment for src/a.ts:2"]');
  try {
    setAnnotations([annotation]);
    await wait(() => !!card());
    await settle();
    annotation = { ...annotation, origin: { sessionId: "new-session", revision: "a".repeat(40) } };
    setAnnotations([annotation]);
    await settle();
    card()!.click();
    check(
      received.at(-1)?.origin?.sessionId === "new-session",
      "Same-ID finding action must use a changed source session, not captured old provenance",
    );
    annotation = { ...annotation, origin: { sessionId: "new-session", revision: "b".repeat(40) } };
    setAnnotations([annotation]);
    await settle();
    card()!.click();
    check(
      received.at(-1)?.origin?.revision === "b".repeat(40),
      "Same-ID finding action must use a changed source revision independently of session",
    );
    setAnnotations([{ ...annotation, message: "updated finding", severity: "critical", line: 3 }]);
    await settle();
    check(
      host
        .querySelector('[aria-label="Prepare comment for src/a.ts:3"]')
        ?.textContent?.includes("updated finding"),
      "Same-ID finding must refresh rendered message, severity and placement",
    );
    return fixture.result();
  } finally {
    fixture.close();
  }
}

export async function testSameBodyLegacyThreadRefreshInBrowser() {
  const fixture = mountRefreshFixture();
  const { host, setComments, settle, wait, check, resolutions } = fixture;
  let comment: PRComment = {
    id: 1,
    node_id: "comment-node",
    path: "src/a.ts",
    line: 2,
    original_line: 2,
    side: "RIGHT",
    body: "unchanged comment",
    html_url: "https://github.com/o/r/pull/1#discussion_r1",
    user: { login: "first-author", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    canEdit: false,
    threadId: "old-thread",
    isResolved: false,
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
  try {
    setComments([comment]);
    await wait(() => !!host.querySelector("#comment-1"));
    await settle();
    comment = { ...comment, isResolved: true };
    setComments([comment]);
    await settle();
    check(button("Unresolve"), "Same-body resolved update must refresh the legacy thread controls");
    comment = { ...comment, threadId: "new-thread" };
    setComments([comment]);
    await settle();
    button("Unresolve")!.click();
    await settle();
    check(
      resolutions.at(-1)?.thread === "new-thread" && resolutions.at(-1)?.resolved === false,
      "Legacy resolve action must use the new thread identity and current resolved state",
    );
    const oldSlot = host.querySelector("#comment-1")!.closest("[slot]")!.getAttribute("slot");
    comment = {
      ...comment,
      side: "LEFT",
      line: 3,
      user: { login: "new-author", avatar_url: "" },
      canEdit: true,
      created_at: "2026-02-02T00:00:00Z",
      html_url: "https://github.com/o/r/pull/1#discussion_r2",
    };
    setComments([comment]);
    await settle();
    check(
      oldSlot === "annotation-additions-2" &&
        host.querySelector("#comment-1")!.closest("[slot]")!.getAttribute("slot") ===
          "annotation-deletions-3",
      "Same-body location change must move the legacy annotation",
    );
    check(
      host.querySelector("#comment-1")?.textContent?.includes("new-author") && button("Edit"),
      "Same-body author and permissions changes must update the rendered comment",
    );
    check(
      host.querySelector('#comment-1 [title="Link to comment"]')?.textContent ===
        new Date(comment.created_at).toLocaleDateString() &&
        host.querySelector('#comment-1 [title="View on GitHub"]')?.getAttribute("href") ===
          comment.html_url,
      "Same-body date and permalink updates must refresh the displayed metadata",
    );
    const reply: PRComment = { ...comment, id: 2, body: "same reply", in_reply_to_id: 1 };
    setComments([comment, reply]);
    await settle();
    const slot = (id: number) => host.querySelector(`#comment-${id}`)!.closest("[slot]");
    check(slot(1) === slot(2), "Reply must initially belong to its parent annotation");
    setComments([comment, { ...reply, in_reply_to_id: undefined, line: 1 }]);
    await settle();
    check(slot(1) !== slot(2), "Same-body reply-parent update must regroup the legacy thread");
    return fixture.result();
  } finally {
    fixture.close();
  }
}

export async function testMultilineSelectionAnnotationRefreshInBrowser() {
  const fixture = mountRefreshFixture();
  const { host, setAnnotations, setComments, settle, wait, check, selections } = fixture;
  let annotation: Annotation = {
    id: "stable-finding",
    file: "src/a.ts",
    line: 2,
    severity: "warning",
    message: "stable finding",
    origin: { sessionId: "session-0", revision: "a".repeat(40) },
  };
  const comment: PRComment = {
    id: 1,
    node_id: "comment-node",
    path: "src/a.ts",
    line: 2,
    original_line: 2,
    side: "RIGHT",
    body: "stable comment",
    html_url: "https://github.com/o/r/pull/1#discussion_r1",
    user: { login: "author", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    canEdit: false,
    threadId: "stable-thread",
    isResolved: false,
  };
  try {
    setAnnotations([annotation]);
    setComments([comment]);
    await wait(() => !!host.querySelector("#comment-1"));
    await settle();
    for (const side of ["LEFT", "RIGHT"] as const) {
      const root = host.querySelector("diffs-container")!.shadowRoot!;
      const column = side === "LEFT" ? "deletions" : "additions";
      const first = root.querySelector(`[data-${column}] [data-line="1"]`)!;
      const last = root.querySelector(`[data-${column}] [data-line="3"]`)!;
      const start = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!;
      const end = document.createTreeWalker(last, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(start, 1);
      range.setEnd(end, 3);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
      await settle();
      const bubble = () => host.querySelector('[aria-label="Selection actions"]');
      check(bubble(), `${side}: multiline partial selection must offer Ask AI`);
      setAnnotations(structuredClone([annotation]));
      setComments(structuredClone([comment]));
      await settle();
      check(
        start.isConnected && end.isConnected && bubble(),
        `${side}: identical fresh annotation/comment arrays must preserve source DOM and Ask AI`,
      );
      annotation = {
        ...annotation,
        origin: { sessionId: `session-${side}`, revision: "b".repeat(40) },
      };
      setAnnotations([annotation]);
      await settle();
      check(
        !start.isConnected && !end.isConnected && bubble(),
        `${side}: genuine annotation refresh must replace both endpoints and retain Ask AI`,
      );
      bubble()!.querySelector<HTMLButtonElement>("button")!.click();
      const selection = selections.at(-1);
      check(
        selection?.side === side &&
          selection.startLine === 1 &&
          selection.endLine === 3 &&
          selection.text === `efore\n${side === "LEFT" ? "old" : "new"}\naft`,
        `${side}: delayed action must retain exact partial multiline text and source coordinates`,
      );
    }
    return fixture.result();
  } finally {
    fixture.close();
  }
}
