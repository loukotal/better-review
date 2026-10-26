import { isGithubOutboxAdmissionInput, type GithubOutboxCommand } from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { queryClient, queryKeys, refreshPrDetail, type PrCoreData } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

/** Real App selection across distinct detail/diff heads; admission is rejected locally. */
export async function testChangesHeadCooldownSurvivesNewerDetailHeadInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const scope = githubPrScope(url),
    headA = "a".repeat(40),
    headB = "c".repeat(40);
  const realNow = Date.now;
  let clock = realNow();
  const retryAt = new Date(clock + 60_000).toISOString();
  const admissions: GithubOutboxCommand[] = [];
  const initial = prDetailFixture(url, headA),
    fresh = prDetailFixture(url, headB);
  let identity = { id: 42, login: "browser-fixture" };
  Date.now = () => clock;
  let dispose = () => {};
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    )!;
  const saved = () => document.querySelector<HTMLElement>('[aria-label="Saved approval cooldown"]');
  try {
    dispose = await mountAppFixture({
      procedures: {
        "prDetail.get": () => initial,
        "prDetail.refresh": () => fresh,
        "githubOutbox.identity": () => ({ actor: identity }),
        "githubOutbox.enqueue": (input) => {
          check(
            isGithubOutboxAdmissionInput(input),
            "Cooldown fixture received an invalid admission",
          );
          if (!isGithubOutboxAdmissionInput(input)) throw new Error("Invalid fixture admission");
          const command = "command" in input ? input.command : input;
          admissions.push(structuredClone(command));
          return {
            outcome: "rejected",
            operationId: command.operationId,
            error: {
              code: "approval-cooldown",
              message: "Retained approval cooldown",
              retryable: true,
              retryAt,
            },
          };
        },
      },
    });
    await refreshGithubActor();
    document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
    await wait(
      () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
      "Head A approval editor did not hydrate",
    );
    const editor = document.querySelector<HTMLTextAreaElement>(
      'form[aria-label="Approve PR"] textarea',
    )!;
    editor.value = "Keep this head A approval";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    editor.form!.requestSubmit();
    await wait(
      () =>
        admissions.length === 1 &&
        githubWrites.getState(scope).operations.some((item) => item.admissionRetryAt === retryAt),
      "Head A admission did not retain its local cooldown",
    );
    const original = admissions[0]!;
    check(
      original.action.kind === "approve" && original.action.expectedHeadSha === headA,
      "Initial approval did not capture the displayed Changes head A",
    );
    button("Approval pending").click();
    await wait(() => !!saved(), "Saved head A cooldown did not open");

    await refreshPrDetail(url);
    check(
      queryClient.getQueryData<PrCoreData>(queryKeys.pr.core(url))?.headSha === headA,
      "Detail refresh unexpectedly replaced the displayed Changes head A",
    );
    const refreshed = queryClient.getQueryData<typeof fresh>(queryKeys.pr.detail(url));
    check(
      refreshed?.metadata.status === "available" &&
        refreshed.metadata.data.head.sha === headB &&
        document.querySelector("diffs-container"),
      "New detail head B did not retain the mounted Changes view",
    );
    check(saved(), "Detail head B refresh hid the saved head A cooldown");
    check(
      saved()?.querySelector<HTMLTextAreaElement>("textarea")?.value ===
        "Keep this head A approval",
      "Detail head B refresh lost the saved approval body",
    );
    check(
      !document.querySelector('form[aria-label="Approve PR"]'),
      "Detail head B refresh exposed a fresh composer for an existing head A intent",
    );
    check(
      button("Approval pending")?.getAttribute("aria-label") === "Approve PR",
      "Head mismatch did not guard presentation state separately from retained operations",
    );

    button("Overview").click();
    await wait(
      () => !!document.querySelector("[data-pr-overview]"),
      "Overview head B did not mount",
    );
    check(
      !!document.querySelector('button[aria-label="Approve PR"]') && !button("Approval pending"),
      "Overview head B selected the head A cooldown",
    );
    button("Changes").click();
    await wait(
      () => !!button("Approval pending"),
      "Returning to Changes head A lost the saved cooldown",
    );
    identity = { id: 99, login: "other-actor" };
    await refreshGithubActor();
    check(!button("Approval pending"), "Head A cooldown leaked to another numeric actor");
    identity = { id: 42, login: "browser-fixture" };
    await refreshGithubActor();
    button("Approval pending").click();
    await wait(() => !!saved(), "Original actor could not reopen the saved cooldown");
    check(admissions.length === 1, "Detail/tab/account changes created another admission");
    clock += 60_001;
    await wait(
      () => !!saved()?.querySelector<HTMLButtonElement>("button:not(:disabled)"),
      "Saved head A intent lost access to explicit Retry",
    );
    saved()!.querySelector<HTMLButtonElement>("button")!.click();
    await wait(
      () => admissions.length === 2,
      "Explicit head A retry did not reach fixtured admission",
    );
    check(
      admissions[1]!.operationId === original.operationId &&
        JSON.stringify(admissions[1]) === JSON.stringify(original),
      "Retry minted another UUID or changed the saved actor/head/body",
    );
    check(
      (await githubJournal.entries(scope)).length === 1,
      "Head refresh or retry created a second durable approval intent",
    );
    check(
      !document.querySelector('form[aria-label="Approve PR"]'),
      "Retry exposed a fresh composer for the saved intent",
    );
    return { ...result(), admissions: admissions.length, operationId: original.operationId };
  } finally {
    dispose();
    Date.now = realNow;
  }
}
