import type { GithubOutboxCommand, GithubOutboxSnapshot } from "@better-review/shared";

import { githubPrScope, githubWrites } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

async function exercise(cancel: boolean, stale = false) {
  const { check, wait: waitFor, result } = createAssertions(4000);
  // Keep live queue context in deadline diagnostics, without duplicating polling/counting.
  const wait = async (predicate: () => boolean, message: string) => {
    try {
      await waitFor(predicate, message);
    } catch (cause) {
      if (cause instanceof Error && cause.message === message)
        cause.message = `${message}: ${document.querySelector("[popover]:popover-open")?.textContent}`;
      throw cause;
    }
  };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const rpc = (kind: string, input?: unknown) => window.browserGithubActions({ kind, input });
  const snapshot = async () => (await rpc("snapshot", scope)) as GithubOutboxSnapshot;
  const posts = async () =>
    ((await rpc("state")) as { calls: { method: string }[] }).calls.filter(
      (call) => call.method === "POST",
    ).length;
  const command: GithubOutboxCommand = {
    scope,
    operationId: crypto.randomUUID(),
    expectedActor: { id: 42, login: "browser-fixture" },
    dependencies: [],
    action: {
      kind: "approve",
      expectedHeadSha: "a".repeat(40),
      body: "Retained uncertain approval",
    },
  };
  await rpc("lose-approval-response", true);
  await rpc("enqueue", command);
  let remote = await snapshot();
  for (let n = 0; n < 240 && remote.operations[0]?.status !== "uncertain"; n++) {
    await new Promise(requestAnimationFrame);
    remote = await snapshot();
  }
  check(remote.operations[0]?.status === "uncertain", "Fixture did not reproduce unknown delivery");
  const procedures = {
    "githubOutbox.snapshot": (input: unknown) => rpc("snapshot", input),
    "githubOutbox.pending": () => rpc("pending"),
    "githubOutbox.control": (input: unknown) => rpc("control", input),
    "githubOutbox.heartbeat": (input: unknown) => rpc("heartbeat", input),
    "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
  };
  let dispose = await mountAppFixture({ procedures });
  const button = (text: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        `[popover]:popover-open [data-operation-id="${command.operationId}"] button`,
      ),
    ].find((entry) => entry.textContent?.trim() === text);
  const open = async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
    await wait(
      () => !!document.querySelector(`[data-github-queue-action="${command.operationId}"] summary`),
      "Queue row missing",
    );
    document
      .querySelector<HTMLElement>(`[data-github-queue-action="${command.operationId}"] summary`)!
      .click();
    await wait(
      () => !!document.querySelector(`[data-operation-id="${command.operationId}"]`),
      "Action details missing",
    );
  };
  try {
    await open();
    const baseline = await posts();
    if (!cancel && !stale) {
      const before = (await rpc("state")) as { calls: { method: string }[] };
      const revision = githubWrites
        .getState(scope)
        .operations.find((item) => item.command.operationId === command.operationId)!
        .operation!.revision;
      await window.clickBrowserQueueActionButton(command.operationId, "Check GitHub");
      await wait(
        () =>
          (githubWrites
            .getState(scope)
            .operations.find((item) => item.command.operationId === command.operationId)?.operation
            ?.revision ?? 0) > revision,
        "Read-only check did not return a fresh receipt",
      );
      const after = (await rpc("state")) as typeof before;
      check(
        after.calls.filter((call) => call.method === "GET").length >
          before.calls.filter((call) => call.method === "GET").length,
        "Check GitHub did not read through production adapter",
      );
      check(
        (await posts()) === baseline && (await snapshot()).operations[0]?.status === "uncertain",
        "Read-only check resent or falsely resolved unknown delivery",
      );
    }
    await wait(
      () => !!button("Allow manual retry…") && !button("Allow manual retry…")!.disabled,
      "Delivery check has not settled",
    );
    button("Allow manual retry…")!.click();
    await wait(
      () => !!button("I checked GitHub — allow retry"),
      "Explicit uncertainty confirmation missing",
    );
    check(
      document.body.textContent?.includes("Retrying can duplicate it."),
      "Duplicate risk not disclosed",
    );
    check((await posts()) === baseline, "Opening confirmation sent an action");
    if (stale) {
      const old = (await snapshot()).operations[0]!;
      await rpc("control", {
        kind: "reconcile",
        requestId: crypto.randomUUID(),
        operationId: command.operationId,
        expectedRevision: old.revision,
      });
    }
    button("I checked GitHub — allow retry")!.click();
    if (stale) {
      await wait(
        () =>
          !!document.querySelector("[data-operation-id]") &&
          !!document.querySelector('[popover]:popover-open [role="alert"]'),
        "Stale revision was not reported",
      );
      check(
        (await snapshot()).operations[0]?.status === "uncertain",
        "Stale confirmation changed uncertainty",
      );
      check((await posts()) === baseline, "Stale confirmation resent action");
      return result();
    }
    await wait(
      () =>
        githubWrites
          .getState(scope)
          .operations.find((item) => item.command.operationId === command.operationId)?.status ===
        "retry-failed",
      "Confirmation did not persist manual retry state",
    );
    check((await posts()) === baseline, "Allowing retry dispatched action");
    dispose();
    dispose = await mountAppFixture({ procedures });
    await githubWrites.recoverAll();
    check((await posts()) === baseline, "Reload auto-dispatched manual retry");
    await open();
    button(cancel ? "Cancel queued write" : "Retry")!.click();
    let final = await snapshot();
    for (
      let n = 0;
      n < 240 && final.operations[0]?.status !== (cancel ? "cancelled" : "synced");
      n++
    ) {
      await new Promise(requestAnimationFrame);
      final = await snapshot();
    }
    check(
      final.operations[0]?.status === (cancel ? "cancelled" : "synced"),
      "Explicit retry/cancel did not settle",
    );
    check(
      (await posts()) === baseline + (cancel ? 0 : 1),
      "Retry/cancel dispatched wrong POST count",
    );
    return result();
  } finally {
    dispose();
  }
}
export function testUnknownDeliveryRequiresSeparateManualRetryAfterReloadInBrowser() {
  return exercise(false);
}
export function testUnknownDeliveryCanBeCancelledWithoutResendInBrowser() {
  return exercise(true);
}
export function testUnknownDeliveryStaleConfirmationCannotChangeStateInBrowser() {
  return exercise(false, true);
}
