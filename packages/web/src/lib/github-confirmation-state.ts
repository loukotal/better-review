import type { GithubActor, PrDetail, PrStatus } from "@better-review/shared";
import { viewerApprovalForReview } from "@better-review/shared";

import type { BrowserGithubOperation } from "./github-outbox";
import type { GithubReadToken } from "./github-outbox-projection";
import { githubPrScope } from "./github-pr-scope";

interface ReadCoverage {
  url: string;
  serial: number;
  actor?: GithubActor;
  bridges: Map<string, Set<string>>;
}
type ApprovalState = "pending" | "synced" | undefined;
const key = (url: string, actor: number, head: string) => JSON.stringify([url, actor, head]);
function stageEvidence(detail: PrDetail) {
  const metadata = detail.metadata;
  return JSON.stringify({
    fetchedAt: detail.fetchedAt,
    metadata:
      metadata.status === "available"
        ? {
            id: metadata.data.id,
            url: metadata.data.url,
            state: metadata.data.state,
            draft: metadata.data.draft,
            complete: metadata.complete,
          }
        : metadata,
    actor: detail.actor,
    capabilities: detail.stageCapabilities,
  });
}

/** Read-start coverage, receipt bridges and action selection share one lifetime.
 * No transport, cache, subscription or singleton is owned here.
 */
export function createGithubConfirmationState() {
  const pendingApprovals = new Set<string>();
  const pendingStages = new Set<string>();
  const coverage = new WeakMap<GithubReadToken, ReadCoverage>();
  const detailReads = new Map<string, { read: ReadCoverage; approved: boolean }>();
  const statusReads = new Map<string, { read: ReadCoverage; approved: boolean }>();
  const detailSerials = new Map<string, number>();
  const statusSerials = new Map<string, number>();
  const stageReads = new Map<string, { read: ReadCoverage; evidence: string }>();
  // A generation is the acknowledged set of observed intent IDs, not a poll revision.
  const retiredStages = new Map<string, Set<string>>();
  const intents = (item: BrowserGithubOperation, observed: Set<string>) =>
    [item.command.operationId, ...(item.submittedOperationIds ?? [])].filter((id) =>
      observed.has(id),
    );
  const covers = (read: ReadCoverage, item: BrowserGithubOperation, observed: Set<string>) =>
    !!read.bridges.get(item.command.operationId) &&
    intents(item, observed).every((id) => read.bridges.get(item.command.operationId)!.has(id));

  function observe(operations: readonly BrowserGithubOperation[]) {
    for (const item of operations) {
      if (item.status === "synced" || item.status === "cancelled") continue;
      if (item.command.action.kind === "approve") pendingApprovals.add(item.command.operationId);
      if (item.command.action.kind === "set-draft") pendingStages.add(item.command.operationId);
    }
  }
  function captureRead(
    token: GithubReadToken,
    actor: GithubActor | undefined,
    operations: readonly BrowserGithubOperation[],
  ) {
    // Pending aliases are not acknowledged yet. Snapshot only synced submissions,
    // so a late pre-confirmation response cannot supersede a new receipt bridge.
    const captured = {
      url: token.scope.url,
      serial: token.serial,
      actor: actor ? { ...actor } : undefined,
      bridges: new Map(
        operations
          .filter(
            (item) => item.status === "synced" && token.confirmed.has(item.command.operationId),
          )
          .map((item) => [
            item.command.operationId,
            new Set(
              intents(
                item,
                item.command.action.kind === "approve" ? pendingApprovals : pendingStages,
              ),
            ),
          ]),
      ),
    };
    const result = {
      ...token,
      // Retain diagnostic token metadata without exposing the owner's mutable maps.
      approvalActor: captured.actor ? { ...captured.actor } : undefined,
      approvalBridges: new Map(
        operations
          .filter((item) => item.status === "synced" && intents(item, pendingApprovals).length > 0)
          .map((item) => [item.command.operationId, new Set(intents(item, pendingApprovals))]),
      ),
    };
    coverage.set(result, captured);
    return result;
  }
  function acceptDetail(token: GithubReadToken, detail: PrDetail) {
    const read = coverage.get(token);
    if (!read) return;
    if (
      detail.url.toLowerCase() === read.url &&
      read.serial >= (stageReads.get(read.url)?.read.serial ?? 0)
    )
      stageReads.set(read.url, { read, evidence: stageEvidence(detail) });
    if (detail.reviews.status !== "available" || read.serial < (detailSerials.get(read.url) ?? 0))
      return;
    detailSerials.set(read.url, read.serial);
    const actor = read.actor;
    if (
      !actor ||
      detail.url !== read.url ||
      !detail.reviews.complete ||
      detail.metadata.status !== "available" ||
      !detail.metadata.complete ||
      detail.actor.status !== "available" ||
      !detail.actor.complete ||
      detail.actor.data?.databaseId !== actor.id ||
      detail.actor.data?.login !== actor.login
    )
      return;
    const own = detail.reviews.data
      .filter((review) => review.author === actor.login)
      .toSorted((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
    const latest = own[0];
    const ambiguous =
      own.length > 1 &&
      own.some(
        (review) =>
          (!review.submittedAt || review.submittedAt === latest?.submittedAt) &&
          (review.state !== latest?.state || review.commitSha !== latest?.commitSha),
      );
    detailReads.set(key(read.url, actor.id, detail.metadata.data.head.sha), {
      read,
      approved: !!viewerApprovalForReview({
        login: actor.login,
        headSha: detail.metadata.data.head.sha,
        latest: ambiguous ? undefined : latest,
        requests:
          detail.reviewRequests.status === "available"
            ? { complete: detail.reviewRequests.complete, items: detail.reviewRequests.data }
            : undefined,
      }),
    });
  }
  function acceptStatus(token: GithubReadToken, status: PrStatus | null | undefined) {
    const read = coverage.get(token);
    if (!read || read.serial < (statusSerials.get(read.url) ?? 0)) return;
    statusSerials.set(read.url, read.serial);
    const context = status?.reviewContext;
    if (
      !context ||
      !read.actor ||
      status?.url !== read.url ||
      context.actor.id !== read.actor.id ||
      context.actor.login !== read.actor.login
    )
      return;
    statusReads.set(key(read.url, context.actor.id, context.headSha), {
      read,
      approved:
        status.viewerApproval?.login === context.actor.login &&
        status.viewerApproval?.commitSha === context.headSha,
    });
  }
  function approval(input: {
    url: string;
    head: string | null | undefined;
    actor: GithubActor | undefined;
    status: PrStatus | null;
    operations: readonly BrowserGithubOperation[];
  }): { operations: BrowserGithubOperation[]; state: ApprovalState } {
    const { head, actor, status } = input;
    const url = githubPrScope(input.url).url;
    const operations = input.operations.filter(
      (item) =>
        item.command.scope.url === url &&
        item.command.expectedActor.id === actor?.id &&
        item.command.action.kind === "approve" &&
        item.command.action.expectedHeadSha === head &&
        item.status !== "cancelled",
    );
    if (!head || !actor) return { operations, state: undefined };
    if (operations.some((item) => item.status !== "synced"))
      return { operations, state: "pending" };
    const confirmed = operations.filter(
      (item) =>
        intents(item, pendingApprovals).length > 0 &&
        item.operation?.result?.kind === "approval" &&
        item.operation.result.commitSha === head,
    );
    if (confirmed.length) {
      const read = detailReads.get(key(url, actor.id, head));
      const candidate = statusReads.get(key(url, actor.id, head));
      const statusRead =
        candidate?.read.actor?.id === actor.id &&
        confirmed.every((item) => covers(candidate.read, item, pendingApprovals))
          ? candidate
          : undefined;
      if (
        read &&
        read.read.actor?.id === actor.id &&
        (!statusRead || read.read.serial > statusRead.read.serial) &&
        confirmed.every((item) => covers(read.read, item, pendingApprovals))
      )
        return { operations, state: read.approved ? "synced" : undefined };
      if (statusRead) return { operations, state: statusRead.approved ? "synced" : undefined };
      return { operations, state: "synced" };
    }
    return {
      operations,
      state:
        status?.viewerApproval?.commitSha === head && status.viewerApproval.login === actor.login
          ? "synced"
          : undefined,
    };
  }
  function draft(input: {
    url: string;
    detail: PrDetail | undefined;
    actor: GithubActor | undefined;
    operations: readonly BrowserGithubOperation[];
  }) {
    const { detail, actor } = input;
    const url = githubPrScope(input.url).url;
    const operations = input.operations.filter(
      (item) => item.command.scope.url === url && item.command.action.kind === "set-draft",
    );
    const pending = operations.filter(
      (item) =>
        !item.operation?.archivedAt && item.status !== "synced" && item.status !== "cancelled",
    );
    const latest = operations
      .filter((item) => item.status === "synced" && intents(item, pendingStages).length > 0)
      .at(-1);
    let confirmed;
    if (latest?.operation?.result?.kind === "pull-request-draft") {
      const ids = intents(latest, pendingStages);
      const retired = retiredStages.get(latest.command.operationId);
      if (!retired || !ids.every((id) => retired.has(id))) {
        const read = stageReads.get(url);
        if (
          read &&
          detail &&
          read.evidence === stageEvidence(detail) &&
          detail.metadata.status === "available" &&
          detail.metadata.complete &&
          detail.stageCapabilities?.status === "available" &&
          detail.stageCapabilities.complete &&
          covers(read.read, latest, pendingStages)
        )
          retiredStages.set(latest.command.operationId, new Set(ids));
        else confirmed = latest.operation.result;
      }
    }
    const metadata = detail?.metadata.status === "available" ? detail.metadata.data : undefined;
    const samePr = (value?: string) => {
      try {
        return !!value && githubPrScope(value).url === url;
      } catch {
        return false;
      }
    };
    const caps = detail?.stageCapabilities;
    const allowed = !!(
      samePr(detail?.url) &&
      samePr(metadata?.url) &&
      detail?.metadata.status === "available" &&
      detail.metadata.complete &&
      detail.actor.status === "available" &&
      detail.actor.complete &&
      actor &&
      detail.actor.data.databaseId === actor.id &&
      caps?.status === "available" &&
      caps.complete &&
      caps.data.canSetDraft &&
      metadata?.state === "OPEN"
    );
    return {
      pending,
      confirmed,
      metadata,
      allowed,
      action:
        allowed && metadata
          ? { kind: "set-draft" as const, pullRequestId: metadata.id, draft: !metadata.draft }
          : undefined,
    };
  }
  return { observe, captureRead, acceptDetail, acceptStatus, approval, draft };
}
