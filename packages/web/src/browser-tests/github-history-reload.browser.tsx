import type { GithubOutboxCommand, GithubOutboxOperation } from "@better-review/shared";

import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope, githubWrites } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

export async function testPersistedDraftAndTerminalHistoryDiscoverOnDirectListReloadInBrowser() {
  const { check, wait, result } = createAssertions(4000);
  check(!githubWrites.getStates().length, "Reload fixture already has in-memory scopes");
  const draftScope = githubPrScope("https://github.com/fixture/draft-only/pull/11");
  const historyScope = githubPrScope("https://github.com/fixture/history-only/pull/12");
  const journal = createIndexedDbGithubJournal();
  await journal.openEditor("reload-unsubmitted", draftScope, { body: "Durable unsubmitted draft" });
  for (const status of ["synced", "cancelled"] as const) {
    const command: GithubOutboxCommand = {
      scope: historyScope,
      operationId: crypto.randomUUID(),
      dependencies: [],
      expectedActor: { id: 42, login: "browser-fixture" },
      action: { kind: "issue-comment", body: `Durable ${status} history` },
    };
    await journal.admit(command);
    const operation: GithubOutboxOperation = {
      command,
      status,
      revision: 1,
      sequence: status === "synced" ? 1 : 2,
      attempts: 1,
      retryMode: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await journal.acknowledge(operation);
  }
  await journal.close();
  check(!githubWrites.getStates().length, "Persisting records injected in-memory scopes");
  let snapshots = 0,
    heartbeats = 0,
    writes = 0,
    listRefreshes = 0;
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.snapshot": () => {
        snapshots++;
        throw new Error("Terminal history must load locally");
      },
      "githubOutbox.heartbeat": () => {
        heartbeats++;
        return { ok: true };
      },
      "githubOutbox.enqueue": () => {
        writes++;
        throw new Error("History must not submit");
      },
      "githubOutbox.control": () => {
        writes++;
        throw new Error("History must not control");
      },
      "prs.refresh": () => {
        listRefreshes++;
        return { prs: [], fetchedAt: Date.now() };
      },
    },
  });
  await githubWrites.recoverAll();
  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  await wait(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Drafts & history",
      ),
    "History toggle missing",
  );
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Drafts & history")!
    .click();
  await wait(
    () =>
      document.querySelector("[popover]:popover-open")?.textContent?.includes("draft-only#11") ??
      false,
    "Reload lost draft-only PR without visiting it",
  );
  const panel = document.querySelector("[popover]:popover-open")!;
  check(
    panel.textContent?.includes("history-only#12"),
    "Reload lost terminal-only history without visiting PR",
  );
  check(
    panel.textContent?.includes("Durable unsubmitted draft") &&
      panel.textContent?.includes("Durable synced history") &&
      panel.textContent?.includes("Durable cancelled history"),
    "Persisted bodies not recoverable",
  );
  check(
    !document.querySelector("[data-global-github-queue] > button [data-github-sync-status]"),
    "History/draft-only scopes counted as pending",
  );
  await githubWrites.recoverAll();
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(
    snapshots === 0 && heartbeats === 0 && writes === 0 && listRefreshes === 0,
    `Local history caused I/O/replay: snapshots=${snapshots}, heartbeat=${heartbeats}, writes=${writes}, listRefresh=${listRefreshes}`,
  );
  return result();
}
