import type { GithubOutboxOperation, IssueComment, PRComment } from "@better-review/shared";
import { isGithubOutboxCommand } from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  githubJournal,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { api, queryClient, queryKeys } from "../lib/query";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    /** Node-side production REST decoder, exposed by the isolated browser runner. */
    decodeBrowserGithubReviewComments(input: unknown): Promise<Omit<PRComment, "canEdit">[]>;
  }
}

/** Actual App + query fetch boundary + journal + discussion/diff components. No real HTTP writes. */
export async function testAppGithubCommentProjectionInBrowser() {
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url),
    head = "a".repeat(40);
  const stamp = "2026-01-01T00:00:00Z";
  const issue: IssueComment = {
    id: 10,
    body: "original discussion body",
    html_url: `${url}#issuecomment-10`,
    user: { login: "browser-fixture", avatar_url: "" },
    created_at: stamp,
    updated_at: stamp,
    canEdit: true,
  };
  const review: PRComment = {
    id: 20,
    node_id: "comment-node-not-thread",
    path: "src/example.ts",
    line: 9,
    original_line: 9,
    side: "RIGHT",
    body: "original inline body",
    html_url: `${url}#discussion_r20`,
    user: issue.user,
    created_at: stamp,
    canEdit: true,
    threadId: "actual-thread",
  };
  let remoteIssues = [issue],
    remoteReviews = [review];
  let nextExtras:
    | (() => Promise<{ comments: PRComment[]; issueComments: IssueComment[]; status: null }>)
    | undefined;
  const operations = new Map<string, GithubOutboxOperation>();
  let revision = 0,
    calls = 0,
    passed = 0,
    identityKnown = true,
    backendOffline = false;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 240 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const card = (key: string) =>
    document.querySelector<HTMLElement>(`[data-github-comment-key="${key}"]`);
  const button = (root: Element, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    )!;
  const fetchRemote = async () => {
    const data = await api.fetchPrExtras(url);
    queryClient.setQueryData(queryKeys.pr.extras(url), data);
    return data;
  };
  const admit = (input: unknown) => {
    if (!isGithubOutboxCommand(input)) throw new Error("Malformed browser command");
    if (backendOffline) throw new Error("Local backend is offline");
    calls++;
    const prior = operations.get(input.operationId);
    if (prior) return { outcome: "duplicate", operation: structuredClone(prior) };
    if (input.dependencies.some((id) => !operations.has(id)))
      return {
        outcome: "rejected",
        operationId: input.operationId,
        error: { code: "dependency", retryable: false, message: "Parent must be admitted first" },
      };
    const operation: GithubOutboxOperation = {
      command: input,
      revision: 1,
      sequence: operations.size + 1,
      status: "queued",
      retryMode: "automatic",
      attempts: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    operations.set(input.operationId, operation);
    revision++;
    return { outcome: "accepted", operation: structuredClone(operation) };
  };
  await mountAppFixture({
    extras: { comments: remoteReviews, issueComments: remoteIssues, status: null },
    procedures: {
      "githubOutbox.enqueue": admit,
      "githubOutbox.identity": () => ({
        actor: identityKnown ? { id: 42, login: "browser-fixture" } : null,
      }),
      "githubOutbox.snapshot": () => ({
        scope,
        revision,
        operations: [...operations.values()].map((item) => structuredClone(item)),
      }),
      "pr.extras": async () => {
        if (nextExtras) {
          const read = nextExtras;
          nextExtras = undefined;
          const data = await read();
          return {
            ...data,
            comments: (await window.decodeBrowserGithubReviewComments(data.comments)).map(
              (comment) => ({ ...comment, canEdit: true, threadId: "actual-thread" }),
            ),
          };
        }
        const comments = (await window.decodeBrowserGithubReviewComments(remoteReviews)).map(
          (comment) => ({ ...comment, canEdit: true, threadId: "actual-thread" }),
        );
        return { comments, issueComments: remoteIssues, status: null };
      },
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
    },
  });
  await refreshGithubActor();
  const conversation = document.querySelector<HTMLButtonElement>(
    '[aria-controls="pr-conversation"]',
  )!;
  conversation.click();
  await wait(
    () => !!card("remote:issue-comment:10") && !!card("remote:review-comment:20"),
    "Projected initial App comments did not render",
  );
  const edit = async (key: string, text: string) => {
    button(card(key)!, "Edit").click();
    await wait(
      () => !!card(key)?.querySelector("textarea:not(:disabled)"),
      "Durable edit draft did not load",
    );
    const input = card(key)!.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.form!.requestSubmit();
    await wait(
      () => card(key)?.querySelector("[data-comment-body]")?.textContent?.trim() === text,
      "Desired local body did not replace old row",
    );
  };
  await edit("remote:issue-comment:10", "desired discussion body");
  await fetchRemote();
  check(
    card("remote:issue-comment:10")?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "desired discussion body",
    "Stale extras overwrote queued discussion edit",
  );
  check(
    document.querySelectorAll('[data-github-comment-key="remote:issue-comment:10"]').length === 1,
    "Discussion edit rendered contradictory duplicate rows",
  );
  await edit("remote:review-comment:20", "desired inline body");
  await fetchRemote();
  await wait(
    () =>
      card("remote:review-comment:20")
        ?.querySelector("[data-comment-body]")
        ?.textContent?.trim() === "desired inline body",
    "Stale extras overwrote queued inline edit",
  );
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  try {
    button(card("remote:issue-comment:10")!, "Delete").click();
  } finally {
    window.confirm = originalConfirm;
  }
  await wait(
    () => card("remote:issue-comment:10")?.dataset.commentDeleted === "true",
    "Queued deletion did not replace row with tombstone",
  );
  await fetchRemote();
  check(
    !card("remote:issue-comment:10")?.querySelector("[data-comment-body]"),
    "Queued delete left original interactive body",
  );
  check(!button(card("remote:issue-comment:10")!, "Edit"), "Queued delete left old edit action");

  const inlineEdit = [...operations.values()].find(
    (item) =>
      item.command.action.kind === "edit-comment" &&
      item.command.action.target.kind === "review-comment",
  )!;
  inlineEdit.status = "synced";
  inlineEdit.revision++;
  inlineEdit.result = {
    kind: "review-comment",
    id: 20,
    url: review.html_url,
    body: "desired inline body",
    author: { id: 42, login: "browser-fixture" },
    createdAt: stamp,
    updatedAt: "2026-01-02T00:00:00Z",
    location: { path: review.path, line: 9, originalLine: 9, side: "RIGHT", commitSha: head },
    threadId: "actual-thread",
  };
  revision++;
  await githubWrites.snapshot(scope);
  await fetchRemote();
  check(
    card("remote:review-comment:20")?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "desired inline body",
    "A post-sync stale read retired the confirmed inline edit too early",
  );
  // Never observe the confirmed intermediate body remotely. Only strictly newer
  // server modification evidence may supersede it; equal/older evidence is stale.
  remoteReviews = [{ ...review, body: "older external inline version", updated_at: stamp }];
  await fetchRemote();
  check(
    card("remote:review-comment:20")?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "desired inline body",
    "Older REST updated_at retired a confirmed inline overlay",
  );
  remoteReviews = [
    {
      ...review,
      body: "equal-time conflicting inline version",
      updated_at: "2026-01-02T00:00:00Z",
    },
  ];
  await fetchRemote();
  check(
    card("remote:review-comment:20")?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "desired inline body",
    "Equal REST updated_at retired a confirmed inline overlay",
  );
  remoteReviews = [
    { ...review, body: "subsequent external inline edit", updated_at: "2026-01-03T00:00:00Z" },
  ];
  await fetchRemote();
  await wait(
    () =>
      card("remote:review-comment:20")
        ?.querySelector("[data-comment-body]")
        ?.textContent?.trim() === "subsequent external inline edit",
    "Newer REST updated_at failed to supersede the unobserved confirmed inline body",
  );

  const creation = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "new durable discussion",
  });
  await wait(() => operations.has(creation.operationId), "New issue comment not durably admitted");
  const localKey = `local:issue-comment:${creation.operationId}`;
  await wait(() => !!card(localKey), "Local creation absent from real discussion");
  let releaseOld!: () => void, oldStarted!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldStart = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  const oldExtras = structuredClone({
    comments: remoteReviews,
    issueComments: remoteIssues,
    status: null,
  });
  nextExtras = async () => {
    oldStarted();
    await oldGate;
    return oldExtras;
  };
  const lateRead = api.fetchPrExtras(url);
  await oldStart;
  const operation = operations.get(creation.operationId)!;
  operation.status = "synced";
  operation.revision++;
  operation.attempts = 1;
  operation.result = {
    kind: "issue-comment",
    id: 30,
    url: `${url}#issuecomment-30`,
    body: "new durable discussion",
    author: { id: 42, login: "browser-fixture" },
    createdAt: stamp,
    updatedAt: stamp,
  };
  revision++;
  remoteIssues = [
    ...remoteIssues,
    { ...issue, id: 30, html_url: `${url}#issuecomment-30`, body: "new durable discussion" },
  ];
  await githubWrites.snapshot(scope);
  await fetchRemote();
  await wait(
    () =>
      card(localKey)?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "new durable discussion",
    "Confirmed comment missing after remote read",
  );
  check(
    document.querySelectorAll(`[data-github-comment-key="${localKey}"]`).length === 1 &&
      !card("remote:issue-comment:30"),
    "Sync refresh duplicated local and remote comment",
  );
  releaseOld();
  queryClient.setQueryData(queryKeys.pr.extras(url), await lateRead);
  check(
    card(localKey)?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "new durable discussion",
    "Older in-flight extras response replaced causally newer confirmed read",
  );
  const stableNode = card(localKey);
  remoteIssues = remoteIssues.map((item) =>
    item.id === 30
      ? { ...item, body: "subsequent external edit", updated_at: "2026-01-02T00:00:00Z" }
      : item,
  );
  await fetchRemote();
  await wait(
    () =>
      card(localKey)?.querySelector("[data-comment-body]")?.textContent?.trim() ===
      "subsequent external edit",
    "Retired creation overlay overrode subsequent external edit",
  );
  check(
    card(localKey) === stableNode,
    "Remote ID adoption/external read remounted stable local comment key",
  );

  await queueGithubWrite(url, { kind: "approve", expectedHeadSha: head, body: "" });
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Approval pending",
      ),
    "Queued approval not labeled pending",
  );
  await wait(
    () => [...operations.values()].some((item) => item.command.action.kind === "approve"),
    "Approval admission did not settle before identity test",
  );
  check(
    ![...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Approved",
    ),
    "Pending approval falsely appeared approved",
  );
  check(calls === operations.size, "Background refresh re-enqueued a write");
  check(
    ![...document.querySelectorAll('[aria-label="GitHub pending writes"] > details')].some((node) =>
      node.hasAttribute("open"),
    ),
    "Transport audit dump opened by default",
  );
  identityKnown = false;
  await refreshGithubActor();
  const beforeUnknown = operations.size;
  button(card(localKey)!, "Edit").click();
  await wait(
    () => !!card(localKey)?.querySelector("textarea:not(:disabled)"),
    "Durable recovery draft did not load",
  );
  const draft = card(localKey)!.querySelector<HTMLTextAreaElement>("textarea")!;
  draft.value = "first-use account recovery draft";
  draft.dispatchEvent(new InputEvent("input", { bubbles: true }));
  draft.form!.requestSubmit();
  await wait(
    () => !!card(localKey)?.querySelector('[role="alert"]')?.textContent?.includes("gh auth login"),
    "Unknown account did not give actionable sign-in guidance",
  );
  check(
    operations.size === beforeUnknown &&
      card(localKey)?.querySelector("textarea")?.value === draft.value,
    "Unknown account queued unbound work or discarded draft",
  );
  check(
    (await githubJournal.editorDrafts(scope)).some((saved) => saved.body === draft.value),
    "Unknown account draft was not persisted for recovery",
  );
  button(card(localKey)!, "Keep draft and close").click();
  await fetchRemote();
  button(card(localKey)!, "Edit").click();
  await wait(
    () => !!card(localKey)?.querySelector("textarea:not(:disabled)"),
    "Reopened durable edit draft did not load",
  );
  check(
    card(localKey)?.querySelector("textarea")?.value === "first-use account recovery draft",
    "Account recovery draft lost across cache refresh/editor reopen",
  );
  identityKnown = true;
  await refreshGithubActor();
  remoteIssues = remoteIssues.map((item) =>
    item.id === 30
      ? { ...item, body: "changed while editor was open", updated_at: "2026-01-03T00:00:00Z" }
      : item,
  );
  await fetchRemote();
  await wait(
    () => !!card(localKey)?.querySelector('button[type="submit"]:not(:disabled)'),
    "Recovered durable edit was not ready after remote refresh",
  );
  card(localKey)!.querySelector("form")!.requestSubmit();
  await wait(
    () =>
      [...operations.values()].some(
        (item) =>
          item.command.action.kind === "edit-comment" &&
          item.command.action.body === "first-use account recovery draft",
      ),
    "Recovered draft could not be admitted after account check",
  );
  const recovered = [...operations.values()].find(
    (item) =>
      item.command.action.kind === "edit-comment" &&
      item.command.action.body === "first-use account recovery draft",
  )!.command.action;
  check(
    recovered.kind === "edit-comment" && recovered.expectedBody === "subsequent external edit",
    "An external read silently rebound the editor's expected body",
  );
  backendOffline = true;
  const parentId = "ffffffff-ffff-4fff-8fff-ffffffffffff",
    childId = "00000000-0000-4000-8000-000000000001";
  await githubWrites.submit({
    operationId: parentId,
    scope,
    actor: { id: 42, login: "browser-fixture" },
    action: { kind: "issue-comment", body: "offline parent" },
  });
  await githubWrites.submit({
    operationId: childId,
    scope,
    actor: { id: 42, login: "browser-fixture" },
    action: {
      kind: "edit-comment",
      target: { source: "local", kind: "issue-comment", operationId: parentId },
      expectedBody: "offline parent",
      body: "offline dependent edit",
    },
  });
  await githubWrites.recover(scope);
  check(!operations.has(parentId) && !operations.has(childId), "Offline chain reached the backend");
  backendOffline = false;
  await githubWrites.recover(scope);
  await githubWrites.recover(scope);
  check(
    operations.has(parentId) &&
      operations.has(childId) &&
      operations.get(parentId)!.sequence < operations.get(childId)!.sequence,
    "UUID-sorted recovery admitted a child before its parent",
  );
  check(
    !githubWrites.getState(scope).operations.find((item) => item.command.operationId === childId)
      ?.admissionError,
    "Recoverable dependency ordering became a permanent rejection",
  );
  githubWrites.activate();
  return { passed };
}
