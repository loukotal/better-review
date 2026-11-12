import { isGithubOutboxAdmissionInput, type GithubOutboxCommand } from "@better-review/shared";

import { githubJournal, githubPrScope, refreshGithubActor } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

const url = "https://github.com/browser-fixture/isolated/pull/1";
const head = "a".repeat(40);

/** An approval draft saved before the head loaded must not disable approval for that PR. */
export async function testApprovalDraftSavedWithoutHeadStaysApprovableInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  // Same slot ApproveButton uses; opened while the PR head was still unknown.
  await githubJournal.openEditor(`${url}:approve`, githubPrScope(url), {
    body: "",
    context: {},
  });
  const admissions: GithubOutboxCommand[] = [];
  const dispose = await mountAppFixture({
    procedures: {
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxAdmissionInput(input)) throw new Error("Invalid fixture admission");
        const command = "command" in input ? input.command : input;
        admissions.push(structuredClone(command));
        return {
          outcome: "rejected",
          operationId: command.operationId,
          error: { code: "fixture", message: "Fixture stops here", retryable: false },
        };
      },
    },
  });
  try {
    await refreshGithubActor();
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!;
    await wait(() => !trigger.disabled, "Approve trigger disabled");
    trigger.click();
    const submit = () =>
      [
        ...(document
          .querySelector("[popover]:popover-open")
          ?.querySelectorAll<HTMLButtonElement>('button[type="submit"]') ?? []),
      ].find((button) => button.textContent?.trim() === "Approve");
    await wait(() => !!submit() && !submit()!.disabled, "Saved headless draft disabled Approve");
    submit()!.click();
    await wait(() => admissions.length === 1, "Approval was not admitted");
    const action = admissions[0]!.action;
    check(
      action.kind === "approve" && action.expectedHeadSha === head,
      "Approval did not target the loaded head",
    );
    return result();
  } finally {
    dispose();
  }
}
