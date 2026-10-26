import type { IssueComment } from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { api } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

/** Runner performs an actual page reload between phases, retaining only browser storage. */
export async function testAppGithubDraftIntentReloadInBrowser(phase = "before") {
  const url = "https://github.com/browser-fixture/isolated/pull/1",
    scope = githubPrScope(url);
  let remote: IssueComment = {
    id: 10,
    body: "original parent body",
    html_url: `${url}#issuecomment-10`,
    user: { login: "browser-fixture", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    canEdit: true,
  };
  const { check, wait, result } = createAssertions(4000);
  await mountAppFixture({
    extras: { comments: [], issueComments: [remote], status: null },
    procedures: {
      "githubOutbox.enqueue": () => {
        throw new Error("Backend deliberately offline; no remote mutation");
      },
      "pr.extras": () => ({ comments: [], issueComments: [remote], status: null }),
    },
  });
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  const card = () =>
    document.querySelector<HTMLElement>('[data-github-comment-key="remote:issue-comment:10"]')!;
  await wait(() => !!card(), "Real App discussion did not render");
  const button = (label: string) =>
    [...card().querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    )!;
  const open = async (mode: "Reply" | "Edit") => {
    button(mode).click();
    await wait(
      () => !!card().querySelector("textarea:not(:disabled)"),
      `${mode} durable intent did not load`,
    );
  };
  const input = () => card().querySelector<HTMLTextAreaElement>("textarea")!;
  const fill = (body: string) => {
    input().value = body;
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const save = async () => {
    input().form!.requestSubmit();
    await wait(
      () => !card().querySelector("textarea"),
      "Editor did not close after local durable admission",
    );
  };
  const repeated = "deliberately identical later reply";
  if (phase === "before") {
    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage)
        throw new Error("Simulated localStorage cleanup failure after IndexedDB commit");
      return originalRemove.call(this, key);
    };
    await open("Reply");
    fill(repeated);
    await save();
    const entries = await githubJournal.entries(scope);
    check(entries.length === 1, "Initial offline reply created duplicate commands");
    const saved = entries[0]!;
    check(!!saved.draftKey, "Actual App reply bypassed atomic draft identity");
    check(
      (await githubJournal.draft(saved.draftKey!))?.submittedOperationId ===
        saved.command.operationId,
      "Submission identity was not atomic with admission",
    );
    sessionStorage.setItem(
      "github-intent-reload-proof",
      JSON.stringify({
        id: saved.command.operationId,
        key: saved.draftKey,
        body: saved.command.action,
      }),
    );
    return result();
  }
  const proof = JSON.parse(sessionStorage.getItem("github-intent-reload-proof")!);
  await open("Reply");
  check(input().value === "", "Reload resurrected an already submitted reply as an unsent editor");
  const prior = await githubJournal.entries(scope);
  check(
    prior.length === 1 && prior[0]!.command.operationId === proof.id,
    "Reload changed or duplicated admitted intent",
  );
  // Replaying the old submitted identity resolves to that same operation, never a new UUID.
  const replay = await githubWrites.submit({
    scope,
    actor: { id: 42, login: "browser-fixture" },
    action: prior[0]!.command.action,
    dependencies: prior[0]!.command.dependencies,
    draftKey: proof.key,
  });
  check(
    replay.operationId === proof.id && (await githubJournal.entries(scope)).length === 1,
    "Recovered submitted identity created another command",
  );
  fill(repeated);
  await save();
  const repeatedEntries = await githubJournal.entries(scope);
  check(
    repeatedEntries.length === 2 && repeatedEntries[0]!.draftKey !== repeatedEntries[1]!.draftKey,
    "A genuinely new identical reply reused the old intent",
  );
  check(
    JSON.stringify(repeatedEntries[0]!.command.action) ===
      JSON.stringify(repeatedEntries[1]!.command.action),
    "Repeated reply fixture did not exercise identical content",
  );

  await open("Reply");
  fill("kept reply, never an edit");
  button("Cancel").click();
  await open("Edit");
  check(input().value === "original parent body", "Reply draft contaminated edit prefill");
  fill("kept independent edit");
  button("Cancel").click();
  await open("Reply");
  check(input().value === "kept reply, never an edit", "Edit draft contaminated reply recovery");
  button("Cancel").click();
  remote = { ...remote, body: "external parent update", updated_at: "2026-01-02T00:00:00Z" };
  await api.fetchPrExtras(url);
  await open("Edit");
  check(input().value === "kept independent edit", "Edit body was rebound after a remote update");
  await save();
  const edit = (await githubJournal.entries(scope)).find(
    (entry) => entry.command.action.kind === "edit-comment",
  )!;
  check(
    edit.command.action.kind === "edit-comment" &&
      edit.command.action.expectedBody === "original parent body",
    "Recovered edit lost its pinned baseline",
  );
  check(
    !!edit.draftKey && edit.draftKey !== proof.key,
    "Edit did not use a separate durable intent",
  );
  await open("Reply");
  check(
    input().value === "kept reply, never an edit",
    "Submitting edit cleared the independent reply intent",
  );
  githubWrites.activate();
  return result();
}

export async function testAppGithubComposerIntentCoverageInBrowser() {
  const url = "https://github.com/browser-fixture/isolated/pull/1",
    scope = githubPrScope(url);
  const { check, wait, result } = createAssertions(4000);
  await mountAppFixture({
    procedures: {
      "githubOutbox.enqueue": () => {
        throw new Error("Backend offline; do not post");
      },
    },
  });
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  for (let n = 0; n < 2; n++) {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "+ Add comment")!
      .click();
    await wait(
      () =>
        !!document.querySelector('textarea[aria-label="New conversation comment"]:not(:disabled)'),
      "New-comment intent did not hydrate",
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New conversation comment"]',
    )!;
    input.value = "same intentionally repeated new comment";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.form!.requestSubmit();
    await wait(
      () => !document.querySelector('textarea[aria-label="New conversation comment"]'),
      "New comment did not durably close",
    );
  }
  document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
  await wait(
    () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
    "Approval intent did not hydrate",
  );
  const approval = document.querySelector<HTMLTextAreaElement>(
    'form[aria-label="Approve PR"] textarea',
  )!;
  approval.value = "approval intent body";
  approval.dispatchEvent(new InputEvent("input", { bubbles: true }));
  approval.form!.requestSubmit();
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.getAttribute("aria-label") === "Approval pending",
      ),
    "Approval was not acknowledged locally",
  );
  const entries = await githubJournal.entries(scope);
  check(
    entries.length === 3 &&
      new Set(entries.map((entry) => entry.draftKey)).size === 3 &&
      entries.every((entry) => !!entry.draftKey),
    "Composer/approval writes bypassed unique editor intent IDs",
  );
  for (const entry of entries)
    check(
      (await githubJournal.draft(entry.draftKey!))?.submittedOperationId ===
        entry.command.operationId,
      "Editor intent and operation were not atomically linked",
    );
  const approvalEntry = entries.find((entry) => entry.command.action.kind === "approve")!;
  check(
    (await githubJournal.draft(approvalEntry.draftKey!))?.context?.expectedHeadSha ===
      "a".repeat(40),
    "Approval intent lost its pinned viewed head",
  );
  check(
    entries[0]!.command.action.kind === "issue-comment" &&
      entries[1]!.command.action.kind === "issue-comment" &&
      entries[0]!.command.action.body === entries[1]!.command.action.body &&
      entries[0]!.command.operationId !== entries[1]!.command.operationId,
    "Genuinely repeated new comments did not get separate admissions",
  );
  githubWrites.activate();
  return result();
}
