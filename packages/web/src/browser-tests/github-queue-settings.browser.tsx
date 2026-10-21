import {
  isGithubOutboxCommand,
  isGithubOutboxControl,
  type GithubOutboxOperation,
} from "@better-review/shared";

import { GITHUB_QUEUE_SETTINGS_KEY, getGithubSyncTimeoutMs } from "../lib/github-queue-settings";
import { setGithubSyncTimeoutMs } from "../lib/github-queue-settings";
import {
  githubPrScope,
  githubWrites,
  queueGithubWrite,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

export async function testGithubSyncTimeoutSettingsAvailableAcrossListAndReviewReloadInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 180 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  localStorage.removeItem(GITHUB_QUEUE_SETTINGS_KEY);
  let dispose = await mountAppFixture({ initialPath: "/", waitForFiles: false });
  const open = async () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Review settings"]',
    );
    check(buttons.length === 1, "Settings missing or duplicated on this route");
    buttons[0]!.click();
    await wait(
      () =>
        !!document.querySelector('[popover]:popover-open select[aria-label="GitHub sync timeout"]'),
      "Timeout selector missing",
    );
    return document.querySelector<HTMLSelectElement>(
      '[popover]:popover-open select[aria-label="GitHub sync timeout"]',
    )!;
  };
  let select = await open();
  check(select.value === "300000", "Timeout default is not five minutes");
  check(
    [...select.options].map((option) => option.textContent).join(",") ===
      "5 minutes,15 minutes,30 minutes,60 minutes",
    "Timeout presets differ from supported choices",
  );
  select.value = "900000";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  check(
    getGithubSyncTimeoutMs() === 900000 &&
      JSON.parse(localStorage.getItem(GITHUB_QUEUE_SETTINGS_KEY)!).version === 1,
    "Selected timeout was not persisted",
  );
  check(
    document
      .querySelector("[popover]:popover-open")
      ?.textContent?.includes("Applies to new actions and retries."),
    "Frozen-intent scope of setting is unclear",
  );
  dispose();
  dispose = await mountAppFixture();
  select = await open();
  check(select.value === "900000", "Review reload lost timeout preference");
  check(
    document
      .querySelector("[popover]:popover-open")
      ?.textContent?.includes("Automatically apply AI review order"),
    "Shared settings removed review-specific preference",
  );
  await window.dismissBrowserPopover("escape");
  document.querySelector<HTMLButtonElement>('button[title="Enter focus mode (F)"]')!.click();
  await wait(
    () => !!document.querySelector('button[title="Exit focus mode (F or Esc)"]'),
    "Focus mode did not open",
  );
  select = await open();
  check(select.value === "900000", "Focus mode hid the saved timeout preference");
  dispose();
  await mountAppFixture({ defaultTab: "overview", waitForFiles: false });
  select = await open();
  check(select.value === "900000", "Overview lacks saved timeout setting");
  return { passed };
}

export async function testNewIntentAndExplicitRetryFreezeTheirOwnConfiguredDeadlineInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let n = 0; n < 180 && !predicate(); n++) await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const url = "https://github.com/browser-fixture/isolated/pull/1",
    scope = githubPrScope(url);
  const operations: GithubOutboxOperation[] = [];
  let retryDuration = 0,
    retryDeadline: string | undefined;
  setGithubSyncTimeoutMs(15 * 60_000);
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.enqueue": (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid fixture intent");
        const operation: GithubOutboxOperation = {
          command: input,
          status: "retry-failed",
          revision: 1,
          sequence: operations.length + 1,
          attempts: 1,
          retryMode: "manual",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          queueDeadlineAt: input.queueDeadlineAt,
          error: { code: "invalid", message: "Fixture rejected write", retryable: false },
        };
        operations.push(operation);
        return { outcome: "accepted", operation: structuredClone(operation) };
      },
      "githubOutbox.snapshot": () => ({
        scope,
        revision: operations.reduce((n, operation) => n + operation.revision, 0),
        operations: structuredClone(operations),
      }),
      "githubOutbox.control": (input) => {
        if (!isGithubOutboxControl(input) || input.kind !== "retry")
          throw new Error("Only explicit Retry expected");
        retryDuration = input.queueTimeoutMs ?? 0;
        retryDeadline = input.queueDeadlineAt;
        const operation = operations.find(
          (item) => item.command.operationId === input.operationId,
        )!;
        operation.revision++;
        operation.attempts++;
        operation.queueDeadlineAt = input.queueDeadlineAt;
        return { outcome: "applied", operation: structuredClone(operation) };
      },
    },
  });
  await refreshGithubActor();
  const before = Date.now();
  const first = await queueGithubWrite(url, {
    kind: "issue-comment",
    body: "Frozen original intent",
  });
  await githubWrites.recoverAll();
  check(
    !!first.command.queueDeadlineAt &&
      Date.parse(first.command.queueDeadlineAt) >= before + 900000 &&
      Date.parse(first.command.queueDeadlineAt) <= Date.now() + 900000,
    "New intent ignored persisted 15-minute setting",
  );
  const oldDeadline = first.command.queueDeadlineAt;
  document.querySelector<HTMLButtonElement>('button[aria-label="Review settings"]')!.click();
  await wait(
    () => !!document.querySelector('select[aria-label="GitHub sync timeout"]'),
    "Timeout setting unavailable on list",
  );
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="GitHub sync timeout"]',
  )!;
  select.value = "3600000";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  check(
    operations[0]?.command.queueDeadlineAt === oldDeadline &&
      operations[0]?.queueDeadlineAt === oldDeadline,
    "Preference change extended an existing cycle",
  );
  await window.dismissBrowserPopover("escape");
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () => !!document.querySelector(`[data-github-queue-action="${first.operationId}"] summary`),
    "Failed intent not visible",
  );
  document
    .querySelector<HTMLElement>(`[data-github-queue-action="${first.operationId}"] summary`)!
    .click();
  await wait(
    () => !!document.querySelector(`[data-operation-id="${first.operationId}"] button`),
    "Explicit retry not available",
  );
  const retryBefore = Date.now();
  await window.clickBrowserQueueActionButton(first.operationId, "Retry");
  await wait(() => retryDuration > 0, "Retry control did not reach backend");
  check(
    retryDuration === 3600000 &&
      !!retryDeadline &&
      Date.parse(retryDeadline) >= retryBefore + 3600000 &&
      Date.parse(retryDeadline) <= Date.now() + 3600000,
    "Explicit retry did not capture new 60-minute duration",
  );
  check(
    operations[0]?.command.queueDeadlineAt === oldDeadline,
    "Explicit retry changed original durable command identity",
  );
  const frozenRetry = operations[0]!.queueDeadlineAt;
  setGithubSyncTimeoutMs(300000);
  await githubWrites.recoverAll();
  check(
    operations[0]?.queueDeadlineAt === frozenRetry,
    "Later preference change extended or shortened the retry cycle",
  );
  const nextBefore = Date.now();
  const next = await queueGithubWrite(
    url,
    { kind: "issue-comment", body: "New five-minute intent" },
    undefined,
    [],
  );
  check(
    !!next.command.queueDeadlineAt &&
      Date.parse(next.command.queueDeadlineAt) >= nextBefore + 300000 &&
      Date.parse(next.command.queueDeadlineAt) <= Date.now() + 300000,
    "Next new intent failed to use latest preference",
  );
  return { passed };
}
