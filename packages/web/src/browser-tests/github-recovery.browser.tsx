import type { GithubOutboxControl, GithubOutboxOperation } from "@better-review/shared";
import { isGithubOutboxCommand } from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

/** A rotated editor and cancelled sole intent must still leave read-only text recovery. */
export async function testAppCancelledCommentRecoveryInBrowser() {
  let passed = 0,
    revision = 0,
    enqueueCalls = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const records = new Map<string, GithubOutboxOperation>();
  await mountAppFixture({
    procedures: {
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid recovery fixture command");
        enqueueCalls++;
        const operation: GithubOutboxOperation = {
          command: input,
          status: "queued",
          revision: 1,
          sequence: 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
        records.set(input.operationId, operation);
        revision++;
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision,
        operations: [...records.values()].map((item) => structuredClone(item)),
      }),
      "githubOutbox.control": (input) => {
        const control = input as GithubOutboxControl;
        if (control.kind !== "cancel") throw new Error("Recovery must never resend");
        const operation = records.get(control.operationId)!;
        operation.status = "cancelled";
        operation.revision++;
        revision++;
        return { outcome: "applied", operation: structuredClone(operation) };
      },
    },
  });
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
  await wait(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (item) => item.textContent?.trim() === "+ Add comment",
      ),
    "Conversation editor not reachable",
  );
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === "+ Add comment")!
    .click();
  await wait(
    () =>
      !!document.querySelector(
        'form[aria-label="New conversation comment"] textarea:not(:disabled)',
      ),
    "Durable editor not ready",
  );
  const input = document.querySelector<HTMLTextAreaElement>(
    'form[aria-label="New conversation comment"] textarea',
  )!;
  input.value = "recover this sole cancelled comment";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  input.form!.requestSubmit();
  await wait(
    () =>
      records.size === 1 && !document.querySelector('form[aria-label="New conversation comment"]'),
    "Submission did not rotate/close editor",
  );
  const operationId = [...records.keys()][0]!;
  check(
    (await githubJournal.editorDrafts(scope)).every((draft) => !draft.body.trim()),
    "Submitted body remained in editor rather than retained operation",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => !!document.querySelector(`[data-github-queue-action="${operationId}"] summary`),
    "Pending action row missing",
  );
  document
    .querySelector<HTMLElement>(`[data-github-queue-action="${operationId}"] summary`)!
    .click();
  await wait(
    () => !!document.querySelector(`[popover]:popover-open [data-operation-id="${operationId}"]`),
    "Pending cancellation controls missing",
  );
  const item = document.querySelector(
    `[popover]:popover-open [data-operation-id="${operationId}"]`,
  )!;
  [...item.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Cancel queued write")!
    .click();
  await wait(
    () =>
      githubWrites.getState(scope).pendingCount === 0 &&
      records.get(operationId)?.status === "cancelled",
    "Sole write did not cancel",
  );
  await window.dismissBrowserPopover("escape");
  await wait(() => !document.querySelector("[popover]:popover-open"), "Recovery did not close");
  const recovery = document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]');
  check(!!recovery, "Zero-pending history icon disappeared with retained cancelled text");
  check(
    recovery!.querySelectorAll("svg").length === 1 && !recovery!.innerText.trim(),
    "History trigger is not one text-free icon",
  );
  check(
    !document.querySelector("[data-github-comment-key]"),
    "Cancelled comment still rendered as pending",
  );
  recovery!.click();
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Drafts & history",
      ),
    "History view toggle missing",
  );
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Drafts & history")!
    .click();
  await wait(
    () =>
      !!document.querySelector(
        `[popover]:popover-open [data-github-recovery-operation="${operationId}"]`,
      ),
    "Cancelled history not reachable",
  );
  const history = document.querySelector<HTMLDetailsElement>(
    `[data-github-recovery-operation="${operationId}"]`,
  )!;
  (history.parentElement as HTMLDetailsElement).open = true;
  history.open = true;
  check(
    history.innerText.includes("recover this sole cancelled comment"),
    "Cancelled text not readable after reopening history",
  );
  check(!history.querySelector("button"), "Read-only history exposed resend controls");
  check(
    enqueueCalls === 1 &&
      (await githubJournal.editorDrafts(scope)).every((draft) => !draft.body.trim()),
    "Opening recovery requeued or restored submitted text as a new intent",
  );
  return { passed };
}
