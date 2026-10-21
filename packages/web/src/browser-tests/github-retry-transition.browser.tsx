import type { GithubOutboxCommand, GithubOutboxSnapshot } from "@better-review/shared";

import { githubPrScope, githubWrites } from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

export async function testExplicitFailedRetryWaitsForActualWorkerAttemptInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 240 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
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
    action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "Preserved failed approval" },
  };
  await rpc("reject-approval", true);
  await rpc("enqueue", command);
  let initial = await snapshot();
  for (let n = 0; n < 240 && initial.operations[0]?.status !== "retry-failed"; n++) {
    await new Promise(requestAnimationFrame);
    initial = await snapshot();
  }
  check(
    initial.operations[0]?.status === "retry-failed" && initial.operations[0]?.attempts === 1,
    "Fixture lacks a known rejected write",
  );
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.snapshot": (input) => rpc("snapshot", input),
      "githubOutbox.pending": () => rpc("pending"),
      "githubOutbox.control": (input) => rpc("control", input),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
    },
  });
  await githubWrites.recoverAll();
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => !!document.querySelector(`[data-github-queue-action="${command.operationId}"] summary`),
    "Rejected operation missing from queue",
  );
  const row = () => document.querySelector(`[data-github-queue-action="${command.operationId}"]`)!;
  row().querySelector<HTMLElement>("summary")!.click();
  await wait(
    () =>
      [...row().querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Retry" && !button.disabled,
      ),
    "Explicit Retry unavailable",
  );
  const baseline = await posts();
  await rpc("hold-approval");
  try {
    await window.clickBrowserQueueActionButton(command.operationId, "Retry");
    await wait(
      () => githubWrites.getState(scope).operations[0]?.status === "inflight",
      "Retry receipt did not observe worker transition",
    );
    await wait(
      () => !!row().textContent?.includes("Retrying"),
      "Retry request was acknowledged without visible worker progress",
    );
    check(
      (await posts()) === baseline + 1,
      "Explicit retry did not issue exactly one new GitHub POST",
    );
    await rpc("release-approval");
    await wait(
      () => !!row().textContent?.includes("Retry failed"),
      "Rejected next attempt looked unchanged or remained busy forever",
    );
    check(
      row().textContent?.includes("HTTP 422"),
      "Retry failure hid the authoritative GitHub HTTP status",
    );
    check(
      githubWrites.getState(scope).operations[0]?.operation?.attempts === 2,
      "UI did not observe the actual second attempt",
    );
    check((await posts()) === baseline + 1, "Retry failure silently dispatched another write");
    check(
      row().textContent?.includes("Preserved failed approval"),
      "Retry failure discarded original content",
    );
    return { passed };
  } finally {
    await rpc("release-approval");
  }
}
