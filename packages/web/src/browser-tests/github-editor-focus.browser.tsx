import type { IssueComment, PRComment } from "@better-review/shared";

import { githubJournal, githubPrScope, refreshGithubActor } from "../lib/github-writes";
import { api } from "../lib/query";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    typeBrowserGithubEditor(key: string, text: string): Promise<void>;
    clickBrowserGithubCommentButton(key: string, label: string): Promise<void>;
    typeInFocusedBrowserEditor(text: string): Promise<void>;
  }
}

/** Trusted typing through the actual App, production poll and extras projection. */
export async function testAppGithubEditorFocusInBrowser() {
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url);
  const issue: IssueComment = {
    id: 10,
    body: "original discussion",
    html_url: `${url}#issuecomment-10`,
    user: { login: "browser-fixture", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    canEdit: true,
  };
  let review: PRComment = {
    ...issue,
    id: 20,
    node_id: "review-comment-node",
    body: "original inline",
    path: "src/example.ts",
    line: 9,
    original_line: 9,
    side: "RIGHT",
    threadId: "actual-thread",
  };
  let remoteIssue = issue,
    polls = 0,
    enqueues = 0,
    passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  await mountAppFixture({
    extras: { comments: [review], issueComments: [issue], status: null },
    procedures: {
      "githubOutbox.snapshot": () => {
        polls++;
        return { scope, revision: 0, operations: [] };
      },
      "githubOutbox.enqueue": () => {
        enqueues++;
        throw new Error("No real writes");
      },
      "pr.extras": () => ({ comments: [review], issueComments: [remoteIssue], status: null }),
    },
  });
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  const card = (key: string) =>
    document.querySelector<HTMLElement>(`[data-github-comment-key="${key}"]`)!;
  const button = (key: string, label: string) =>
    [...card(key).querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    )!;
  for (const kind of ["review-comment", "issue-comment"] as const) {
    const key = `remote:${kind}:${kind === "review-comment" ? 20 : 10}`;
    await wait(() => !!card(key), "Comment not rendered");
    for (const mode of ["Edit", "Reply"]) {
      button(key, mode).click();
      await wait(() => !!card(key)?.querySelector("textarea:not(:disabled)"), "Editor not ready");
      const text = `unsent ${kind} ${mode} text`;
      await window.typeBrowserGithubEditor(key, text);
      const editor = card(key).querySelector("textarea")!;
      const start = editor.selectionStart,
        end = editor.selectionEnd;
      const stable = (trigger: string) => {
        check(
          card(key).querySelector("textarea") === editor,
          `${kind} ${mode}: textarea replaced after ${trigger}`,
        );
        check(document.activeElement === editor, `${kind} ${mode}: focus lost after ${trigger}`);
        check(
          editor.selectionStart === start && editor.selectionEnd === end,
          `${kind} ${mode}: caret changed after ${trigger}`,
        );
        check(editor.value === text, `${kind} ${mode}: unsent text lost after ${trigger}`);
      };
      const before = polls;
      await new Promise(requestAnimationFrame);
      stable("next frame before poll");
      await wait(() => polls > before, "Production outbox interval did not poll");
      stable("poll snapshot");
      review = {
        ...review,
        body: `${review.body} external`,
        isResolved: !review.isResolved,
        user: { ...review.user, login: `${review.user.login}-updated` },
      };
      remoteIssue = { ...remoteIssue, body: `${remoteIssue.body} external` };
      await api.fetchPrExtras(url);
      await new Promise((resolve) => setTimeout(resolve, 100));
      stable("extras body/status change");
      if (kind === "review-comment")
        check(
          card(key)
            .querySelector("[data-comment-header]")!
            .textContent?.includes(review.user.login),
          "Author metadata froze while editor stayed open",
        );
      await window.typeInFocusedBrowserEditor("continued");
      check(
        card(key).querySelector("textarea") === editor &&
          editor.value === `${text.slice(0, start)}continued${text.slice(end)}`,
        "Typing after refresh did not reach the original editor/caret",
      );
      check(
        enqueues === 0 && (await githubJournal.entries(scope)).length === 0,
        "Draft autosave submitted a write",
      );
      check(
        !!button(key, "Save") &&
          !button(key, "Keep draft and close") &&
          !button(key, "Save locally"),
        "Confusing edit labels remain",
      );
      button(key, "Cancel").click();
      if (kind === "review-comment")
        check(
          button(key, review.isResolved ? "Unresolve" : "Resolve"),
          "Thread metadata froze after editor closed",
        );
    }
  }
  return { passed };
}

/** A failed explicit Save retains focus, the pinned edit baseline and a reloadable draft. */
export async function testAppGithubFailedSaveReloadInBrowser(phase = "before") {
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url),
    key = "remote:issue-comment:10";
  const text = "held edit survives failed admission and reload";
  let passed = 0,
    enqueues = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  await mountAppFixture({
    extras: {
      comments: [],
      issueComments: [
        {
          id: 10,
          body: phase === "before" ? "original baseline" : "external update after reload",
          html_url: `${url}#issuecomment-10`,
          user: { login: "browser-fixture", avatar_url: "" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          canEdit: true,
        },
      ],
      status: null,
    },
    procedures: {
      // Hold the HTTP response: Save must close at local admission, not network completion.
      "githubOutbox.enqueue": () => {
        enqueues++;
        return new Promise(() => {});
      },
    },
  });
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  const card = () => document.querySelector<HTMLElement>(`[data-github-comment-key="${key}"]`)!;
  await wait(() => !!card(), "Comment missing");
  await window.clickBrowserGithubCommentButton(key, "Edit");
  await wait(() => !!card().querySelector("textarea:not(:disabled)"), "Edit not hydrated");
  const editor = card().querySelector("textarea")!;
  if (phase === "before") {
    await window.typeBrowserGithubEditor(key, text);
    const start = editor.selectionStart,
      end = editor.selectionEnd;
    const admit = githubJournal.admit;
    githubJournal.admit = async () => {
      throw new Error("Fixture storage commit failed");
    };
    try {
      await window.clickBrowserGithubCommentButton(key, "Save");
      await wait(() => !!card().querySelector('[role="alert"]'), "Failed Save showed no error");
      check(
        card().querySelector("textarea") === editor && document.activeElement === editor,
        "Failed Save lost editor/focus",
      );
      check(
        editor.value === text && editor.selectionStart === start && editor.selectionEnd === end,
        "Failed Save lost text/caret",
      );
      check(
        card().querySelector('[role="alert"]')!.textContent?.includes("storage commit failed"),
        "Storage error hidden",
      );
      check(
        enqueues === 0 && (await githubJournal.entries(scope)).length === 0,
        "Failed Save submitted an operation",
      );
      check(
        (await githubJournal.editorDrafts(scope)).some((draft) => draft.body === text),
        "Failed Save draft was not persisted",
      );
    } finally {
      githubJournal.admit = admit;
    }
  } else {
    check(editor.value === text, "Reload lost failed Save draft");
    await window.clickBrowserGithubCommentButton(key, "Save");
    await wait(
      () => !card().querySelector("textarea"),
      "Save waited for GitHub instead of durable local admission",
    );
    const entries = await githubJournal.entries(scope);
    check(entries.length === 1, "Save did not admit exactly one operation");
    const action = entries[0]!.command.action;
    check(
      action.kind === "edit-comment" &&
        action.body === text &&
        action.expectedBody === "original baseline",
      "Reload/retry rebound original baseline or body",
    );
    await wait(() => enqueues > 0, "Background sync did not start");
  }
  return { passed };
}
