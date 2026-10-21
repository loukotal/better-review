import type { GithubOutboxOperation } from "@better-review/shared";

import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope, githubWrites } from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

export async function testTimedOutQueueIsStaticAndUnknownDeliveryStillRequiresConsentInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 180 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const journal = createIndexedDbGithubJournal();
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const operations: GithubOutboxOperation[] = [];
  for (const status of ["retry-failed", "uncertain"] as const) {
    const operation: GithubOutboxOperation = {
      command: {
        scope,
        operationId: crypto.randomUUID(),
        expectedActor: { id: 42, login: "browser-fixture" },
        dependencies: [],
        queueDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
        action: { kind: "issue-comment", body: `Retained timed-out ${status} body` },
      },
      status,
      retryMode: "manual",
      attempts: status === "uncertain" ? 1 : 0,
      sequence: operations.length + 1,
      revision: 1,
      createdAt: new Date(Date.now() - 360_000).toISOString(),
      updatedAt: new Date().toISOString(),
      timedOutAt: new Date().toISOString(),
      queueDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
      error: {
        code: "timeout",
        message: "GitHub sync deadline expired. Content retained.",
        retryable: false,
      },
    };
    await journal.admit(operation.command);
    await journal.acknowledge(operation);
    operations.push(operation);
  }
  const follower: GithubOutboxOperation = {
    ...operations[0]!,
    command: {
      ...operations[0]!.command,
      operationId: crypto.randomUUID(),
      dependencies: [operations[0]!.command.operationId],
      action: { kind: "issue-comment", body: "Following retained text" },
    },
    sequence: 3,
    status: "queued",
    timedOutAt: undefined,
    error: undefined,
  };
  await journal.admit(follower.command);
  await journal.acknowledge(follower);
  operations.push(follower);
  await journal.close();
  let unsafe = 0;
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.snapshot": () => ({
        scope,
        revision: 3,
        operations: structuredClone(operations),
      }),
      "githubOutbox.enqueue": () => {
        unsafe++;
        throw new Error("Timeout view must not send");
      },
      "githubOutbox.control": () => {
        unsafe++;
        throw new Error("Timeout view must not control");
      },
    },
  });
  await githubWrites.recoverAll();
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => document.querySelectorAll("[data-github-queue-action]").length === 3,
    "Timeout actions not visible",
  );
  check(
    document.querySelectorAll('[data-github-queue-action] [data-github-sync-status="timed-out"]')
      .length === 2,
    "Timeout roots lack distinct static status",
  );
  check(
    !document.querySelector("[data-global-github-queue] .animate-spin"),
    "Timed-out roots/followers still spin",
  );
  const uncertain = document.querySelector<HTMLElement>(
    `[data-github-queue-action="${operations[1]!.command.operationId}"]`,
  )!;
  uncertain.querySelector<HTMLElement>("summary")!.click();
  await wait(
    () => !!uncertain.querySelector("[data-operation-id]"),
    "Timed-out delivery details missing",
  );
  check(
    uncertain.textContent?.includes("delivery unknown") &&
      uncertain.textContent?.includes("Confirmation is required"),
    "Timeout erased uncertain delivery semantics",
  );
  check(
    ![...uncertain.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Retry",
    ),
    "Unknown timed-out write offers blind resend",
  );
  check(
    uncertain.textContent?.includes("Retained timed-out uncertain body"),
    "Timeout discarded original content",
  );
  check(unsafe === 0, "Opening timeout state performed an unsafe request");
  return { passed };
}
