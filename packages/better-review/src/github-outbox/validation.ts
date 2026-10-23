import {
  isGithubRemoteResult,
  type GithubOutboxOperation,
  type GithubRemoteResult,
  type GithubWriteAction,
} from "@better-review/shared";

import type { OutboxDatabase } from "./database.js";

export function resolved(
  store: OutboxDatabase,
  op: GithubOutboxOperation,
): GithubOutboxOperation | undefined {
  const copy = structuredClone(op);
  const action = copy.command.action;
  if (!("target" in action) || action.target.source === "remote") return copy;
  const result = store.get(action.target.operationId)?.result;
  if (!result) return;
  if (action.target.kind === "thread") {
    if (result.kind !== "review-comment" || !result.threadId) return;
    action.target = { source: "remote", kind: "thread", nodeId: result.threadId };
    return copy;
  }
  if (result.kind !== action.target.kind || !("id" in result)) return;
  action.target = {
    source: "remote",
    kind: action.target.kind,
    id:
      action.kind === "reply" && result.kind === "review-comment"
        ? (result.inReplyToId ?? result.id)
        : result.id,
  };
  return copy;
}

export function matches(
  op: GithubOutboxOperation,
  result: GithubRemoteResult,
  originalAction?: GithubWriteAction,
): boolean {
  if (!isGithubRemoteResult(result)) return false;
  if (
    (result.kind === "issue-comment" ||
      result.kind === "review-comment" ||
      result.kind === "review") &&
    result.author.id !== op.command.expectedActor.id
  )
    return false;
  const a = op.command.action;
  switch (a.kind) {
    case "set-draft":
      return (
        result.kind === "pull-request-draft" &&
        result.nodeId === a.pullRequestId &&
        result.url === op.command.scope.url &&
        result.draft === a.draft
      );
    case "issue-comment":
      return result.kind === "issue-comment" && result.body === a.body;
    case "inline-comment":
      return (
        result.kind === "review-comment" &&
        result.body === a.body &&
        result.location.path === a.anchor.path &&
        result.location.side === a.anchor.side &&
        (result.location.line ?? result.location.originalLine) === a.anchor.line &&
        result.location.commitSha === a.expectedHeadSha &&
        result.inReplyToId === undefined
      );
    case "reply":
      return (
        result.kind === "review-comment" &&
        result.body === a.body &&
        a.target.source === "remote" &&
        // A remote target may itself be a reply. Adapter has authenticated and
        // verified its root; local targets already have a durable known root.
        typeof result.inReplyToId === "number" &&
        (result.inReplyToId === a.target.id ||
          (originalAction?.kind === "reply" && originalAction.target.source === "remote"))
      );
    case "approve":
      return result.kind === "approval" && result.commitSha === a.expectedHeadSha;
    case "request-changes":
    case "review-comment":
      return (
        result.kind === "review" &&
        result.commitSha === a.expectedHeadSha &&
        result.body === a.body &&
        result.state === (a.kind === "request-changes" ? "CHANGES_REQUESTED" : "COMMENTED")
      );
    case "edit-comment":
      return (
        result.kind === a.target.kind &&
        "id" in result &&
        a.target.source === "remote" &&
        result.id === a.target.id &&
        "body" in result &&
        result.body === a.body
      );
    case "delete-comment":
      return (
        result.kind === "deleted" &&
        a.target.source === "remote" &&
        result.target.kind === a.target.kind &&
        result.target.id === a.target.id
      );
    case "resolve-thread":
    case "unresolve-thread":
      return (
        result.kind === "thread" &&
        a.target.source === "remote" &&
        result.nodeId === a.target.nodeId &&
        result.resolved === (a.kind === "resolve-thread")
      );
  }
}
