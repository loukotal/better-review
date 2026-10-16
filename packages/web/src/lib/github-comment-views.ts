import type { FileDiffMetadata } from "@pierre/diffs";

import type { IssueComment, PRComment } from "@better-review/shared";

import type { BrowserGithubOperation } from "./github-outbox";
import {
  createGithubOutboxProjection,
  type GithubCommentView,
  type GithubReadToken,
  type GithubRemoteRead,
  type GithubThreadView,
} from "./github-outbox-projection";
import { githubPrScope, githubWrites } from "./github-writes";

const projection = createGithubOutboxProjection();
const reads = new Map<string, { comments: PRComment[]; issueComments: IssueComment[] }>();
const listeners = new Set<() => void>();
export function subscribeGithubComments(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function beginGithubCommentRead(url: string) {
  return projection.beginRead(githubWrites.getState(githubPrScope(url)));
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
      raw.threadId
        ? [
            {
              ref: { source: "remote" as const, kind: "thread" as const, nodeId: raw.threadId },
              resolved: raw.isResolved ?? false,
              raw,
            },
          ]
        : [],
    ),
    approvals: [],
  };
}
export function acceptGithubCommentRead(
  token: GithubReadToken,
  data: { comments: PRComment[] | null; issueComments: IssueComment[] | null },
) {
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
  if (!projection.acceptRemote({ ...token, confirmed }, normalize(next))) return false;
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

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
export function remoteCommentDetails(view: GithubCommentView) {
  const raw = object(view.raw) ? view.raw : undefined;
  const user = raw && object(raw.user) ? raw.user : undefined;
  return {
    login:
      view.author?.login ??
      view.confirmed?.author.login ??
      (typeof user?.login === "string" ? user.login : "GitHub user"),
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
): GithubThreadView | undefined {
  if (comment.ref.kind !== "review-comment") return;
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
