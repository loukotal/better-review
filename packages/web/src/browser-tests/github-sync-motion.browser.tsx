import type { GithubOutboxOperation } from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { mountAppFixture } from "./mount-app";

/** Real App, IndexedDB and computed CSS; all backend/GitHub traffic stays in fixtures. */
export async function testImmediateGithubSyncMotionInBrowser() {
  let passed = 0;
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const gate = () => {
    let release!: () => void;
    return {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
  };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const records: GithubOutboxOperation[] = [];
  let revision = 0;
  let admission = gate();
  let snapshotGate: ReturnType<typeof gate> | undefined;
  let snapshotStarted = false;
  const originalAdmit = githubJournal.admit;
  const originalSave = githubJournal.saveEditor;
  let journalGate = gate();
  let saveGate = gate();
  await window.setBrowserMotionPreference("no-preference");
  await mountAppFixture({
    extras: { comments: [], issueComments: [], status: null },
    procedures: {
      "githubOutbox.enqueue": async (input) => {
        await admission.promise;
        const operation: GithubOutboxOperation = {
          command: input as GithubOutboxOperation["command"],
          status: "queued",
          revision: 1,
          sequence: records.length + 1,
          attempts: 0,
          retryMode: "automatic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        records.push(operation);
        revision++;
        return { outcome: "accepted", operation };
      },
      "githubOutbox.snapshot": async () => {
        if (snapshotGate) {
          snapshotStarted = true;
          await snapshotGate.promise;
        }
        return { scope, revision, operations: structuredClone(records) };
      },
    },
  });
  // No periodic snapshot can make these assertions pass.
  githubWrites.activate();
  await refreshGithubActor();
  snapshotGate = gate();
  const heldSnapshot = githubWrites.snapshot(scope);
  await wait(() => snapshotStarted, "Snapshot gate was not held");
  const global = () =>
    document.querySelector('[aria-label="GitHub pending writes"] button [data-github-sync-status]');
  const spin = (root: Element | null | undefined, state: string, context: string) => {
    check(root?.getAttribute("data-github-sync-status") === state, `${context}: missing ${state}`);
    const icon = root!.querySelector("svg")!;
    const css = getComputedStyle(icon);
    check(
      css.animationName === "spin" &&
        css.animationDelay === "0s" &&
        css.animationTimingFunction === "linear" &&
        css.animationIterationCount === "infinite" &&
        css.transformOrigin === "6px 6px",
      `${context}: not immediate centered linear spin`,
    );
  };
  const submit = (form: HTMLFormElement) => form.requestSubmit();
  try {
    document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
    await wait(
      () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "+ Add comment",
        ),
      "Conversation not ready",
    );
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "+ Add comment")!
      .click();
    await wait(
      () =>
        !!document.querySelector('textarea[aria-label="New conversation comment"]:not(:disabled)'),
      "Composer not ready",
    );
    githubJournal.saveEditor = async (...args) => {
      await saveGate.promise;
      return originalSave(...args);
    };
    githubJournal.admit = async (...args) => {
      await journalGate.promise;
      return originalAdmit(...args);
    };
    const editor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New conversation comment"]',
    )!;
    editor.value = "immediate pending comment";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    submit(editor.form!);
    spin(
      editor.form!.querySelector("[data-github-sync-status]"),
      "saving-local",
      "composer before draft save",
    );
    spin(global(), "saving-local", "aggregate before draft save");
    check(
      !githubWrites.getState(scope).operations.length,
      "Pre-save UI fabricated durable operation",
    );
    saveGate.release();
    await new Promise(requestAnimationFrame);
    spin(global(), "saving-local", "aggregate before journal admission");
    check(!githubWrites.getState(scope).operations.length, "Held journal falsely acknowledged");
    journalGate.release();
    await wait(
      () =>
        !!document.querySelector(
          '[data-github-comment-key] [data-github-sync-status="local-pending"]',
        ),
      "Comment waited for backend admission",
    );
    const comment = () =>
      document.querySelector("[data-github-comment-key] [data-github-sync-status]");
    spin(comment(), "local-pending", "date before backend admission");
    spin(global(), "local-pending", "aggregate before backend admission");
    check(records.length === 0, "Held admission reached backend");
    admission.release();
    await wait(
      () => comment()?.getAttribute("data-github-sync-status") === "queued",
      "Receipt did not publish queued without polling",
    );
    spin(comment(), "queued", "queued comment");
    spin(global(), "queued", "queued aggregate");
    check(snapshotStarted, "Queued status depended on a completed snapshot");
    snapshotGate.release();
    await heldSnapshot;
    snapshotGate = undefined;

    // Approval uses the same pre-ack signal and animation as comments.
    admission = gate();
    journalGate = gate();
    saveGate = gate();
    document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
    await wait(
      () =>
        !!document.querySelector(
          'form[aria-label="Approve PR"] button[type="submit"]:not(:disabled)',
        ),
      "Approval form not ready",
    );
    const approvalForm = document.querySelector<HTMLFormElement>('form[aria-label="Approve PR"]')!;
    submit(approvalForm);
    const approval = () =>
      document.querySelector(
        'button[aria-label="Approve PR"], button[aria-label="Approval pending"]',
      );
    spin(
      approval()?.querySelector("[data-github-sync-status]"),
      "saving-local",
      "approval before journal",
    );
    spin(global(), "saving-local", "aggregate approval before journal");
    saveGate.release();
    journalGate.release();
    await wait(
      () =>
        approval()
          ?.querySelector("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "local-pending",
      "Approval waited for backend",
    );
    spin(approval()?.querySelector("[data-github-sync-status]"), "local-pending", "local approval");
    admission.release();
    await wait(
      () =>
        approval()
          ?.querySelector("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "queued",
      "Approval waited for next poll",
    );
    for (const state of [
      "queued",
      "inflight",
      "retry-pending",
      "retry-failed",
      "uncertain",
      "cancelled",
    ] as const) {
      for (const operation of records) {
        operation.status = state === "retry-pending" ? "retry-failed" : state;
        operation.retryMode = state === "retry-pending" ? "automatic" : "manual";
        operation.error =
          state === "retry-pending"
            ? { code: "network", message: "Offline", retryable: true }
            : undefined;
        operation.nextAttemptAt =
          state === "retry-pending" ? new Date(Date.now() + 60_000).toISOString() : undefined;
        operation.revision++;
        revision++;
      }
      await githubWrites.snapshot(scope);
      if (["queued", "inflight", "retry-pending"].includes(state)) {
        spin(comment(), state, `${state} comment`);
        spin(approval()?.querySelector("[data-github-sync-status]"), state, `${state} approval`);
        spin(global(), state, `${state} aggregate`);
      } else {
        check(
          !document.querySelector("[data-github-sync-status] .animate-spin"),
          `${state} falsely spins`,
        );
      }
    }
    // A terminal warning cannot suppress other pending work, nor disappear behind it.
    records[0]!.status = "uncertain";
    records[1]!.status = "queued";
    for (const operation of records) {
      operation.revision++;
      revision++;
    }
    await githubWrites.snapshot(scope);
    spin(global(), "queued", "mixed warning aggregate");
    check(
      !!global()?.querySelector("[data-github-sync-warning]") &&
        global()?.getAttribute("title")?.includes("uncertain"),
      "Mixed aggregate hid warning",
    );
    await window.setBrowserMotionPreference("reduce");
    await new Promise(requestAnimationFrame);
    check(
      getComputedStyle(global()!.querySelector("svg")!).animationName === "none",
      "Reduced motion ignored",
    );
    return { passed };
  } finally {
    admission.release();
    snapshotGate?.release();
    journalGate.release();
    saveGate.release();
    githubJournal.admit = originalAdmit;
    githubJournal.saveEditor = originalSave;
    githubWrites.activate();
    await window.setBrowserMotionPreference("reduce");
  }
}
