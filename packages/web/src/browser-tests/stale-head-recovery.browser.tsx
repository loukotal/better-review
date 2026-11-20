import type { GithubOutboxOperation, GithubOutboxSnapshot } from "@better-review/shared";

import { queueGithubWrite, refreshGithubActor } from "../lib/github-writes";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

const url = "https://github.com/browser-fixture/isolated/pull/1";
const reviewed = "a".repeat(40);
const pushed = "c".repeat(40);
type FixtureCall = { path: string; method: string; payload?: Record<string, unknown> };

/** GitHub queue modal → IndexedDB → RPC → SQLite worker → production HTTP adapter. */
export async function testGithubQueueModalRecoversWritesAfterHeadChangeInBrowser() {
  const { check, wait, result } = createAssertions(8000);
  const rpc = (kind: string) => (input: unknown) => window.browserGithubActions({ kind, input });
  await mountAppFixture({
    initialPath: "/",
    waitForFiles: false,
    procedures: {
      "githubOutbox.enqueue": rpc("enqueue"),
      "githubOutbox.snapshot": rpc("snapshot"),
      "githubOutbox.heartbeat": rpc("heartbeat"),
      "githubOutbox.control": rpc("control"),
      "githubOutbox.pending": rpc("pending"),
      "prDetail.refresh": () => prDetailFixture(url, pushed),
      "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
      "prs.refresh": () => ({ prs: [], fetchedAt: Date.now() }),
    },
  });
  await refreshGithubActor();
  const fixture = (kind: string, input?: unknown) =>
    window.browserGithubActions({ kind, input }) as Promise<never>;
  const operations = async () => ((await fixture("snapshot")) as GithubOutboxSnapshot).operations;
  const operation = async (kind: string, nth = 0) =>
    (await operations()).filter((op) => op.command.action.kind === kind)[nth];
  const settle = async (
    label: string,
    pick: () => Promise<GithubOutboxOperation | undefined>,
    done: (op: GithubOutboxOperation) => boolean,
  ) => {
    for (let frame = 0; frame < 300; frame++) {
      const op = await pick();
      if (op && done(op)) return op;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${label} did not settle: ${JSON.stringify(await pick())}`);
  };
  const parked = (op: GithubOutboxOperation) =>
    op.status === "retry-failed" && op.error?.code === "head-changed";
  const posts = async (suffix: string) =>
    ((await fixture("state")) as { calls: FixtureCall[] }).calls.filter(
      (call) => call.method === "POST" && call.path.endsWith(suffix),
    );

  // A rebase drops the reviewed commit, so both writes are parked.
  await fixture("push", { sha: pushed, rebase: true });
  await queueGithubWrite(url, {
    kind: "inline-comment",
    expectedHeadSha: reviewed,
    body: "Saved inline comment",
    anchor: { path: "src/example.ts", side: "RIGHT", line: 9 },
  });
  await queueGithubWrite(url, { kind: "approve", expectedHeadSha: reviewed, body: "LGTM" });
  const staleInline = await settle("Inline comment", () => operation("inline-comment"), parked);
  const staleApproval = await settle("Approval", () => operation("approve"), parked);

  document.querySelector<HTMLButtonElement>('button[aria-label="GitHub queue"]')!.click();
  const row = (id: string) =>
    document.querySelector<HTMLDetailsElement>(`[data-github-queue-action="${id}"]`);
  const button = (id: string, label: string) =>
    [...(row(id)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) =>
      item.textContent?.trim().startsWith(label),
    );
  const open = async (id: string, label: string) => {
    await wait(() => !!row(id), `${label} missing from the GitHub queue modal`);
    row(id)!.open = true;
  };
  await open(staleInline.command.operationId, "Inline comment");
  await wait(
    () => !!row(staleInline.command.operationId)!.textContent!.includes("post on reviewed commit"),
    `Modal does not offer posting on the reviewed commit: ${row(staleInline.command.operationId)?.textContent}`,
  );
  await open(staleApproval.command.operationId, "Approval");
  await wait(
    () => !!row(staleApproval.command.operationId)!.textContent!.includes("review new commits"),
    `Modal does not tell the reviewer the PR changed: ${row(staleApproval.command.operationId)?.textContent}`,
  );

  // Still rebased: posting on the reviewed commit is refused again, not re-anchored.
  await wait(
    () => !!button(staleInline.command.operationId, "Post on reviewed commit"),
    `Post on reviewed commit missing: ${row(staleInline.command.operationId)?.textContent}`,
  );
  button(staleInline.command.operationId, "Post on reviewed commit")!.click();
  await settle(
    "Retry after rebase",
    () => operation("inline-comment"),
    (op) => parked(op) && op.attempts === 2,
  );
  check((await posts("/pulls/1/comments")).length === 0, "Comment posted after a rebase");

  // Items parked by the previous release while the reviewed commit was still an ancestor.
  await fixture("push", { sha: pushed, history: [reviewed, pushed] });
  await wait(
    () => !!button(staleInline.command.operationId, "Post on reviewed commit"),
    "Post on reviewed commit not offered again",
  );
  button(staleInline.command.operationId, "Post on reviewed commit")!.click();
  await settle(
    "Recovered inline comment",
    () => operation("inline-comment"),
    (op) => op.status === "synced",
  );
  const [comment] = await posts("/pulls/1/comments");
  check(
    comment?.payload?.commit_id === reviewed && comment.payload.line === 9,
    "Inline comment was not posted on its reviewed commit and line",
  );

  button(staleApproval.command.operationId, "Approve latest")!.click();
  await wait(
    () => !!button(staleApproval.command.operationId, "Approve ccccccc"),
    "Approval prompt did not load the latest head",
  );
  const prompt = row(staleApproval.command.operationId)!.querySelector(
    '[aria-label="PR changed since your review"]',
  )!;
  check(
    prompt.querySelector("a")?.getAttribute("href") === `${url}/files/${reviewed}..${pushed}`,
    "Prompt does not link to the changes since review",
  );
  check((await posts("/pulls/1/reviews")).length === 0, "Approved before confirmation");
  button(staleApproval.command.operationId, "Approve ccccccc")!.click();
  await settle(
    "Latest approval",
    () => operation("approve", 1),
    (op) => op.status === "synced",
  );
  await settle(
    "Stale approval",
    async () =>
      (await operations()).find(
        (op) => op.command.operationId === staleApproval.command.operationId,
      ),
    (op) => op.status === "cancelled",
  );
  const reviews = await posts("/pulls/1/reviews");
  check(
    reviews.length === 1 &&
      reviews[0]!.payload?.commit_id === pushed &&
      String(reviews[0]!.payload?.body).startsWith("LGTM") &&
      reviews[0]!.payload?.event === "APPROVE",
    "Approval was not posted once on the latest head with the saved comment",
  );
  return result();
}
