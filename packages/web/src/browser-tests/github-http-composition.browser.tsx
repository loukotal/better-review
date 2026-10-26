import superjson from "superjson";

import {
  isGithubOutboxCommand,
  type GithubOutboxCommand,
  type GithubOutboxOperation,
  type GithubOutboxReceipt,
  type SearchedPr,
} from "@better-review/shared";

import {
  githubJournal,
  githubPrScope,
  githubWrites,
  refreshGithubActor,
} from "../lib/github-writes";
import { trpc } from "../lib/trpc";
import { createAssertions } from "./assertions";
import { mountAppFixture } from "./mount-app";
import { prDetailFixture } from "./pr-detail-fixture";

interface Evidence {
  pid: number;
  operations: GithubOutboxOperation[];
  calls: {
    path: string;
    method: string;
    payload?: { event?: string; body?: string; commit_id?: string };
  }[];
  httpCalls: { path: string; method: string; authorized: boolean; body?: string }[];
  httpReceipts: { status: number; body: string }[];
  faults: string[];
  approval?: { id: number; user: { id: number; login: string }; commit_id: string; state: string };
}
interface Cleanup {
  processExited: boolean;
  storageRemoved: boolean;
  serverClosed: boolean;
  runtimeStopped: boolean;
  faults: string[];
  httpProcedures: Record<string, number>;
}
declare global {
  interface Window {
    browserGithubHttp(request: { kind: "start" }): Promise<{ token: string; pid: number }>;
    browserGithubHttp(request: { kind: "inspect" }): Promise<Evidence>;
    browserGithubHttp(request: {
      kind:
        | "hold-approval"
        | "release-approval"
        | "lose-applied-approval-response"
        | "hold-review-read"
        | "release-review-read";
    }): Promise<void>;
    browserGithubHttp(request: { kind: "close" }): Promise<Cleanup>;
  }
}

const url = "https://github.com/browser-fixture/isolated/pull/1";
const head = "a".repeat(40);
const body = "Stage 9B: captured approval from the actual App editor.";
const storageKey = "stage9b-http-composition";
const title = "Real HTTP durable approval";
const badge = () =>
  document.querySelector('span[title="GitHub\'s current overall review decision is Approved."]');

/** Editor → real IndexedDB → HTTP/SuperJSON/production router → SQLite/worker/adapter.
 * Only GitHub itself and unrelated App reads are fixtures. Runner reloads the real page.
 */
export async function testAppDurableGithubHttpCompositionInBrowser(
  phase: "before" | "resume" | "after" = "before",
) {
  const { check, wait, result } = createAssertions(8000);
  const backend = await window.browserGithubHttp({ kind: "start" });
  localStorage.setItem("better-review.apiToken", backend.token);
  const scope = githubPrScope(url);
  const inspect = () => window.browserGithubHttp({ kind: "inspect" });
  const posts = (evidence: Evidence) => evidence.calls.filter((call) => call.method === "POST");
  const admissions = (evidence: Evidence) =>
    evidence.httpCalls.filter((call) => call.path === "/api/trpc/githubOutbox.enqueue");
  const readUntil = async (predicate: (evidence: Evidence) => boolean, message: string) => {
    const deadline = performance.now() + 8000;
    for (;;) {
      const evidence = await inspect();
      if (predicate(evidence)) {
        check(true, message);
        return evidence;
      }
      if (performance.now() >= deadline) {
        check(false, `${message}: ${JSON.stringify(evidence)}`);
      }
      await new Promise(requestAnimationFrame);
    }
  };
  let listReads = 0;
  let listRefreshes = 0;
  let approvedReads = 0;
  let resumedReads: { listReads: number; listRefreshes: number; approvedReads: number } | undefined;
  const list = async () => {
    listReads++;
    const remote = await inspect();
    const approved = remote.approval?.state === "APPROVED" && remote.approval.commit_id === head;
    if (approved) approvedReads++;
    return {
      fetchedAt: Date.now(),
      prs: [
        {
          url,
          headRefOid: head,
          number: 1,
          title,
          repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
          author: { login: "another-user" },
          createdAt: "2026-01-01T00:00:00Z",
          isDraft: false,
          isAuthor: false,
          reviewRequested: true,
          myReviewState: approved ? "APPROVED" : null,
          reviewDecision: approved ? "APPROVED" : "REVIEW_REQUIRED",
          additions: 1,
          deletions: 1,
          ciStatus: null,
        } satisfies SearchedPr,
      ],
    };
  };
  const detail = async () => {
    const remote = await inspect();
    const value = prDetailFixture(url, head);
    if (remote.approval && value.reviews.status === "available")
      value.reviews.data = [
        {
          id: String(remote.approval.id),
          author: remote.approval.user.login,
          state: "APPROVED",
          body,
          commitSha: remote.approval.commit_id,
          submittedAt: "2026-01-01T00:00:00Z",
          url: `${url}#pullrequestreview-fixture`,
        },
      ];
    return value;
  };
  let dispose: (() => void) | undefined;
  let finalEvidence: Evidence | undefined;
  let cleanup: Cleanup | undefined;
  try {
    if (phase === "before") {
      await window.browserGithubHttp({ kind: "hold-approval" });
      await window.browserGithubHttp({ kind: "hold-review-read" });
      await window.browserGithubHttp({ kind: "lose-applied-approval-response" });
    }
    dispose = await mountAppFixture({
      githubOutboxHttp: true,
      ...(phase !== "before" ? { initialPath: "/?needsReview=0", waitForFiles: false } : {}),
      procedures: {
        "prs.list": list,
        "prs.refresh": () => {
          listRefreshes++;
          return list();
        },
        "prs.ciStatusBatch": () => ({ statuses: {} }),
        "prReview.automaticStatuses": () => ({}),
        "pr.extras": () => ({ comments: [], issueComments: [], status: null }),
        "prDetail.get": detail,
        "prDetail.refresh": detail,
      },
    });
    await refreshGithubActor();
    if (phase === "before") {
      await wait(
        () => !!document.querySelector('button[aria-label="Approve PR"]:not(:disabled)'),
        "Actual App approval control did not become ready",
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Approve PR"]')!.click();
      await wait(
        () => !!document.querySelector('form[aria-label="Approve PR"] textarea:not(:disabled)'),
        "Actual approval editor did not mount",
      );
      const form = document.querySelector<HTMLFormElement>('form[aria-label="Approve PR"]')!;
      const editor = form.querySelector<HTMLTextAreaElement>("textarea")!;
      editor.value = body;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      const held = await readUntil(
        (evidence) =>
          evidence.operations.length === 1 &&
          evidence.operations[0].status === "inflight" &&
          evidence.httpReceipts.length === 1 &&
          posts(evidence).length === 1,
        "Editor submission never reached the held real worker mutation",
      );
      const operation = held.operations[0];
      const command = operation.command;
      const receipt = superjson.deserialize<GithubOutboxReceipt>(
        JSON.parse(held.httpReceipts[0].body).result.data,
      );
      check(
        held.httpReceipts[0].status === 200 &&
          receipt.outcome === "accepted" &&
          isGithubOutboxCommand(receipt.operation.command) &&
          JSON.stringify(receipt.operation.command) === JSON.stringify(command),
        "Actual HTTP/SuperJSON enqueue response must carry the accepted durable operation, not a reconstructed fixture receipt",
      );
      check(
        command.action.kind === "approve" &&
          command.action.body === body &&
          command.action.expectedHeadSha === head,
        "SQLite admission lost captured editor body/head",
      );
      check(
        command.expectedActor.id === 42 &&
          command.expectedActor.login === "browser-fixture" &&
          command.scope.url === url,
        "SQLite admission lost captured actor/scope",
      );
      check(
        operation.attempts === 1 && admissions(held).length === 1,
        "One editor submit must create one admission and one worker attempt",
      );
      const post = posts(held)[0];
      check(
        post.path === "/repos/browser-fixture/isolated/pulls/1/reviews" &&
          post.payload?.event === "APPROVE" &&
          post.payload.commit_id === head &&
          post.payload.body === `${body}\n\n<!-- better-review:op:${command.operationId} -->`,
        "Production HTTP adapter did not send the captured event/head/body/UUID marker",
      );
      await githubWrites.snapshot(scope);
      const local = (await githubJournal.entries(scope)).find(
        (entry) => entry.command.operationId === command.operationId,
      );
      check(
        local?.backendOwned &&
          local.operation?.command.operationId === command.operationId &&
          JSON.stringify(local.command) === JSON.stringify(command),
        "Real durable admission receipt did not acknowledge the original IndexedDB intent",
      );
      const draft = local?.draftKey ? await githubJournal.draft(local.draftKey) : undefined;
      check(
        draft?.submittedOperationId === command.operationId && draft.body === body,
        "Actual editor draft was not linked to its submitted UUID",
      );
      const queue = document.querySelector("[data-global-github-queue]");
      document.querySelector<HTMLAnchorElement>('a[aria-label="Better Review home"]')!.click();
      await wait(
        () =>
          location.pathname === "/" &&
          !!document.querySelector('main [data-github-sync-status="inflight"]'),
        "Held backend work was not visible on the PR list",
      );
      check(
        document.querySelector("[data-global-github-queue]") === queue,
        "Navigation remounted the global queue owner",
      );
      const pending = await trpc.githubOutbox.pending.query();
      check(
        pending.some((item) => item.scope.url === url),
        "Production pending HTTP procedure did not discover admitted work after leaving the editor",
      );
      check(!badge(), "Held mutation falsely produced approved list evidence");
      await window.browserGithubHttp({ kind: "release-approval" });
      const uncertain = await readUntil(
        (evidence) => evidence.operations[0]?.status === "uncertain" && !!evidence.approval,
        "Applied approval with a lost response must become uncertain, never rejected or resent",
      );
      check(
        uncertain.operations[0].attempts === 1 &&
          !uncertain.operations[0].result &&
          posts(uncertain).length === 1,
        "Uncertain backend delivery must not invent success or another mutation attempt",
      );
      await githubWrites.recoverAll();
      await wait(
        () => !!document.querySelector('main [data-github-sync-status="uncertain"]'),
        "Actual list queue must expose uncertain delivery before reload",
      );
      finalEvidence = await inspect();
      check(
        posts(finalEvidence).length === 1 && admissions(finalEvidence).length === 1,
        "Uncertain recovery replayed admission or GitHub mutation",
      );
      sessionStorage.setItem(storageKey, JSON.stringify({ command, pid: backend.pid }));
    } else {
      const saved: {
        command: GithubOutboxCommand;
        pid: number;
        resumedReads?: typeof resumedReads;
      } = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      resumedReads = saved.resumedReads;
      check(
        saved && saved.pid === backend.pid,
        "Page reload must retain the same backend process and SQLite database",
      );
      check(
        performance
          .getEntriesByType("navigation")
          .some((entry) => "type" in entry && entry.type === "reload"),
        "After phase must execute in a genuinely reloaded page",
      );
      await githubWrites.recoverAll();
      if (phase === "resume") {
        await githubWrites.snapshot(scope);
        const uncertain = await inspect();
        const local = await githubJournal.entries(scope);
        check(
          uncertain.operations[0]?.status === "uncertain" &&
            local[0]?.operation?.status === "uncertain" &&
            local[0].backendOwned,
          "First real reload must retain uncertain delivery in SQLite and IndexedDB",
        );
        check(
          JSON.stringify(local[0].command) === JSON.stringify(saved.command) &&
            posts(uncertain).length === 1 &&
            admissions(uncertain).length === 1,
          "Reloading uncertain delivery must retain its original intent without blind resend",
        );
        await wait(
          () => !!document.querySelector('main [data-github-sync-status="uncertain"]'),
          "Reloaded list lost the uncertain operation",
        );
        await window.browserGithubHttp({ kind: "release-review-read" });
        const synced = await readUntil(
          (evidence) => evidence.operations[0]?.status === "synced",
          "Production worker reconciliation did not confirm the applied approval",
        );
        check(
          synced.operations[0].result?.kind === "approval" &&
            synced.operations[0].attempts === 1 &&
            JSON.stringify(synced.operations[0].command) === JSON.stringify(saved.command),
          "Read-only reconciliation changed the original intent or lacked confirmed approval evidence",
        );
        check(
          synced.calls.some((call) => call.method === "GET" && call.path.endsWith("/reviews")) &&
            posts(synced).length === 1,
          "Uncertain delivery must be confirmed by the production adapter's review-list read, never a second POST",
        );
        await githubWrites.recoverAll();
        await wait(
          () =>
            listRefreshes === 1 &&
            approvedReads > 0 &&
            !document.querySelector('main [data-github-sync-status="uncertain"]'),
          "Reconciled receipt must trigger one fresh approved list read",
        );
        resumedReads = { listReads, listRefreshes, approvedReads };
        sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, resumedReads }));
      }
      await wait(
        () => location.pathname === "/" && !!badge() && approvedReads > 0,
        "Reloaded list did not fetch and render approved remote read evidence",
      );
      const entries = await githubJournal.entries(scope);
      check(
        entries.length === 1 &&
          entries[0].backendOwned &&
          entries[0].operation?.status === "synced" &&
          JSON.stringify(entries[0].command) === JSON.stringify(saved.command),
        "Reload lost or replaced the acknowledged IndexedDB intent/receipt",
      );
      for (let read = 0; read < 3; read++) await githubWrites.recoverAll();
      finalEvidence = await inspect();
      check(
        finalEvidence.operations.length === 1 &&
          JSON.stringify(finalEvidence.operations[0].command) === JSON.stringify(saved.command) &&
          finalEvidence.operations[0].status === "synced" &&
          finalEvidence.operations[0].attempts === 1,
        "Reload changed persisted SQLite UUID, actor, head, body or attempt count",
      );
      check(
        posts(finalEvidence).length === 1 && admissions(finalEvidence).length === 1,
        "Recovery/reload blindly resent the original admission or GitHub mutation",
      );
      check(
        (await trpc.githubOutbox.pending.query()).length === 0,
        "Completed operation remained pending after reload",
      );
      check(
        finalEvidence.httpCalls.every((call) => call.authorized) &&
          finalEvidence.faults.length === 0,
        "Real HTTP outbox traffic failed fixture authentication or production routing",
      );
      check(
        finalEvidence.httpCalls.some((call) => call.path.endsWith("githubOutbox.identity")) &&
          finalEvidence.httpCalls.some((call) => call.path.endsWith("githubOutbox.pending")) &&
          finalEvidence.httpCalls.filter((call) => call.path.endsWith("githubOutbox.snapshot"))
            .length >= 3,
        "Browser must cross real production identity/pending/snapshot HTTP procedures",
      );
    }
  } finally {
    await window.browserGithubHttp({ kind: "release-approval" });
    dispose?.();
    if (phase === "after") cleanup = await window.browserGithubHttp({ kind: "close" });
  }
  if (cleanup)
    check(
      cleanup.processExited &&
        cleanup.serverClosed &&
        cleanup.runtimeStopped &&
        cleanup.storageRemoved &&
        cleanup.faults.length === 0,
      "Fixture must close runtime/SQLite/HTTP/process and remove isolated storage",
    );
  return {
    ...result(),
    evidence: {
      phase,
      listReads,
      listRefreshes,
      approvedReads,
      resumedReads,
      operationId: finalEvidence?.operations[0]?.command.operationId,
      actor: finalEvidence?.operations[0]?.command.expectedActor,
      attempts: finalEvidence?.operations[0]?.attempts,
      headSha:
        finalEvidence?.operations[0]?.command.action.kind === "approve"
          ? finalEvidence.operations[0].command.action.expectedHeadSha
          : undefined,
      admissions: finalEvidence && admissions(finalEvidence).length,
      githubMutationPosts: finalEvidence && posts(finalEvidence).length,
      githubReads: finalEvidence?.calls
        .filter((call) => call.method === "GET")
        .reduce<Record<string, number>>((counts, call) => {
          counts[call.path] = (counts[call.path] ?? 0) + 1;
          return counts;
        }, {}),
      httpProcedures:
        cleanup?.httpProcedures ??
        finalEvidence?.httpCalls.reduce<Record<string, number>>((counts, call) => {
          const name = call.path.split("/").at(-1)!;
          counts[name] = (counts[name] ?? 0) + 1;
          return counts;
        }, {}),
      cleanup,
    },
  };
}
