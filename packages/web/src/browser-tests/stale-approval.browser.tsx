import { render } from "solid-js/web";

import {
  isGithubOutboxCommand,
  type GithubOutboxCommand,
  type GithubOutboxOperation,
} from "@better-review/shared";

import { GithubOperationDetails } from "../components/GithubOperationDetails";
import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
const reviewed = "a".repeat(40);
const latest = "c".repeat(40);

/** A stale approval asks before approving the new head and dismisses itself only after. */
export async function testStaleApprovalPromptsBeforeApprovingLatestHeadInBrowser() {
  const { check, wait, result } = createAssertions(5000);
  const scope = githubPrScope(url);
  const stamp = new Date().toISOString();
  const stale: GithubOutboxOperation = {
    command: {
      operationId: "22222222-2222-4222-8222-222222222222",
      scope,
      expectedActor: { id: 42, login: "browser-fixture" },
      action: { kind: "approve", expectedHeadSha: reviewed, body: "LGTM" },
      dependencies: [],
    },
    status: "retry-failed",
    retryMode: "blocked",
    revision: 2,
    sequence: 1,
    attempts: 1,
    createdAt: stamp,
    updatedAt: stamp,
    error: { code: "head-changed", message: "PR changed", retryable: false },
  };
  const admitted: GithubOutboxCommand[] = [];
  const controls: { kind: string; operationId: string }[] = [];
  const dispose = await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.snapshot": () => ({ scope, revision: 2, operations: [structuredClone(stale)] }),
      "prDetail.refresh": () => prDetailFixture(url, latest),
      "githubOutbox.enqueue": (input) => {
        const command = input as GithubOutboxCommand;
        if (!isGithubOutboxCommand(command)) throw new Error("Invalid command");
        admitted.push(structuredClone(command));
        return {
          outcome: "accepted",
          operation: { ...structuredClone(stale), command, status: "queued", sequence: 2 },
        };
      },
      "githubOutbox.control": (input) => {
        const control = input as { kind: string; operationId: string };
        controls.push({ kind: control.kind, operationId: control.operationId });
        return {
          outcome: "applied",
          operation: { ...structuredClone(stale), status: "cancelled" },
        };
      },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  let disposeDetails = () => {};
  try {
    await refreshGithubActor();
    githubWrites.activate(scope);
    await wait(
      () =>
        githubWrites
          .getState(scope)
          .operations.some((item) => item.command.operationId === stale.command.operationId),
      "Stale approval missing from the queue",
    );
    disposeDetails = render(
      () => (
        <GithubOperationDetails
          scope={scope}
          operations={githubWrites.getState(scope).operations}
        />
      ),
      host,
    );
    const button = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
        item.textContent?.trim().startsWith(label),
      );
    check(!button("Retry"), "Stale approval offers a retry on the old head");
    button("Approve latest")!.click();
    await wait(() => !!button("Approve ccccccc"), "Prompt did not show the latest head");
    const prompt = host.querySelector('[aria-label="PR changed since your review"]')!;
    check(prompt.textContent?.includes("aaaaaaa"), "Prompt hides the reviewed commit");
    check(
      prompt.querySelector("a")?.getAttribute("href") === `${url}/files/${reviewed}..${latest}`,
      "Prompt does not link to the changes since review",
    );
    check(admitted.length === 0, "Approval queued before confirmation");
    button("Approve ccccccc")!.click();
    await wait(() => controls.length === 1, "Stale approval was not dismissed");
    const action = admitted[0]?.action;
    check(
      admitted.length === 1 &&
        action?.kind === "approve" &&
        action.expectedHeadSha === latest &&
        action.body === "LGTM",
      "New approval does not target the latest head with the saved comment",
    );
    check(
      controls[0]!.kind === "cancel" && controls[0]!.operationId === stale.command.operationId,
      "Wrong control for the stale approval",
    );
    return result();
  } finally {
    disposeDetails();
    host.remove();
    dispose();
  }
}
