import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";

import { GithubPendingPanel } from "../components/GithubPendingPanel";
import { GithubQueueContext } from "../context/GithubQueueContext";
import type { BrowserGithubOperation, BrowserGithubState } from "../lib/github-outbox";
import { githubJournal, githubPrScope } from "../lib/github-writes";
import { createAssertions } from "./assertions";

declare global {
  interface Window {
    captureBrowserQueueLayout(name?: "stuck-before" | "stuck-after" | "consent-320"): Promise<void>;
  }
}

export async function testCompactGlobalQueueDraftSeparationAndRecoveryInBrowser() {
  const { check, wait, result } = createAssertions(3000);
  const states: BrowserGithubState[] = [];
  for (let n = 0; n < 12; n++) {
    const scope = githubPrScope(`https://github.com/fixture/repo/pull/${16333 - n}`);
    const command = {
      scope,
      operationId: crypto.randomUUID(),
      expectedActor: { id: 42, login: "fixture" },
      dependencies: [],
      action: {
        kind: "approve" as const,
        expectedHeadSha: "a".repeat(40),
        body: "Retained review text",
      },
    };
    const status = n === 0 ? ("uncertain" as const) : ("retry-failed" as const);
    const operation: BrowserGithubOperation = {
      command,
      status,
      backendOwned: true,
      operation: {
        command,
        status,
        sequence: n + 1,
        attempts: 1,
        retryMode: "manual",
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: {
          code: "permission",
          message: "Detailed retained failure explanation",
          retryable: false,
        },
      },
    };
    states.push({
      scope,
      operations: [operation],
      pendingCount: 1,
      pendingSaving: 0,
      busy: false,
      revision: 1,
    });
  }
  const rootAction = states[1]!.operations[0]!;
  rootAction.command.action = {
    kind: "edit-comment",
    body: "Updated body",
    expectedBody: "Old body",
    target: { source: "remote", kind: "issue-comment", id: 10 },
  };
  states[1]!.operations.push({
    command: {
      ...rootAction.command,
      operationId: crypto.randomUUID(),
      dependencies: [rootAction.command.operationId],
      action: {
        kind: "inline-comment",
        body: "Following inline comment",
        expectedHeadSha: "a".repeat(40),
        anchor: { path: "src/example.ts", line: 9, side: "RIGHT" },
      },
    },
    status: "queued",
    backendOwned: false,
    blockedByOperationId: rootAction.command.operationId,
  });
  states[1]!.pendingCount++;
  const draftScope = githubPrScope("https://github.com/fixture/drafts-only/pull/16250");
  await githubJournal.openEditor("queue-draft-fixture", draftScope, {
    body: "Unsubmitted text stays accessible",
  });
  states.push({
    scope: draftScope,
    operations: [],
    pendingCount: 0,
    pendingSaving: 0,
    busy: false,
    revision: 0,
  });
  const retiredScope = githubPrScope("https://github.com/fixture/retired/pull/16205");
  const retired = {
    ...states[0]!.operations[0]!,
    status: "cancelled" as const,
    command: {
      ...states[0]!.operations[0]!.command,
      scope: retiredScope,
      operationId: crypto.randomUUID(),
    },
  };
  states.push({
    scope: retiredScope,
    operations: [retired],
    pendingCount: 0,
    pendingSaving: 0,
    busy: false,
    revision: 0,
  });
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(
    () => (
      <Router>
        <Route
          path="*"
          component={() => (
            <GithubQueueContext.Provider
              value={{
                states: () => states,
                selectedScope: () => undefined,
                error: () => undefined,
                refresh: async () => {},
              }}
            >
              <GithubPendingPanel />
            </GithubQueueContext.Provider>
          )}
        />
      </Router>
    ),
    root,
  );
  try {
    check(!document.querySelector("[popover]:popover-open"), "Queue opened automatically");
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!;
    check(trigger.textContent?.trim() === "13", "Draft/history inflated pending count");
    trigger.click();
    await wait(
      () => !!document.querySelector("[popover]:popover-open [data-github-queue-scroll]"),
      "Queue did not open",
    );
    const panel = document.querySelector<HTMLElement>("[popover]:popover-open")!;
    check(panel.querySelectorAll("h2,h3").length === 1, "Queue has duplicate headings");
    check(
      !panel.textContent?.includes("drafts-only#16250") &&
        !panel.textContent?.includes("retired#16205"),
      "Draft/history-only PRs leaked into pending view",
    );
    check(
      !panel.textContent?.includes("Recover original") &&
        !panel.textContent?.includes("Detailed retained failure"),
      "Pending view expanded recovery or long errors by default",
    );
    check(
      panel.textContent?.includes("Delivery unknown"),
      "Unknown delivery mislabeled as failure",
    );
    check(panel.textContent?.includes("Blocked"), "Blocked follower missing from pending view");
    check(
      !panel.querySelector("[data-operation-id]"),
      "Action controls mounted before expanding row",
    );
    await window.captureBrowserQueueLayout();
    await new Promise(requestAnimationFrame);
    check(
      panel.getBoundingClientRect().width <= 320 &&
        panel.getBoundingClientRect().height <= innerHeight * 0.6 + 1,
      "Queue exceeds compact bounds at 390px",
    );
    const scroll = panel.querySelector<HTMLElement>("[data-github-queue-scroll]")!;
    check(
      getComputedStyle(scroll).overflowY === "auto" && scroll.scrollHeight > scroll.clientHeight,
      "Queue lacks bounded inner scrolling",
    );
    panel.querySelector<HTMLElement>("[data-github-queue-action] summary")!.click();
    await wait(
      () => !!panel.querySelector("[data-operation-id]"),
      "Expanded row hid action controls",
    );
    check(
      [...panel.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Check GitHub",
      ),
      "Unknown delivery lost read-only check",
    );
    check(
      ![...panel.querySelectorAll("[data-operation-id] button")].some(
        (button) => button.textContent?.trim() === "Retry",
      ),
      "Unknown-delivery row offered a direct resend",
    );
    panel.querySelectorAll<HTMLElement>("[data-github-queue-action] > summary")[1]!.click();
    await wait(
      () =>
        [
          ...panel.querySelectorAll(
            `[data-operation-id="${rootAction.command.operationId}"] button`,
          ),
        ].some((button) => button.textContent?.trim() === "Retry"),
      "Expanded failed row hid retry",
    );
    check(
      panel.textContent?.includes("Cancelling this action automatically unblocks"),
      "Blocker cancellation consequences missing",
    );
    [...panel.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Drafts & history")!
      .click();
    await wait(
      () => !!panel.textContent?.includes("drafts-only#16250"),
      "Saved draft-only PR not accessible in secondary view",
    );
    check(
      panel.textContent?.includes("retired#16205") && !panel.textContent?.includes("content (0)"),
      "Cancelled recovery lost or empty recovery rendered",
    );
    check(
      !panel.querySelector("[data-github-queue-action]"),
      "History view duplicated pending bodies",
    );
    return result();
  } finally {
    dispose();
    root.remove();
  }
}
