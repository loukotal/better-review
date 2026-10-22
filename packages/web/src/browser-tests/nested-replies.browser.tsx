import { render } from "solid-js/web";

import type {
  GithubOutboxCommand,
  GithubOutboxSnapshot,
  IssueComment,
  PRComment,
} from "@better-review/shared";

import { PrCommentsPanel } from "../components/PrCommentsPanel";
import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    browserNestedReplies(request: { kind: string; input?: unknown }): Promise<unknown>;
  }
}

/** Same panel contract for both raw legacy comments and outbox-backed views. */
export async function testAppConversationQuoteIdentityInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const comment = (id: number, login: string, body: string): IssueComment => ({
    id,
    body,
    user: { login, avatar_url: "" },
    html_url: `${url}#issuecomment-${id}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    canEdit: false,
  });
  const comments = [
    comment(1, "Alice", "Looks good"),
    comment(2, "Bob", "Looks good"),
    comment(3, "reviewer", "> Looks good\n\n@aLiCe Thanks Alice"),
    comment(4, "Alice", "Same author twice"),
    comment(5, "alice", "Same author twice"),
    comment(6, "reviewer", "> Same author twice\n\n@alice Ambiguous response"),
    comment(7, "alice", "Edited root"),
    comment(8, "reviewer", "> Original root\n\n@alice Edited target response"),
    comment(9, "reviewer", "> Looks good\n\nNo mention response"),
    comment(10, "", "Unknown author body"),
    comment(11, "reviewer", "> Unknown author body\n\n@alice Unknown target response"),
    comment(12, "alice", "Prefix longer body"),
    comment(13, "reviewer", "> Prefix\n\n@alice Partial target response"),
  ];
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: { comments: [], issueComments: comments, status: null },
  });
  for (
    let frame = 0;
    frame < 180 && !document.querySelector('[data-github-comment-key="remote:issue-comment:13"]');
    frame++
  )
    await new Promise(requestAnimationFrame);
  const verify = (root: ParentNode, card: (id: number) => HTMLElement | null, label: string) => {
    const threads = [...root.querySelectorAll<HTMLElement>("[data-github-conversation-thread]")];
    check(threads.length === 12, `${label}: guessed an ambiguous relationship`);
    const alice = threads.find((thread) => thread.contains(card(1)));
    check(
      !!alice && alice.contains(card(3)) && !alice.contains(card(2)),
      `${label}: @alice reply grouped under Bob`,
    );
    for (const id of [6, 8, 9, 11, 13]) {
      const element = card(id);
      check(!!element?.querySelector("blockquote"), `${label}: standalone ${id} lost its quote`);
      check(
        threads.some(
          (thread) =>
            thread.contains(element) &&
            !thread.contains(
              card(id === 6 ? 5 : id === 8 ? 7 : id === 11 ? 10 : id === 13 ? 12 : 1),
            ),
        ),
        `${label}: standalone ${id} acquired a guessed parent`,
      );
      if (id !== 9)
        check(
          element?.textContent?.includes("@alice"),
          `${label}: standalone ${id} lost its mention`,
        );
    }
  };
  verify(
    document,
    (id) => document.querySelector(`[data-github-comment-key="remote:issue-comment:${id}"]`),
    "outbox",
  );
  const legacy = document.createElement("div");
  document.body.append(legacy);
  const dispose = render(() => <PrCommentsPanel comments={comments} embedded />, legacy);
  try {
    verify(legacy, (id) => legacy.querySelector(`#comment-${id}`), "legacy");
  } finally {
    dispose();
    legacy.remove();
  }
  return { passed };
}

/** Real App, RPC serialization and IndexedDB. No external requests or model calls. */
export async function testAppNestedConversationRepliesInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url);
  const stamp = "2026-01-01T00:00:00Z";
  const issue: IssueComment = {
    id: 10,
    body: "Original conversation",
    html_url: `${url}#issuecomment-10`,
    user: { login: "browser-fixture", avatar_url: "" },
    created_at: stamp,
    updated_at: stamp,
    canEdit: true,
  };
  const reply = {
    ...issue,
    id: 11,
    body: "> Original conversation\n\n@browser-fixture First reply",
  };
  const commands: GithubOutboxCommand[] = [];
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: { comments: [], issueComments: [issue, reply], status: null },
    procedures: {
      "githubOutbox.enqueue": async (input) => {
        const command = input as GithubOutboxCommand;
        commands.push(command);
        return window.browserNestedReplies({ kind: "enqueue", input });
      },
      "githubOutbox.snapshot": () => window.browserNestedReplies({ kind: "snapshot" }),
      "githubOutbox.heartbeat": (input) =>
        window.browserNestedReplies({ kind: "heartbeat", input }),
    },
  });
  await refreshGithubActor();
  const card = () =>
    document.querySelector<HTMLElement>('[data-github-comment-key="remote:issue-comment:11"]');
  await wait(() => !!card(), "Conversation reply missing from App");
  const button = (label: string) =>
    [...card()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    )!;
  button("Reply").click();
  await wait(() => !!card()?.querySelector("textarea:not(:disabled)"), "Reply draft did not load");
  const editor = card()!.querySelector("textarea")!;
  editor.value = "Second reply";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await wait(() => !button("Reply").disabled, "Reply draft did not become ready");
  button("Reply").click();
  await wait(() => commands.length === 1, "Nested reply did not reach RPC admission");
  check(commands[0]!.action.kind === "issue-comment", "Issue reply became a GitHub review thread");
  const action = commands[0]!.action;
  check(
    "body" in action && action.body === "> First reply\n\n@browser-fixture Second reply",
    `Nested reply quoted the ancestor instead of its target: ${JSON.stringify(action)}`,
  );
  await githubWrites.snapshot(scope);
  await wait(
    () => !!document.querySelector('[data-github-comment-key^="local:issue-comment:"]'),
    "Nested reply lost from local projection",
  );
  check(
    document.querySelectorAll("[data-github-conversation-thread]").length === 1,
    "Outbox conversation split a nested reply into a separate thread",
  );
  check(
    document.querySelectorAll("[data-github-comment-key]").length === 3,
    "Conversation duplicated or dropped a comment",
  );
  let remote:
    | {
        calls: { method: string; path: string; payload?: { body: string } }[];
        issueComments: IssueComment[];
      }
    | undefined;
  for (let frame = 0; frame < 240; frame++) {
    remote = (await window.browserNestedReplies({ kind: "state" })) as typeof remote;
    if (remote!.issueComments.length) break;
    await new Promise(requestAnimationFrame);
  }
  const posts = remote!.calls.filter((call) => call.method === "POST");
  check(
    posts.length === 1 &&
      posts[0]!.path.endsWith("/issues/1/comments") &&
      posts[0]!.payload!.body.startsWith(
        "> First reply\n\n@browser-fixture Second reply\n\n<!-- better-review:op:",
      ),
    "Quoted issue reply did not reach the production issue-comment endpoint exactly once",
  );
  return { passed };
}

/** Actual App → IndexedDB → RPC → SQLite worker → production GitHub adapter. */
export async function testAppNestedReviewRepliesInBrowser(mode?: string) {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 240 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url);
  const fixture = (kind: string, input?: unknown) => window.browserNestedReplies({ kind, input });
  const state = () =>
    fixture("state") as Promise<{
      comments: PRComment[];
      calls: { method: string; path: string; payload?: { body?: string } }[];
    }>;
  const extras = async () => ({
    comments: (await state()).comments.map((comment) => ({
      ...comment,
      canEdit: true,
      threadId: "actual-thread",
      isResolved: false,
    })),
    issueComments: [],
    status: null,
  });
  await mountAppFixture({
    defaultTab: "overview",
    waitForFiles: false,
    extras: await extras(),
    procedures: {
      "githubOutbox.enqueue": (input) => fixture("enqueue", input),
      "githubOutbox.snapshot": () => fixture("snapshot"),
      "githubOutbox.heartbeat": (input) => fixture("heartbeat", input),
      "githubOutbox.control": (input) => fixture("control", input),
      "pr.extras": extras,
    },
  });
  await refreshGithubActor();
  const card = (body: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-github-comment-key]")].find(
      (item) => item.querySelector("[data-comment-body]")?.textContent?.trim() === body,
    );
  if (mode === "after") {
    await githubWrites.recover(scope);
    await wait(
      () => !!card("First review reply") && !!card("Second review reply"),
      "Reload dropped nested replies",
    );
    check(
      document.querySelectorAll("[data-github-review-thread]").length === 1,
      "Reload split the GitHub review discussion",
    );
    check(
      document.querySelectorAll("[data-github-comment-key]").length === 3,
      "Reload duplicated or dropped a review comment",
    );
    check(
      (await state()).calls.filter((call) => call.method === "POST").length === 2,
      "Reload posted replies again",
    );
    const target = card("Second review reply")!;
    const click = (label: string) =>
      [...target.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent?.trim() === label)!
        .click();
    click("Edit");
    await wait(
      () => !!target.querySelector("textarea:not(:disabled)"),
      "Reloaded reply edit did not open",
    );
    const editor = target.querySelector("textarea")!;
    editor.value = "Edited nested reply";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await wait(
      () => !target.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      "Reloaded reply edit draft did not save",
    );
    click("Save");
    for (let frame = 0; frame < 240; frame++) {
      if (
        (await state()).comments.some(
          (comment) => comment.id === 22 && comment.body.startsWith("Edited nested reply"),
        )
      )
        break;
      await new Promise(requestAnimationFrame);
    }
    const edited = await state();
    check(
      edited.calls
        .filter((call) => call.method === "PATCH")
        .every((call) => call.path.endsWith("/comments/22")) &&
        edited.comments.some(
          (comment) => comment.id === 22 && comment.body.startsWith("Edited nested reply"),
        ),
      "Nested edit mutated the thread root instead of the selected reply",
    );
    check(
      edited.comments.find((comment) => comment.id === 20)?.body === "Review root",
      "Nested edit changed root content",
    );
    await githubWrites.snapshot(scope);
    await wait(() => !!card("Edited nested reply"), "Edited reply disappeared");
    const originalConfirm = window.confirm;
    try {
      window.confirm = () => true;
      [...card("Edited nested reply")!.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent?.trim() === "Delete")!
        .click();
    } finally {
      window.confirm = originalConfirm;
    }
    let deleted = await state();
    for (
      let frame = 0;
      frame < 240 && deleted.comments.some((comment) => comment.id === 22);
      frame++
    ) {
      await new Promise(requestAnimationFrame);
      deleted = await state();
    }
    check(
      !deleted.comments.some((comment) => comment.id === 22) &&
        deleted.comments.some((comment) => comment.id === 20) &&
        deleted.calls.some(
          (call) => call.method === "DELETE" && call.path.endsWith("/comments/22"),
        ),
      "Nested delete targeted the root instead of the selected reply",
    );
    return { passed };
  }
  const reply = async (parent: string, body: string) => {
    await wait(() => !!card(parent), `Parent missing: ${parent}`);
    const element = card(parent)!;
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label,
      )!;
    button("Reply").click();
    await wait(
      () => !!element.querySelector("textarea:not(:disabled)"),
      "Review reply editor unavailable",
    );
    const editor = element.querySelector("textarea")!;
    editor.value = body;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await wait(() => !button("Reply").disabled, "Review reply draft not ready");
    button("Reply").click();
    await wait(() => !!card(body), "Review reply lost from optimistic projection");
  };
  await fixture("hold-ack");
  await reply("Review root", "First review reply");
  await reply("First review reply", "Second review reply");
  check(
    document.querySelectorAll("[data-github-review-thread]").length === 1,
    "Pending nested review reply split into a separate discussion",
  );
  await fixture("release-ack");
  let snapshot = (await fixture("snapshot")) as GithubOutboxSnapshot;
  for (let frame = 0; frame < 240; frame++) {
    await githubWrites.recover(scope);
    snapshot = (await fixture("snapshot")) as GithubOutboxSnapshot;
    if (
      snapshot.operations.length === 2 &&
      snapshot.operations.every((item) => item.status === "synced")
    )
      break;
    await new Promise(requestAnimationFrame);
  }
  check(
    snapshot.operations.length === 2 &&
      snapshot.operations.every((item) => item.status === "synced"),
    `Nested review chain did not sync: ${JSON.stringify(snapshot.operations)}`,
  );
  await githubWrites.snapshot(scope);
  const remote = await state();
  const posts = remote.calls.filter((call) => call.method === "POST");
  check(
    posts.length === 2 && posts.every((call) => call.path.endsWith("/comments/20/replies")),
    "Nested review reply did not use the verified root endpoint exactly once",
  );
  check(
    remote.comments.length === 3 &&
      remote.comments.slice(1).every((comment) => comment.in_reply_to_id === 20),
    "GitHub-shaped responses lost root relationships",
  );
  check(
    posts[0]!.payload!.body!.startsWith("First review reply\n\n<!-- better-review:op:") &&
      posts[1]!.payload!.body!.startsWith("Second review reply\n\n<!-- better-review:op:"),
    "Reply text duplicated, quoted, or lost its operation marker",
  );
  await wait(
    () => !!card("First review reply") && !!card("Second review reply"),
    "Confirmed replies disappeared",
  );
  check(
    document.querySelectorAll("[data-github-review-thread]").length === 1,
    "Confirmed nested review reply left its discussion",
  );
  return { passed };
}
