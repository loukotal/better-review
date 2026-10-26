import { isGithubOutboxCommand, type GithubOutboxOperation } from "@better-review/shared";

import { beginGithubCommentRead, acceptGithubDetailRead } from "../lib/github-comment-views";
import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { fetchPrDetail, queryClient, queryKeys } from "../lib/query";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

export async function testCanonicalApprovalReceiptBridgesObservedIntentInBrowser() {
  return canonicalApproval(false, "changes");
}

export async function testReusedCanonicalApprovalRequiresNewAcknowledgementAuthorityInBrowser() {
  return canonicalApproval(true, "changes");
}

export async function testOverviewReusedCanonicalApprovalRequiresNewAcknowledgementAuthorityInBrowser() {
  return canonicalApproval(true, "overview");
}

async function canonicalApproval(reused: boolean, tab: "changes" | "overview") {
  const { check, wait, result } = createAssertions(3000);
  const scope = githubPrScope("https://github.com/browser-fixture/isolated/pull/1");
  const head = "a".repeat(40);
  const canonical: GithubOutboxOperation = {
    command: {
      scope,
      operationId: crypto.randomUUID(),
      expectedActor: { id: 42, login: "browser-fixture" },
      dependencies: [],
      action: { kind: "approve", expectedHeadSha: head, body: "" },
    },
    status: reused ? "queued" : "synced",
    revision: 3,
    sequence: 1,
    attempts: reused ? 0 : 1,
    retryMode: reused ? "automatic" : "blocked",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    result: reused ? undefined : { kind: "approval", id: 123, commitSha: head, url: scope.url },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submittedId = "",
    refreshed = false,
    admissions = 0;
  let holdDetailGet = false;
  let releasePreAckRead: (() => void) | undefined;
  const dispose = await mountAppFixture({
    defaultTab: tab,
    waitForFiles: tab === "changes",
    procedures: {
      "githubOutbox.snapshot": () => ({
        scope,
        revision: canonical.revision,
        operations: [structuredClone(canonical)],
      }),
      "githubOutbox.enqueue": async (input) => {
        if (!isGithubOutboxCommand(input)) throw new Error("Invalid command");
        admissions++;
        submittedId = input.operationId;
        await gate;
        return { outcome: "duplicate", operation: structuredClone(canonical) };
      },
      "pr.extras": () => {
        refreshed = true;
        return new Promise(() => {});
      },
      "prDetail.refresh": () => new Promise(() => {}),
      "prDetail.get": () =>
        holdDetailGet
          ? new Promise((resolve) => {
              releasePreAckRead = () => resolve(prDetailFixture(scope.url));
            })
          : prDetailFixture(scope.url),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
    },
  });
  await refreshGithubActor();
  if (reused) {
    await githubWrites.snapshot(scope);
    await wait(
      () => !!document.querySelector('button[aria-label="Approval pending"]:disabled'),
      "Canonical B was not observed pending",
    );
    canonical.status = "synced";
    canonical.revision++;
    canonical.attempts++;
    canonical.retryMode = "blocked";
    canonical.result = { kind: "approval", id: 123, commitSha: head, url: scope.url };
    await githubWrites.snapshot(scope);
    await wait(
      () => !!document.querySelector('button[aria-label="You approved"]:disabled'),
      "Original B completion was not bridged",
    );
    acceptGithubDetailRead(beginGithubCommentRead(scope.url), prDetailFixture(scope.url));
    await wait(
      () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
      "Original B bridge was not superseded",
    );
  }
  await githubWrites.snapshot(scope);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Historical first-seen synced row blocked new intent",
  );
  const beforeIntent = beginGithubCommentRead(scope.url);
  await wait(
    () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
    "Approval control not ready",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
  await wait(
    () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
    "Editor not ready",
  );
  document
    .querySelector<HTMLFormElement>('form[aria-label="Approve PR"]')!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await wait(
    () =>
      !!submittedId && !!document.querySelector('button[aria-label="Approval pending"]:disabled'),
    "Local intent not pending before receipt",
  );
  check(submittedId !== canonical.command.operationId, "Fixture did not retarget canonical ID");
  const duringPending = beginGithubCommentRead(scope.url);
  if (reused)
    check(
      duringPending.approvalBridges
        .get(canonical.command.operationId)
        ?.has(canonical.command.operationId) &&
        !duringPending.approvalBridges.get(canonical.command.operationId)?.has(submittedId),
      "Pending A was counted as acknowledged before durable canonical receipt",
    );
  let pendingRead: Promise<unknown> | undefined;
  if (reused) {
    holdDetailGet = true;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.pr.detail(scope.url),
      exact: true,
      refetchType: "none",
    });
    pendingRead = fetchPrDetail(scope.url);
    await wait(() => !!releasePreAckRead, "Actual detail fetch did not start while A was pending");
  }
  let reoffered = false;
  const observer = new MutationObserver(() => {
    reoffered ||= !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)');
  });
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  release();
  await wait(
    () => !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Canonical duplicate receipt lost observed pending intent",
  );
  await wait(() => refreshed, "Canonical acknowledgement did not schedule authoritative refresh");
  observer.disconnect();
  check(!reoffered && admissions === 1, "Canonical collapse reoffered approval or resent write");
  const entry = (await githubJournal.entries(scope)).find(
    (item) => item.command.operationId === submittedId,
  );
  check(
    entry?.backendOwned && entry.operation?.command.operationId === canonical.command.operationId,
    "Actual IndexedDB acknowledgement did not preserve alias provenance",
  );
  acceptGithubDetailRead(beforeIntent, prDetailFixture(scope.url));
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Read predating canonical acknowledgement retired new intent",
  );
  acceptGithubDetailRead(duringPending, prDetailFixture(scope.url));
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Read started while A pending retired its newly acknowledged bridge",
  );
  if (reused) {
    releasePreAckRead!();
    await pendingRead;
    check(
      !!document.querySelector('button[aria-label="You approved"]:disabled'),
      "Actual pre-ack fetch response retired the new acknowledged intent generation",
    );
  }
  canonical.revision++;
  await githubWrites.snapshot(scope);
  check(
    !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Metadata-only revision lost new acknowledgement bridge",
  );
  const afterAcknowledgement = beginGithubCommentRead(scope.url);
  check(
    afterAcknowledgement.approvalBridges.get(canonical.command.operationId)?.has(submittedId),
    "Read token did not capture newly acknowledged alias A",
  );
  acceptGithubDetailRead(afterAcknowledgement, prDetailFixture(scope.url));
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Fresh canonical detail-only absence did not settle receipt",
  );
  canonical.revision++;
  for (let i = 0; i < 3; i++) await githubWrites.snapshot(scope);
  check(
    !document.querySelector('button[aria-label="You approved"]'),
    "Polling or metadata changes rearmed settled acknowledgement",
  );
  dispose();
  return result();
}
