import type { FileDiffMetadata } from "@pierre/diffs";

import type {
  GithubActor,
  IssueComment,
  PRComment,
  PrDetail,
  PrStatus,
} from "@better-review/shared";

import { createGithubConfirmationState } from "./github-confirmation-state";
import type { BrowserGithubOperation } from "./github-outbox";
import {
  createGithubOutboxProjection,
  type GithubCommentView,
  type GithubReadToken,
  type GithubRemoteRead,
  type GithubRemoteReview,
  type GithubThreadView,
} from "./github-outbox-projection";
import { currentGithubActor, githubPrScope, githubWrites } from "./github-writes";

const projection = createGithubOutboxProjection();
const reads = new Map<string, { comments: PRComment[]; issueComments: IssueComment[] }>();
const reviewReads = new Map<string, GithubRemoteReview[]>();
const commentReadSerials = new Map<string, number>();
const reviewReadSerials = new Map<string, number>();
// One production owner survives App/tab/PR remounts; the factory itself is isolated.
export const githubConfirmationState = createGithubConfirmationState();
githubWrites.subscribe(() => {
  for (const state of githubWrites.getStates()) githubConfirmationState.observe(state.operations);
});
const listeners = new Set<() => void>();
export function subscribeGithubComments(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function beginGithubCommentRead(url: string) {
  const state = githubWrites.getState(githubPrScope(url));
  return githubConfirmationState.captureRead(
    projection.beginRead(state),
    currentGithubActor(),
    state.operations,
  );
}
function normalize(data: {
  comments: PRComment[];
  issueComments: IssueComment[];
}): GithubRemoteRead {
  return {
    comments: [
      ...data.comments.map((raw) => ({
        ref: { source: "remote" as const, kind: "review-comment" as const, id: raw.id },
        body: raw.body,
        updatedAt: raw.updated_at,
        raw,
      })),
      ...data.issueComments.map((raw) => ({
        ref: { source: "remote" as const, kind: "issue-comment" as const, id: raw.id },
        body: raw.body,
        updatedAt: raw.updated_at,
        raw,
      })),
    ],
    threads: data.comments.flatMap((raw) =>
      raw.threadId && typeof raw.isResolved === "boolean"
        ? [
            {
              ref: { source: "remote" as const, kind: "thread" as const, nodeId: raw.threadId },
              resolved: raw.isResolved,
              raw,
            },
          ]
        : [],
    ),
    approvals: [],
  };
}

/** Canonical GitHub review URLs carry the REST identity used by durable write results. */
export function acceptGithubDetailRead(token: GithubReadToken, detail: PrDetail) {
  githubConfirmationState.acceptDetail(token, detail);
  if (detail.reviews.status !== "available") return false;
  if (token.serial < (reviewReadSerials.get(token.scope.url) ?? 0)) return false;
  const reviews: GithubRemoteReview[] = detail.reviews.data.flatMap((review) => {
    if (
      !review.commitSha ||
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state)
    )
      return [];
    let id: number;
    try {
      const link = new URL(review.url);
      const pr = new URL(detail.url);
      if (link.origin !== pr.origin || link.pathname.toLowerCase() !== pr.pathname.toLowerCase())
        return [];
      const match = /^#pullrequestreview-(\d+)$/.exec(link.hash);
      if (!match) return [];
      id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return [];
    } catch {
      return [];
    }
    const state = review.state;
    if (
      state !== "APPROVED" &&
      state !== "CHANGES_REQUESTED" &&
      state !== "COMMENTED" &&
      state !== "DISMISSED"
    )
      return [];
    return [
      {
        id,
        commitSha: review.commitSha,
        state,
        body: review.body,
        submittedAt: review.submittedAt ?? undefined,
        url: review.url,
        raw: review,
      },
    ];
  });
  const previous = reads.get(token.scope.url) ?? { comments: [], issueComments: [] };
  const current = githubWrites.getState(token.scope);
  const confirmed = new Map(
    [...token.confirmed].filter(([id]) => {
      const result = current.operations.find((item) => item.command.operationId === id)?.operation
        ?.result;
      return result?.kind === "review" || result?.kind === "approval";
    }),
  );
  // Extras and detail are independent network resources. Merge each with the latest
  // accepted sibling without allowing an older read of that same resource to win.
  // Keep the original confirmation fence: completion after request start is not evidence.
  const merged = projection.beginRead(current);
  if (!projection.acceptRemote({ ...merged, confirmed }, { ...normalize(previous), reviews }))
    return false;
  reviewReadSerials.set(token.scope.url, token.serial);
  reviewReads.set(token.scope.url, reviews);
  for (const listener of listeners) listener();
  return true;
}
export function acceptGithubCommentRead(
  token: GithubReadToken,
  data: {
    comments: PRComment[] | null;
    issueComments: IssueComment[] | null;
    status?: PrStatus | null;
  },
) {
  if (token.serial < (commentReadSerials.get(token.scope.url) ?? 0)) return false;
  const previous = reads.get(token.scope.url);
  const next = {
    comments: data.comments ?? previous?.comments ?? [],
    issueComments: data.issueComments ?? previous?.issueComments ?? [],
  };
  // An optional extras resource that failed is not fresh evidence for retirement.
  const current = githubWrites.getState(token.scope);
  const confirmed = new Map(
    [...token.confirmed].filter(([id]) => {
      const result = current.operations.find((item) => item.command.operationId === id)?.operation
        ?.result;
      if (!result) return false;
      if (result.kind === "issue-comment") return data.issueComments !== null;
      if (result.kind === "review-comment" || result.kind === "thread")
        return data.comments !== null;
      if (result.kind === "deleted")
        return result.target.kind === "issue-comment"
          ? data.issueComments !== null
          : data.comments !== null;
      return false;
    }),
  );
  const merged = projection.beginRead(current);
  if (
    !projection.acceptRemote(
      { ...merged, confirmed },
      { ...normalize(next), reviews: reviewReads.get(token.scope.url) },
    )
  )
    return false;
  commentReadSerials.set(token.scope.url, token.serial);
  githubConfirmationState.acceptStatus(token, data.status);
  reads.set(token.scope.url, next);
  for (const listener of listeners) listener();
  return true;
}
/** Cached data is not a post-confirmation network read and cannot retire an overlay. */
export function seedGithubCommentRead(
  url: string,
  data: { comments: PRComment[] | null; issueComments: IssueComment[] | null },
) {
  const scope = githubPrScope(url);
  if (reads.has(scope.url)) return;
  const state = githubWrites.getState(scope);
  const token = projection.beginRead({ ...state, operations: [] });
  acceptGithubCommentRead(token, data);
}
export function projectGithubComments(url: string) {
  return projection.project(githubWrites.getState(githubPrScope(url)));
}

/** A confirmed receipt bridges read latency, never a timer or an optimistic write.
 * Only a complete, same-head/account read STARTED after confirmation supersedes it.
 */
export function githubApprovalState(
  url: string,
  head: string | null | undefined,
  actor: GithubActor | undefined,
  status: PrStatus | null,
): "pending" | "synced" | undefined {
  if (!head || !actor) return;
  return githubConfirmationState.approval({
    url,
    head,
    actor,
    status,
    operations: githubWrites.getState(githubPrScope(url)).operations,
  }).state;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
export function remoteCommentDetails(view: GithubCommentView) {
  const raw = object(view.raw) ? view.raw : undefined;
  const user = raw && object(raw.user) ? raw.user : undefined;
  const knownLogin =
    view.author?.login ??
    view.confirmed?.author.login ??
    (typeof user?.login === "string" ? user.login : undefined);
  return {
    login: knownLogin ?? "GitHub user",
    knownLogin,
    avatar: typeof user?.avatar_url === "string" ? user.avatar_url : undefined,
    canEdit: raw?.canEdit === true || !!view.localRef || !!view.confirmed,
    url: view.confirmed?.url ?? (typeof raw?.html_url === "string" ? raw.html_url : undefined),
    createdAt:
      view.confirmed?.createdAt ??
      (typeof raw?.created_at === "string" ? raw.created_at : undefined),
    threadId:
      view.confirmed?.kind === "review-comment"
        ? view.confirmed.threadId
        : typeof raw?.threadId === "string"
          ? raw.threadId
          : undefined,
    inReplyToId:
      view.confirmed?.kind === "review-comment"
        ? view.confirmed.inReplyToId
        : typeof raw?.in_reply_to_id === "number"
          ? raw.in_reply_to_id
          : undefined,
  };
}
export function githubCommentLocation(
  view: GithubCommentView,
  operations: BrowserGithubOperation[],
  comments: GithubCommentView[] = [],
  seen = new Set<string>(),
): { path: string; line: number; side: "LEFT" | "RIGHT"; expectedHeadSha?: string } | undefined {
  if (seen.has(view.key)) return;
  seen.add(view.key);
  const creation = operations.find(
    (item) =>
      item.command.operationId ===
      (view.localRef?.operationId ??
        (view.ref.source === "local" ? view.ref.operationId : undefined)),
  );
  const expectedHeadSha =
    creation?.command.action.kind === "inline-comment"
      ? creation.command.action.expectedHeadSha
      : undefined;
  const raw = object(view.raw) ? view.raw : undefined;
  if (raw && typeof raw.path === "string") {
    const line = typeof raw.line === "number" ? raw.line : raw.original_line;
    if (typeof line === "number" && (raw.side === "LEFT" || raw.side === "RIGHT"))
      return { path: raw.path, line, side: raw.side, expectedHeadSha };
  }
  if (view.confirmed?.kind === "review-comment") {
    const location = view.confirmed.location;
    const line = location.line ?? location.originalLine;
    if (line !== null) return { path: location.path, line, side: location.side, expectedHeadSha };
  }
  if (creation?.command.action.kind === "inline-comment")
    return {
      ...creation.command.action.anchor,
      expectedHeadSha: creation.command.action.expectedHeadSha,
    };
  if (creation?.command.action.kind === "reply") {
    const target = creation.command.action.target;
    const parentView = comments.find((comment) =>
      target.source === "local"
        ? comment.localRef?.operationId === target.operationId ||
          (comment.ref.source === "local" && comment.ref.operationId === target.operationId)
        : comment.ref.source === "remote" &&
          comment.ref.kind === target.kind &&
          comment.ref.id === target.id,
    );
    if (parentView) return githubCommentLocation(parentView, operations, comments, seen);
    if (target.source === "local") {
      const parent = operations.find((item) => item.command.operationId === target.operationId);
      if (parent?.command.action.kind === "inline-comment")
        return {
          ...parent.command.action.anchor,
          expectedHeadSha: parent.command.action.expectedHeadSha,
        };
    }
  }
  return undefined;
}

export function githubLocationInPatch(
  location: { line: number; side: "LEFT" | "RIGHT" },
  file: FileDiffMetadata,
) {
  return file.hunks.some((hunk) => {
    const start = location.side === "LEFT" ? hunk.deletionStart : hunk.additionStart;
    const count = location.side === "LEFT" ? hunk.deletionCount : hunk.additionCount;
    return location.line >= start && location.line < start + count;
  });
}

export function githubThreadForComment(
  comment: GithubCommentView,
  threads: GithubThreadView[],
  operations: BrowserGithubOperation[],
  comments: GithubCommentView[] = [],
): GithubThreadView | undefined {
  if (comment.ref.kind !== "review-comment") return;
  comment = githubReviewThreadRoot(comment, comments, operations);
  const details = remoteCommentDetails(comment);
  const thread = threads.find((item) =>
    item.ref.source === "remote"
      ? item.ref.nodeId === details.threadId
      : item.ref.operationId === comment.localRef?.operationId,
  );
  if (thread) return thread;
  const id = comment.localRef?.operationId;
  if (
    id &&
    operations.some(
      (item) => item.command.operationId === id && item.command.action.kind === "inline-comment",
    )
  )
    return {
      key: `local:thread:${id}`,
      ref: { source: "local", kind: "thread", operationId: id },
      resolved: false,
      pending: false,
      operationIds: [id],
    };
}

/** Keep local reply ancestry for presentation; the HTTP adapter alone normalizes
 * the write target to GitHub's root. Edit/delete still use the comment's own ref. */
export function githubReviewThreadRoot(
  comment: GithubCommentView,
  comments: GithubCommentView[],
  operations: BrowserGithubOperation[],
  seen = new Set<string>(),
): GithubCommentView {
  if (seen.has(comment.key)) return comment;
  seen.add(comment.key);
  const creation = operations.find(
    (item) =>
      item.command.operationId ===
      (comment.localRef?.operationId ??
        (comment.ref.source === "local" ? comment.ref.operationId : undefined)),
  );
  const action = creation?.command.action;
  const target = action?.kind === "reply" ? action.target : undefined;
  const details = remoteCommentDetails(comment);
  const parent = comments.find(
    (candidate) =>
      candidate.key !== comment.key &&
      (target?.source === "local"
        ? candidate.localRef?.operationId === target.operationId ||
          (candidate.ref.source === "local" && candidate.ref.operationId === target.operationId)
        : candidate.ref.source === "remote" &&
          candidate.ref.kind === "review-comment" &&
          candidate.ref.id === (target?.source === "remote" ? target.id : details.inReplyToId)),
  );
  return parent ? githubReviewThreadRoot(parent, comments, operations, seen) : comment;
}

export function groupGithubReviewComments(
  comments: GithubCommentView[],
  operations: BrowserGithubOperation[],
) {
  const groups = new Map<string, { root: GithubCommentView; comments: GithubCommentView[] }>();
  for (const comment of comments) {
    const root = githubReviewThreadRoot(comment, comments, operations);
    let group = groups.get(root.key);
    if (!group) groups.set(root.key, (group = { root, comments: [] }));
    group.comments.push(comment);
  }
  return [...groups.values()];
}
