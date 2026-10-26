import { isGithubOutboxControl, type GithubOutboxOperation } from "@better-review/shared";

import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope, githubWrites } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

declare global {
  interface Window {
    clickBrowserQueueActionButton(operationId: string, label: string): Promise<void>;
    setBrowserQueueViewport(width?: number, height?: number): Promise<void>;
  }
}

async function exercise(width = 390, height = 844) {
  const { check, wait, result } = createAssertions(4000);
  const journal = createIndexedDbGithubJournal();
  await window.setBrowserQueueViewport(width, height);
  const operations: GithubOutboxOperation[] = [];
  for (const number of [16218, 14824, 15776, 16333]) {
    const scope = githubPrScope(`https://github.com/myzenbase/zenbase/pull/${number}`);
    const operation: GithubOutboxOperation = {
      command: {
        scope,
        operationId: `10000000-0000-4000-8000-${String(operations.length + 1).padStart(12, "0")}`,
        dependencies: [],
        expectedActor: { id: 42, login: "browser-fixture" },
        action:
          number === 16333
            ? { kind: "approve", body: "Saved review", expectedHeadSha: "a".repeat(40) }
            : number === 16218
              ? {
                  kind: "edit-comment",
                  body: "Updated text",
                  expectedBody: "Old text",
                  target: { source: "remote", kind: "issue-comment", id: 10 },
                }
              : {
                  kind: "delete-comment",
                  expectedBody: "Saved original",
                  target: { source: "remote", kind: "issue-comment", id: number },
                },
      },
      status: number === 16333 ? "uncertain" : "retry-failed",
      attempts: 1,
      revision: 1,
      sequence: operations.length + 1,
      retryMode: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: {
        code: "permission",
        message:
          number === 16333
            ? "GitHub has not provided unambiguous evidence."
            : "The original comment no longer matches. Your saved content is retained.",
        retryable: false,
      },
    };
    await journal.admit(operation.command);
    await journal.acknowledge(operation);
    operations.push(operation);
    if (number === 16218) {
      const child: GithubOutboxOperation = {
        ...operation,
        command: {
          ...operation.command,
          operationId: "10000000-0000-4000-8000-000000000002",
          dependencies: [operation.command.operationId],
          action: {
            kind: "inline-comment",
            expectedHeadSha: "a".repeat(40),
            body: "Following queued comment",
            anchor: { path: "src/example.ts", line: 9, side: "RIGHT" },
          },
        },
        sequence: 2,
        status: "queued",
        retryMode: "blocked",
        attempts: 0,
        error: undefined,
      };
      await journal.admit(child.command);
      await journal.acknowledge(child);
      operations.push(child);
    }
  }
  await journal.close();
  let deliveryReads = 0,
    writePosts = 0,
    refreshes = 0;
  let snapshotGate: Promise<void> | undefined;
  let failQueueSnapshot = false;
  let pendingDelivery: GithubOutboxOperation | undefined;
  const finishDelivery = (failed = false) => {
    if (!pendingDelivery) throw new Error("No held delivery check");
    deliveryReads++;
    pendingDelivery.revision++;
    pendingDelivery.updatedAt = new Date().toISOString();
    pendingDelivery.nextAttemptAt = new Date(Date.now() + 5000).toISOString();
    pendingDelivery.error = failed
      ? { code: "network", message: "Fixture GitHub read failed", retryable: true }
      : {
          code: "conflict",
          message:
            "GitHub has not provided unambiguous evidence. Explicit confirmation is required.",
          retryable: false,
        };
    pendingDelivery = undefined;
  };
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.snapshot": async (input) => {
        if (snapshotGate) await snapshotGate;
        if (failQueueSnapshot) throw new Error("Fixture queue snapshot unavailable");
        const scope = input as GithubOutboxOperation["command"]["scope"];
        return {
          scope,
          revision: operations
            .filter((item) => item.command.scope.url === scope.url)
            .reduce((n, item) => n + item.revision, 0),
          operations: structuredClone(
            operations.filter((item) => item.command.scope.url === scope.url),
          ),
        };
      },
      "githubOutbox.enqueue": () => {
        writePosts++;
        throw new Error("Fixture must not send a GitHub action");
      },
      "githubOutbox.control": (input) => {
        if (!isGithubOutboxControl(input)) throw new Error("Invalid control");
        const operation = operations.find(
          (item) => item.command.operationId === input.operationId,
        )!;
        if (input.kind === "reconcile") {
          operation.revision++;
          operation.updatedAt = new Date().toISOString();
          operation.nextAttemptAt = operation.updatedAt;
          pendingDelivery = operation;
        } else if (input.kind === "resolve-uncertainty") {
          operation.status = "retry-failed";
          operation.retryMode = "manual";
          operation.revision++;
        } else {
          writePosts++;
          throw new Error("No retry or cancel requested by fixture");
        }
        return { outcome: "applied", operation: structuredClone(operation) };
      },
      "githubOutbox.pending": () => [],
      "prs.refresh": () => {
        refreshes++;
        return { prs: [], fetchedAt: Date.now() };
      },
    },
  });
  await githubWrites.recoverAll();
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => document.querySelectorAll("[data-github-queue-action]").length === 5,
    "Exact five-row queue missing",
  );
  const uncertain = operations.find((item) => item.status === "uncertain")!;
  const row = () =>
    document.querySelector<HTMLElement>(
      `[data-github-queue-action="${uncertain.command.operationId}"]`,
    )!;
  row().querySelector<HTMLElement>("summary")!.click();
  await wait(() => !!row().querySelector("[data-operation-id]"), "Uncertain detail did not expand");
  if (row().textContent?.includes("Check GitHub again (no resend)"))
    await window.captureBrowserQueueLayout("stuck-before");
  const scroll = document.querySelector<HTMLElement>("[data-github-queue-scroll]")!;
  const visible = (element: Element | undefined | null) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect(),
      bounds = scroll.getBoundingClientRect();
    return (
      rect.top >= bounds.top &&
      rect.bottom <= bounds.bottom &&
      rect.left >= bounds.left &&
      rect.right <= bounds.right &&
      rect.width > 0
    );
  };
  const actionButton = (label: string) =>
    [...row().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.textContent?.trim() === label ||
        (label === "Check GitHub" &&
          button.textContent?.trim() === "Check GitHub again (no resend)"),
    );
  await wait(
    () => visible(actionButton("Check GitHub")) && visible(actionButton("Allow manual retry…")),
    "Bottom-row recovery buttons are below the queue viewport",
  );
  check(
    row().querySelectorAll("[data-github-sync-status]").length === 1,
    "Expanded row duplicates action status heading",
  );
  if (width === 390) await window.captureBrowserQueueLayout("stuck-after");
  let releaseSnapshot!: () => void;
  snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  failQueueSnapshot = true;
  const refresh = githubWrites.recoverAll();
  check(
    !!document.querySelector('[data-github-queue-batch="retry"]') &&
      !!document.querySelector('[data-github-queue-batch="clear"]') &&
      ![...document.querySelectorAll<HTMLButtonElement>("[popover]:popover-open button")].some(
        (button) => button.textContent?.trim() === "Refresh",
      ),
    "Primary queue actions must be Retry/Clear, not snapshot Refresh",
  );
  releaseSnapshot();
  snapshotGate = undefined;
  await refresh;
  failQueueSnapshot = false;
  check(
    deliveryReads === 0 && !row().textContent?.includes("Delivery checked"),
    "Queue snapshots fabricated a GitHub delivery check",
  );
  await window.clickBrowserQueueActionButton(uncertain.command.operationId, "Check GitHub");
  await wait(
    () => !!pendingDelivery && !!actionButton("Checking…"),
    "Held acknowledgement did not remain Checking",
  );
  check(
    deliveryReads === 0 && !row().textContent?.includes("Delivery checked"),
    "Acknowledgement or prior error fabricated a completed check",
  );
  finishDelivery();
  await githubWrites.snapshot(uncertain.command.scope);
  await wait(
    () =>
      deliveryReads === 1 &&
      !!row().textContent?.includes("Delivery checked") &&
      !!row().textContent?.includes("GitHub cannot confirm delivery"),
    "Unchanged delivery check lacks a clear outcome",
  );
  check(writePosts === 0 && refreshes === 0, "Delivery check wrote or refreshed unrelated list");
  await wait(
    () => !!actionButton("Check GitHub") && !actionButton("Check GitHub")!.disabled,
    "First delivery check has not settled",
  );
  await window.clickBrowserQueueActionButton(uncertain.command.operationId, "Check GitHub");
  await wait(
    () => !!pendingDelivery && !!actionButton("Checking…"),
    "Second check did not hold its acknowledgement",
  );
  check(
    !row().textContent?.includes("Delivery checked"),
    "Old successful timestamp survived a new pending check",
  );
  finishDelivery(true);
  await githubWrites.snapshot(uncertain.command.scope);
  await wait(
    () =>
      !!row().textContent?.includes("Delivery could not be checked") &&
      !actionButton("Allow manual retry…")?.disabled,
    "Failed read did not show a truthful failure",
  );
  check(
    !row().textContent?.includes("Delivery checked"),
    "Failed GitHub read was stamped as a successful check",
  );
  failQueueSnapshot = true;
  await window.clickBrowserQueueActionButton(uncertain.command.operationId, "Check GitHub");
  await wait(
    () =>
      !!row().textContent?.includes("Delivery check status is unavailable") &&
      !actionButton("Allow manual retry…")?.disabled,
    "Snapshot failure was mislabeled as a completed delivery check",
  );
  failQueueSnapshot = false;
  check(
    !row().textContent?.includes("Delivery checked") && deliveryReads === 2,
    "Failed receipt read fabricated a GitHub delivery timestamp",
  );
  await window.clickBrowserQueueActionButton(uncertain.command.operationId, "Allow manual retry…");
  await wait(
    () => !!row().textContent?.includes("Retrying can duplicate it."),
    "Duplicate warning missing",
  );
  await wait(
    () => visible(actionButton("I checked GitHub — allow retry")),
    "Manual consent action is clipped",
  );
  const warning = row().querySelector('[aria-label="Allow manual retry confirmation"] p');
  check(visible(warning), "Full duplicate warning is clipped while consent is visible");
  if (width === 320) await window.captureBrowserQueueLayout("consent-320");
  await window.clickBrowserQueueActionButton(
    uncertain.command.operationId,
    "I checked GitHub — allow retry",
  );
  await wait(
    () => !!actionButton("Retry") && visible(actionButton("Retry")),
    "Separate Retry not reachable after manual confirmation",
  );
  check(writePosts === 0, "Manual confirmation auto-sent action");
  const blocked = operations.find((item) => item.command.dependencies.length)!;
  const blockedRow = document.querySelector<HTMLElement>(
    `[data-github-queue-action="${blocked.command.operationId}"]`,
  )!;
  blockedRow.querySelector<HTMLElement>("summary")!.click();
  await wait(
    () =>
      [...blockedRow.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "View blocking action",
      ),
    "Blocked row cannot reveal root",
  );
  [...blockedRow.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "View blocking action")!
    .click();
  const rootRow = document.querySelector<HTMLDetailsElement>(
    `[data-github-queue-action="${blocked.command.dependencies[0]}"]`,
  )!;
  await wait(
    () => rootRow.open && rootRow.contains(document.activeElement),
    "Blocker navigation did not focus expanded root",
  );
  const retry = () =>
    [...rootRow.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
  const cancel = () =>
    [...rootRow.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel queued write",
    );
  await wait(
    () => visible(retry()) && visible(cancel()),
    "Failed root Retry/Cancel hidden below diagnostics",
  );
  check(
    rootRow.textContent?.includes("automatically unblocks"),
    "Cancellation consequences hidden",
  );
  return result();
}
export function testActualFiveRowQueueRecoveryButtonsStayReachableInBrowser() {
  return exercise();
}
export function testSmallViewportKeepsWholeDuplicateWarningAndConsentVisibleInBrowser() {
  return exercise(320, 400);
}
