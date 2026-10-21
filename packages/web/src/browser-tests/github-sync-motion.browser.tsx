import type { GithubOutboxOperation, GithubPrScope } from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  queueGithubWrite,
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
      "githubOutbox.snapshot": async (input) => {
        if (snapshotGate) {
          snapshotStarted = true;
          await snapshotGate.promise;
        }
        const requested = input as GithubPrScope;
        return {
          scope: requested,
          revision,
          operations: structuredClone(
            records.filter((item) => item.command.scope.url === requested.url),
          ),
        };
      },
    },
  });
  // No periodic snapshot can make these assertions pass.
  githubWrites.activate();
  await refreshGithubActor();
  // Drain a mount-time snapshot before installing the held-request gate. Otherwise
  // snapshot() can legitimately join that request rather than enter the new gate.
  await githubWrites.snapshot(scope);
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
    const follower = githubWrites
      .getState(scope)
      .operations.find((item) => item.command.operationId === records[1]!.command.operationId)!;
    check(
      !!follower.blockedByOperationId,
      "Uncertain predecessor did not block dependent approval",
    );
    check(!global()?.querySelector(".animate-spin"), "Blocked-only aggregate falsely spins");
    // Add genuinely independent runnable work. A blocked follower cannot stand in for it.
    const independent = githubPrScope(scope.url.replace("/1", "/2"));
    await queueGithubWrite(
      independent.url,
      { kind: "issue-comment", body: "independent runnable action" },
      undefined,
      [],
    );
    await githubWrites.recover(independent);
    spin(global(), "queued", "mixed warning aggregate");
    check(
      !!global()?.querySelector("[data-github-sync-warning]") &&
        global()?.getAttribute("title")?.includes("uncertain"),
      "Mixed aggregate hid warning",
    );
    await window.setBrowserMotionPreference("reduce");
    await new Promise(requestAnimationFrame);
    spin(global(), "queued", "mixed warning aggregate with reduced motion");
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

/** Exercise the real Pierre annotation, not a discussion copy or standalone status. */
export async function testPierreInlineGithubSyncRotationInBrowser() {
  let passed = 0;
  const evidence: Record<string, unknown>[] = [];
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
    passed++;
  };
  const wait = async (predicate: () => boolean, message: string) => {
    for (let frame = 0; frame < 180 && !predicate(); frame++)
      await new Promise(requestAnimationFrame);
    check(predicate(), message);
  };
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const records: GithubOutboxOperation[] = [];
  let revision = 0;
  let release!: () => void;
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseDeletion!: () => void;
  const deletionAdmission = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  await window.setBrowserMotionPreference("no-preference");
  await mountAppFixture({
    extras: { comments: [], issueComments: [], status: null },
    procedures: {
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
      "githubOutbox.enqueue": async (input) => {
        await admission;
        if ((input as GithubOutboxOperation["command"]).action.kind === "delete-comment")
          await deletionAdmission;
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
      "githubOutbox.snapshot": () => ({ scope, revision, operations: structuredClone(records) }),
    },
  });
  githubWrites.activate();
  await refreshGithubActor();
  const deepAll = (root: Document | ShadowRoot, selector: string): Element[] => [
    ...root.querySelectorAll(selector),
    ...[...root.querySelectorAll("*")].flatMap((element) =>
      element.shadowRoot ? deepAll(element.shadowRoot, selector) : [],
    ),
  ];
  const inline = () =>
    deepAll(document, "diffs-container").flatMap((container) => [
      ...container.querySelectorAll("[data-github-comment-key]"),
      ...(container.shadowRoot?.querySelectorAll("[data-github-comment-key]") ?? []),
    ])[0];
  const icon = (root: Element | undefined | null) =>
    root?.querySelector<SVGSVGElement>("[data-github-sync-status] svg");
  const globalIcon = () =>
    document.querySelector<SVGSVGElement>(
      '[aria-label="GitHub pending writes"] button [data-github-sync-status] svg',
    );
  const approvalIcon = () =>
    document.querySelector<SVGSVGElement>(
      'button[aria-label="Approval pending"] [data-github-sync-status] svg',
    );
  const rotates = async (svg: SVGSVGElement | undefined | null, context: string) => {
    check(!!svg && svg.getBoundingClientRect().width > 0, `${context}: icon not rendered`);
    await new Promise(requestAnimationFrame);
    const css = getComputedStyle(svg!);
    const animations = svg!.getAnimations();
    const animation = animations[0];
    const before = css.transform;
    const time = animation?.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 240));
    await new Promise(requestAnimationFrame);
    const sample = {
      context,
      root: svg!.getRootNode() instanceof ShadowRoot ? "shadow" : "document",
      assignedSlot: svg!.closest("[slot]")?.getAttribute("slot"),
      animationName: css.animationName,
      animations: animations.length,
      before,
      after: getComputedStyle(svg!).transform,
      time,
      afterTime: animation?.currentTime,
      playState: animation?.playState,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    evidence.push(sample);
    const diagnostic = JSON.stringify(sample);
    check(
      animation?.playState === "running" &&
        typeof time === "number" &&
        Number(animation.currentTime) - time >= 200 &&
        before !== getComputedStyle(svg!).transform,
      `${context}: no visible rotation: ${diagnostic}`,
    );
    return { svg: svg!, animation: animation! };
  };
  try {
    await queueGithubWrite(scope.url, {
      kind: "inline-comment",
      body: "test",
      expectedHeadSha: "a".repeat(40),
      anchor: { path: "src/example.ts", side: "RIGHT", line: 9 },
    });
    await wait(() => !!inline(), "Pierre inline local comment did not render");
    check(
      inline()!.querySelector("[data-comment-date]")?.textContent === "Local",
      "Did not reproduce Local header",
    );
    check(
      inline()!.getRootNode() === document && !!inline()!.closest('[slot^="annotation-"]'),
      "Expected the real Pierre slotted light-DOM annotation",
    );
    await rotates(globalIcon(), "global/local-pending control");
    await rotates(icon(inline()), "Pierre inline/local-pending");
    await window.setBrowserMotionPreference("reduce");
    await rotates(icon(inline()), "Pierre inline/local-pending reduced motion");
    await rotates(globalIcon(), "aggregate/local-pending reduced motion");
    await window.setBrowserMotionPreference("no-preference");
    release();
    await wait(
      () =>
        icon(inline())
          ?.closest("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "queued",
      "Queued inline did not render",
    );
    await queueGithubWrite(scope.url, {
      kind: "approve",
      body: "",
      expectedHeadSha: "a".repeat(40),
    });
    await wait(() => !!approvalIcon(), "Approval control missing");
    const approvalMotion = await rotates(approvalIcon(), "approval/queued control");
    const aggregateMotion = await rotates(globalIcon(), "aggregate/queued control");
    const queued = await rotates(icon(inline()), "Pierre inline/queued");
    for (let i = 0; i < 3; i++) await githubWrites.snapshot(scope);
    await new Promise(requestAnimationFrame);
    check(
      icon(inline()) === queued.svg && queued.svg.getAnimations()[0] === queued.animation,
      "Unchanged snapshots restart inline animation",
    );
    check(
      approvalIcon() === approvalMotion.svg &&
        approvalMotion.svg.getAnimations()[0] === approvalMotion.animation,
      "Unchanged snapshots restart approval animation",
    );
    check(
      globalIcon() === aggregateMotion.svg &&
        aggregateMotion.svg.getAnimations()[0] === aggregateMotion.animation,
      "Unchanged snapshots restart aggregate animation",
    );
    records[0]!.status = "inflight";
    records[0]!.revision++;
    revision++;
    await githubWrites.snapshot(scope);
    const sending = await rotates(icon(inline()), "Pierre inline/inflight");
    check(
      sending.svg === queued.svg && sending.animation === queued.animation,
      "Queued → inflight restarted rotation",
    );
    await rotates(globalIcon(), "aggregate/inflight control");
    check(
      globalIcon() === aggregateMotion.svg &&
        aggregateMotion.svg.getAnimations()[0] === aggregateMotion.animation,
      "Queued → inflight restarted aggregate rotation",
    );
    records[0]!.status = "retry-failed";
    records[0]!.error = { code: "network", message: "Offline", retryable: true };
    records[0]!.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    records[0]!.revision++;
    revision++;
    await githubWrites.snapshot(scope);
    check(
      icon(inline())
        ?.closest("[data-github-sync-status]")
        ?.getAttribute("data-github-sync-status") === "retry-pending",
      "Inline auto retry lost pending mapping",
    );
    const retry = await rotates(icon(inline()), "Pierre inline/automatic-retry");
    check(retry.animation === queued.animation, "Automatic retry restarted inline rotation");

    // Confirm the creation, then delete the real inline card. Its tombstone must
    // reflect the delete operation, not the now-synced creation.
    records[0]!.status = "synced";
    delete records[0]!.error;
    delete records[0]!.nextAttemptAt;
    records[0]!.result = {
      kind: "review-comment",
      id: 20,
      body: "test",
      url: `${scope.url}#discussion_r20`,
      author: { id: 42, login: "browser-fixture" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      location: {
        path: "src/example.ts",
        line: 9,
        originalLine: 9,
        side: "RIGHT",
        commitSha: "a".repeat(40),
      },
      threadId: "actual-thread",
    };
    records[0]!.revision++;
    revision++;
    await githubWrites.snapshot(scope);
    document.querySelector<HTMLButtonElement>('[aria-controls="pr-conversation"]')!.click();
    await queueGithubWrite(scope.url, { kind: "issue-comment", body: "test" });
    await wait(
      () => records.some((item) => item.command.action.kind === "issue-comment"),
      "Discussion creation was not admitted",
    );
    const issue = records.find((item) => item.command.action.kind === "issue-comment")!;
    issue.status = "synced";
    issue.result = {
      kind: "issue-comment",
      id: 30,
      body: "test",
      url: `${scope.url}#issuecomment-30`,
      author: { id: 42, login: "browser-fixture" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    issue.revision++;
    revision++;
    await githubWrites.snapshot(scope);
    const discussion = () =>
      [...document.querySelectorAll("[data-github-comment-key]")].find(
        (card) => !card.closest("diffs-container"),
      );
    await wait(() => !!discussion(), "Discussion copy did not render");
    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      [...inline()!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Delete")!
        .click();
      [...discussion()!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Delete")!
        .click();
    } finally {
      window.confirm = confirm;
    }
    await wait(
      () =>
        inline()?.getAttribute("data-comment-deleted") === "true" &&
        discussion()?.getAttribute("data-comment-deleted") === "true",
      "Deletion tombstones did not render",
    );
    for (const [context, card] of [
      ["inline", inline()],
      ["discussion", discussion()],
    ] as const) {
      check(
        card!.querySelectorAll("[data-comment-header] [data-github-sync-status]").length === 1 &&
          card!.querySelectorAll("[data-comment-header] button[popovertarget]").length === 1,
        `${context} tombstone must retain one header details control`,
      );
      const pending = card!.querySelector('[role="img"][aria-label="Deletion pending"]');
      check(
        pending?.querySelectorAll("svg").length === 3 &&
          pending.querySelectorAll('[aria-hidden="true"] [data-github-sync-status]').length === 3 &&
          !pending.querySelector("button, [tabindex], a") &&
          !card!.textContent?.includes("Deletion pending"),
        `${context} tombstone must show three decorative body icons without visible pending text`,
      );
      for (const svg of pending!.querySelectorAll<SVGSVGElement>("svg"))
        await rotates(svg, `${context}/delete-body-local-pending`);
      check(
        card!.querySelector("pre")?.textContent === "test",
        `${context} tombstone lost recoverable body`,
      );
      check(
        icon(card)
          ?.closest("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "local-pending",
        `${context} tombstone used synced creation status`,
      );
      await rotates(icon(card), `${context}/delete-local-pending`);
    }
    await rotates(globalIcon(), "aggregate/delete-local-pending");
    releaseDeletion();
    await wait(
      () =>
        records.filter((item) => item.command.action.kind === "delete-comment").length === 2 &&
        icon(inline())
          ?.closest("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "queued" &&
        icon(discussion())
          ?.closest("[data-github-sync-status]")
          ?.getAttribute("data-github-sync-status") === "queued",
      "Delete admission did not publish queued",
    );
    await rotates(icon(inline()), "Pierre inline/delete-queued");
    await rotates(icon(discussion()), "discussion/delete-queued");
    await rotates(globalIcon(), "aggregate/delete-queued");
    await window.setBrowserMotionPreference("reduce");
    await new Promise(requestAnimationFrame);
    await rotates(icon(inline()), "Pierre inline/delete-queued reduced motion");
    await rotates(icon(discussion()), "discussion/delete-queued reduced motion");
    await rotates(globalIcon(), "aggregate/delete-queued reduced motion");
    await rotates(approvalIcon(), "approval/queued reduced motion");
    for (const [context, card] of [
      ["inline", inline()],
      ["discussion", discussion()],
    ] as const)
      for (const svg of card!.querySelectorAll<SVGSVGElement>(
        '[aria-label="Deletion pending"] svg',
      ))
        await rotates(svg, `${context}/delete-body-queued reduced motion`);
    // Cancelling a queued deletion restores the original body on both surfaces.
    for (const deletion of records.filter(
      (item) => item.command.action.kind === "delete-comment",
    )) {
      deletion.status = "cancelled";
      deletion.revision++;
      revision++;
    }
    await githubWrites.snapshot(scope);
    await wait(
      () =>
        inline()?.getAttribute("data-comment-deleted") !== "true" &&
        discussion()?.getAttribute("data-comment-deleted") !== "true",
      "Cancelled delete retained tombstone",
    );
    check(
      inline()?.querySelector("[data-comment-body]")?.textContent?.trim() === "test" &&
        discussion()?.querySelector("[data-comment-body]")?.textContent?.trim() === "test",
      "Cancelled delete lost body",
    );
    records[1]!.status = "synced";
    records[1]!.result = { kind: "approval", id: 31, url: scope.url, commitSha: "a".repeat(40) };
    records[1]!.revision++;
    revision++;
    await githubWrites.snapshot(scope);
    for (const preference of ["reduce", "no-preference"] as const) {
      await window.setBrowserMotionPreference(preference);
      await new Promise(requestAnimationFrame);
      const historyIcon = document.querySelector<SVGSVGElement>(
        '[aria-label="GitHub pending writes"] button svg',
      )!;
      check(
        historyIcon.getAnimations().length === 0 && !globalIcon(),
        `${preference}: history-only aggregate falsely spins`,
      );
    }
    return { passed, evidence };
  } finally {
    release();
    releaseDeletion();
    githubWrites.activate();
    await window.setBrowserMotionPreference("reduce");
  }
}
