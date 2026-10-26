import type { GithubOutboxSnapshot } from "@better-review/shared";

import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    clickBrowserQueueBatch(kind: "retry" | "clear"): Promise<void>;
  }
}
const url = "https://github.com/browser-fixture/isolated/pull/1",
  scope = githubPrScope(url);
async function fixture(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const { check, wait, result } = createAssertions(4000);
  let batches = 0;
  const rpc = (kind: string, input?: unknown) => window.browserGithubActions({ kind, input });
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.enqueue": (input) => rpc("enqueue", input),
      "githubOutbox.snapshot": (input) => rpc("snapshot", input),
      "githubOutbox.pending": () => rpc("pending"),
      "githubOutbox.control": (input) => rpc("control", input),
      "githubOutbox.batchControl": (input) => {
        batches++;
        return rpc("batch-control", input);
      },
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
      ...overrides,
    },
  });
  await refreshGithubActor();
  const snapshot = async () => (await rpc("snapshot", scope)) as GithubOutboxSnapshot;
  const posts = async () =>
    ((await rpc("state")) as { calls: { method: string }[] }).calls.filter(
      (call) => call.method === "POST",
    ).length;
  const settle = async (operationId: string, status: string) => {
    let data = await snapshot();
    for (
      let n = 0;
      n < 240 &&
      data.operations.find((item) => item.command.operationId === operationId)?.status !== status;
      n++
    ) {
      await new Promise(requestAnimationFrame);
      data = await snapshot();
    }
    check(
      data.operations.find((item) => item.command.operationId === operationId)?.status === status,
      `Worker did not reach ${status}`,
    );
    await githubWrites.snapshot(scope);
  };
  const open = async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
    await wait(
      () => !!document.querySelector('[data-github-queue-batch="retry"]'),
      "Primary Retry/Clear toolbar missing",
    );
  };
  return { rpc, snapshot, posts, check, wait, result, settle, open, batches: () => batches };
}

export async function testGlobalRetryActuallySendsOneExplicitAttemptAndReportsItsResultInBrowser() {
  const f = await fixture();
  await f.rpc("reject-approval", true);
  const receipt = await queueGithubWrite(url, {
    kind: "approve",
    body: "Global retry retained review",
    expectedHeadSha: "a".repeat(40),
  });
  await f.settle(receipt.operationId, "retry-failed");
  const baseline = await f.posts();
  await f.open();
  await f.rpc("hold-approval");
  try {
    await window.clickBrowserQueueBatch("retry");
    await f.wait(
      () =>
        document.querySelector<HTMLButtonElement>('[data-github-queue-batch="retry"]')?.disabled ===
          true &&
        document
          .querySelector('[data-github-queue-batch="retry"]')
          ?.textContent?.includes("Retrying") === true,
      "Global Retry lacks single-flight busy progress",
    );
    await f.wait(
      () =>
        !!document.querySelector("[data-github-queue-action]")?.textContent?.includes("Retrying"),
      "Retry did not await the worker's actual attempt",
    );
    f.check(
      (await f.posts()) === baseline + 1 && f.batches() === 1,
      "Global Retry dispatched more than one explicit request",
    );
    await f.rpc("release-approval");
    await f.wait(
      () =>
        !!document.querySelector("[popover]:popover-open")?.textContent?.includes("1 retry failed"),
      "Global Retry looked unchanged after a rejected attempt",
    );
    f.check(
      document.querySelector("[data-github-queue-action]")?.textContent?.includes("HTTP 422"),
      "Retry result hid the authoritative GitHub status",
    );
    f.check((await f.posts()) === baseline + 1, "Retry failure dispatched automatically again");
    return f.result();
  } finally {
    await f.rpc("release-approval");
  }
}

export async function testGlobalClearCancelsFailedRootAndQueuedFollowerAtomicallyWithoutSendingInBrowser() {
  const f = await fixture();
  await f.rpc("fail-edit", true);
  const root = await queueGithubWrite(url, {
    kind: "edit-comment",
    target: { source: "remote", kind: "review-comment", id: 20 },
    expectedBody: "action fixture body",
    body: "Root original recovery text",
  });
  await f.settle(root.operationId, "retry-failed");
  const child = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "Follower original recovery text",
  });
  await githubWrites.recoverAll();
  const baseline = await f.posts();
  await f.open();
  await window.clickBrowserQueueBatch("clear");
  await f.wait(
    () =>
      document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("No pending actions") ?? false,
    "Clear did not clear the active queue",
  );
  const data = await f.snapshot();
  f.check(
    ![root.operationId, child.operationId].some(
      (id) =>
        data.operations.find((item) => item.command.operationId === id)?.status !== "cancelled",
    ),
    "Clear did not atomically cancel root and follower",
  );
  f.check(
    (await f.posts()) === baseline && f.batches() === 1,
    "Clear released follower into a GitHub POST",
  );
  [...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")]
    .find((button) => button.textContent?.trim() === "Drafts & history")!
    .click();
  await f.wait(
    () =>
      !!document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("Root original recovery text") &&
      !!document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("Follower original recovery text"),
    "Clear discarded recoverable original content",
  );
  return f.result();
}

export async function testGlobalRetrySkipsUnknownDeliveryAndClearArchivesItWithoutClaimingCancellationInBrowser() {
  const f = await fixture();
  await f.rpc("lose-approval-response", true);
  const root = await queueGithubWrite(url, {
    kind: "approve",
    body: "Unknown archived review original",
    expectedHeadSha: "a".repeat(40),
  });
  await f.settle(root.operationId, "uncertain");
  const child = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "Following unknown root",
  });
  await githubWrites.recoverAll();
  const baseline = await f.posts();
  await f.open();
  await window.clickBrowserQueueBatch("retry");
  await f.wait(
    () =>
      !!document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("confirmation required"),
    "Unknown delivery was mislabeled as retried",
  );
  f.check((await f.posts()) === baseline, "Global Retry blindly resent an uncertain action");
  await window.clickBrowserQueueBatch("clear");
  await f.wait(
    () =>
      !!document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("archived 1 with delivery unknown"),
    "Clear falsely claimed unknown delivery was cancelled",
  );
  const data = await f.snapshot(),
    archived = data.operations.find((item) => item.command.operationId === root.operationId)!;
  f.check(
    archived.archivedAt &&
      archived.status === "uncertain" &&
      data.operations.find((item) => item.command.operationId === child.operationId)?.status ===
        "cancelled",
    "Clear lost uncertainty or failed to cancel its follower atomically",
  );
  f.check(
    (await f.posts()) === baseline,
    "Clear resent uncertain work or released its queued follower",
  );
  [...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")]
    .find((button) => button.textContent?.trim() === "Drafts & history")!
    .click();
  await f.wait(
    () =>
      !!document
        .querySelector("[popover]:popover-open")
        ?.textContent?.includes("Unknown archived review original"),
    "Archived uncertainty lost its original content",
  );
  return f.result();
}

export async function testGlobalClearFencesLostAdmissionBeforeLateAcknowledgementInBrowser() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admissions = 0;
  const f = await fixture({
    "githubOutbox.enqueue": async (input) => {
      admissions++;
      await held;
      return window.browserGithubActions({ kind: "enqueue", input });
    },
  });
  try {
    const local = await queueGithubWrite(url, {
      kind: "issue-comment",
      body: "Clear before acknowledgement retained body",
    });
    await f.wait(() => admissions === 1, "Admission was not held before acknowledgement");
    await f.open();
    await window.clickBrowserQueueBatch("clear");
    await f.wait(
      () =>
        document
          .querySelector("[popover]:popover-open")
          ?.textContent?.includes("No pending actions") ?? false,
      "Clear did not fence locally saved admission",
    );
    release();
    await githubWrites.recoverAll();
    await githubWrites.recoverAll();
    const operation = (await f.snapshot()).operations.find(
      (item) => item.command.operationId === local.operationId,
    );
    f.check(
      operation?.status === "cancelled" && (await f.posts()) === 0,
      "Late enqueue acknowledgement resurrected or sent a cleared intent",
    );
    [...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")]
      .find((button) => button.textContent?.trim() === "Drafts & history")!
      .click();
    await f.wait(
      () =>
        !!document
          .querySelector("[popover]:popover-open")
          ?.textContent?.includes("Clear before acknowledgement retained body"),
      "Clear lost original local body",
    );
    return f.result();
  } finally {
    release();
  }
}
