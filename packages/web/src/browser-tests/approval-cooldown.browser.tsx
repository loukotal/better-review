import type {
  GithubOutboxCommand,
  GithubOutboxReceipt,
  GithubOutboxSnapshot,
  PrStatus,
} from "@better-review/shared";

import { createIndexedDbGithubJournal } from "../lib/github-outbox-journal";
import { githubPrScope, githubWrites, refreshGithubActor } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";

/** Real App → IndexedDB → SQLite admission/worker → production adapter with local HTTP only. */
export async function testRenewedApprovalCooldownInBrowser() {
  const { check, wait, result } = createAssertions(4000);
  const url = "https://github.com/browser-fixture/isolated/pull/1",
    scope = githubPrScope(url),
    head = "a".repeat(40);
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const rpc = (kind: string) => (input: unknown) => window.browserGithubActions({ kind, input });
  const setClock = async (value: number) => {
    clock = value;
    await rpc("clock")(value);
  };
  await setClock(clock);
  const original: GithubOutboxCommand = {
    scope,
    operationId: crypto.randomUUID(),
    expectedActor: { id: 42, login: "browser-fixture" },
    dependencies: [],
    action: { kind: "approve", expectedHeadSha: head, body: "Reviewed again" },
  };
  const snapshot = async () => (await rpc("snapshot")(scope)) as GithubOutboxSnapshot;
  const sync = async (id: string) => {
    for (let i = 0; i < 240; i++) {
      const operation = (await snapshot()).operations.find(
        (item) => item.command.operationId === id,
      );
      if (operation?.status === "synced") return operation;
      await new Promise(requestAnimationFrame);
    }
    throw new Error("Approval did not sync through production adapter");
  };
  const posts = async () => {
    const state = (await rpc("state")(undefined)) as {
      calls: { method: string; path: string; payload?: { commit_id: string; body: string } }[];
    };
    return state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/reviews"));
  };
  await rpc("enqueue")(original);
  await rpc("heartbeat")({ scope, clientId: crypto.randomUUID(), visible: true });
  await sync(original.operationId);
  const firstSyncedAt = clock;
  await setClock(clock + 59_000);
  const remoteStatus = (approved: boolean): PrStatus => ({
    state: "open",
    draft: false,
    mergeable: true,
    title: "Review requested again",
    body: "",
    author: "other",
    url,
    headRef: "feature",
    checks: [],
    reviewDecision: "APPROVED",
    viewerApproval: approved ? { login: "browser-fixture", commitSha: head } : null,
  });
  let admissionCalls = 0;
  const procedures = {
    "githubOutbox.enqueue": (input: unknown) => {
      admissionCalls++;
      return rpc("enqueue")(input);
    },
    "githubOutbox.snapshot": rpc("snapshot"),
    "githubOutbox.heartbeat": rpc("heartbeat"),
    "githubOutbox.control": rpc("control"),
    "pr.extras": async () => ({
      comments: [],
      issueComments: [],
      status: remoteStatus((await posts()).length > 1),
    }),
    "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
  };
  const mount = () =>
    mountAppFixture({
      extras: { comments: [], issueComments: [], status: remoteStatus(false) },
      procedures,
    });
  let dispose = await mount();
  await refreshGithubActor();
  document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
  await wait(
    () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
    "Approval editor not ready",
  );
  const editor = document.querySelector<HTMLTextAreaElement>(
    'form[aria-label="Approve PR"] textarea',
  )!;
  editor.value = "Reviewed again";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  editor.form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await wait(
    () => githubWrites.getState(scope).operations.some((item) => !!item.admissionRetryAt),
    "No durable cooldown surfaced",
  );
  const pending = githubWrites.getState(scope).operations.find((item) => !!item.admissionRetryAt)!;
  const id = pending.command.operationId;
  check(
    id !== original.operationId && !pending.backendOwned && pending.status === "local-pending",
    "Renewed intent silently aliased to old approval",
  );
  check(
    pending.admissionRetryAt === new Date(firstSyncedAt + 60_000).toISOString(),
    "Cooldown deadline was not server first-synced time",
  );
  check(
    (await posts()).length === 1 && (await snapshot()).operations.length === 1,
    "Cooldown sent or admitted another approval",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="Approval pending"]')!.click();
  await wait(
    () => document.body.textContent!.includes("Can approve again in 1s"),
    "Cooldown countdown missing",
  );
  check(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Saved approval cooldown"] textarea')
      ?.value === "Reviewed again",
    "Saved approval text disappeared",
  );
  check(
    document.querySelector<HTMLButtonElement>('[aria-label="Saved approval cooldown"] button')
      ?.disabled,
    "Cooldown allowed early retry",
  );
  const journal = createIndexedDbGithubJournal();
  const durable = (await journal.entries(scope)).find((entry) => entry.command.operationId === id)!;
  check(
    durable.admissionRetryAt === pending.admissionRetryAt && !durable.backendOwned,
    "Cooldown not stored in IndexedDB",
  );
  check(
    !!durable.draftKey && (await journal.draft(durable.draftKey!))?.body === "Reviewed again",
    "Original linked draft not retained",
  );
  await journal.close();
  dispose();
  dispose = await mount();
  await refreshGithubActor();
  await wait(
    () => !!document.querySelector('button[aria-label="Approval pending"]:not(:disabled)'),
    "Cooldown did not survive App remount",
  );
  document.querySelector<HTMLButtonElement>('button[aria-label="Approval pending"]')!.click();
  await wait(
    () => document.body.textContent!.includes("Can approve again in 1s"),
    "Reload lost countdown",
  );
  await setClock(firstSyncedAt + 60_000);
  await wait(
    () => document.body.textContent!.includes("Can approve again now"),
    "Countdown did not expire",
  );
  await githubWrites.recover(scope);
  check(
    (await posts()).length === 1 && admissionCalls === 1,
    "Cooldown retried without explicit user intent",
  );
  const retry = document.querySelector<HTMLButtonElement>(
    '[aria-label="Saved approval cooldown"] button',
  )!;
  await wait(
    () => !retry.disabled && retry.isConnected,
    "Expired cooldown retry remains disabled or was replaced",
  );
  retry.click();
  retry.click();
  await sync(id);
  await githubWrites.snapshot(scope);
  await wait(
    () => !!document.querySelector('button[aria-label="You approved"]:disabled'),
    "Retried approval not confirmed in App",
  );
  const sent = await posts();
  check(sent.length === 2 && admissionCalls === 2, "Retry dispatched more than one new review");
  check(
    sent[1].payload?.commit_id === head && sent[1].payload?.body.includes(id),
    "Retry lost captured head or original new intent UUID",
  );
  check(
    ((await rpc("enqueue")(pending.command)) as GithubOutboxReceipt).outcome === "duplicate",
    "Same UUID replay not idempotent",
  );
  check((await posts()).length === 2, "Same UUID replay resent review");
  const changed = {
    ...pending.command,
    operationId: crypto.randomUUID(),
    action: { ...original.action, body: "Different review text" },
  };
  check(
    ((await rpc("enqueue")(changed)) as GithubOutboxReceipt).outcome === "accepted",
    "Changed approval text incorrectly cooled down",
  );
  dispose();
  Date.now = realNow;
  return result();
}
