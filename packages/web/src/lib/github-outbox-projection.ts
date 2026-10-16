import type {
  GithubCommentRef,
  GithubActor,
  GithubOutboxOperation,
  GithubPrScope,
  GithubRemoteResult,
  GithubThreadRef,
} from "@better-review/shared";

import type { BrowserGithubOperation, BrowserGithubState } from "./github-outbox";

/** Normalized input alongside (not replacing or mutating) raw GitHub read models. */
export interface GithubRemoteComment {
  ref: GithubCommentRef & { source: "remote" };
  body: string;
  raw?: unknown;
  author?: GithubActor;
  updatedAt?: string;
}
export interface GithubRemoteThread {
  ref: GithubThreadRef & { source: "remote" };
  resolved: boolean;
  raw?: unknown;
}
export interface GithubRemoteApproval {
  id: number;
  commitSha: string;
  raw?: unknown;
}
export interface GithubRemoteRead {
  comments: GithubRemoteComment[];
  threads: GithubRemoteThread[];
  approvals: GithubRemoteApproval[];
}
interface Decoration {
  key: string;
  operationIds: string[];
  pending: boolean;
}
export interface GithubCommentView extends Decoration {
  ref: GithubCommentRef;
  /** Stable alias remains available when a local creation receives its remote ID. */
  localRef?: GithubCommentRef & { source: "local" };
  body: string;
  raw?: unknown;
  deleted: boolean;
  action?: BrowserGithubOperation["command"]["action"];
  author?: GithubActor;
  /** Complete durable metadata supports full UI rendering even before a remote read. */
  confirmed?: Extract<GithubRemoteResult, { kind: "issue-comment" | "review-comment" }>;
}
export interface GithubThreadView extends Decoration {
  ref: GithubThreadRef;
  resolved: boolean;
  raw?: unknown;
}
export interface GithubApprovalView extends Decoration {
  id?: number;
  localOperationId?: string;
  commitSha: string;
  raw?: unknown;
}
export interface GithubReadToken {
  scope: GithubPrScope;
  serial: number;
  /** Only results known BEFORE the request can be retired by its response. */
  confirmed: ReadonlyMap<string, number>;
}

export function githubEntityKey(ref: GithubCommentRef | GithubThreadRef): string {
  return ref.source === "local"
    ? `local:${ref.kind}:${ref.operationId}`
    : ref.kind === "thread"
      ? `remote:thread:${ref.nodeId}`
      : `remote:${ref.kind}:${ref.id}`;
}

/** No marker syntax is assumed. Recognizer must validate the adapter's canonical pattern. */
export function stripRecognizedGithubMarkers(
  body: string,
  canonical: (comment: string) => boolean,
): string {
  return body.replace(/<!--[\s\S]*?-->/g, (comment) => (canonical(comment) ? "" : comment));
}

/** Adapter-owned canonical suffix; preserve malformed/lookalike/embedded user text. */
export function cleanGithubOutboxBody(body: string): string {
  return body.replace(
    /(?:\n\n)?<!-- better-review:op:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/i,
    "",
  );
}

export function createGithubOutboxProjection(
  options: { cleanBody?: (body: string) => string } = {},
) {
  const clean = options.cleanBody ?? cleanGithubOutboxBody;
  let serial = 0;
  const reads = new Map<string, { token: GithubReadToken; remote: GithubRemoteRead }>();
  const retired = new Map<string, Map<string, number>>();
  // Stable creation aliases survive retirement and subsequent external edits.
  const aliases = new Map<string, Map<string, GithubCommentRef & { source: "local" }>>();
  const threadAliases = new Map<string, Map<string, GithubThreadRef & { source: "local" }>>();
  const approvalAliases = new Map<string, Map<number, string>>();

  function beginRead(state: BrowserGithubState): GithubReadToken {
    return {
      scope: structuredClone(state.scope),
      serial: ++serial,
      confirmed: new Map(
        state.operations
          .filter((item) => item.status === "synced" && item.operation)
          .map((item) => [item.command.operationId, item.operation!.revision]),
      ),
    };
  }
  function acceptRemote(token: GithubReadToken, remote: GithubRemoteRead): boolean {
    if ((reads.get(token.scope.url)?.token.serial ?? -1) >= token.serial) return false;
    reads.set(token.scope.url, { token, remote: structuredClone(remote) });
    return true;
  }
  function project(state: BrowserGithubState) {
    const read = reads.get(state.scope.url);
    const remote = read?.remote ?? { comments: [], threads: [], approvals: [] };
    let retiredHere = retired.get(state.scope.url);
    if (!retiredHere) retired.set(state.scope.url, (retiredHere = new Map()));
    let aliasesHere = aliases.get(state.scope.url);
    if (!aliasesHere) aliases.set(state.scope.url, (aliasesHere = new Map()));
    let threadAliasesHere = threadAliases.get(state.scope.url);
    if (!threadAliasesHere) threadAliases.set(state.scope.url, (threadAliasesHere = new Map()));
    let approvalAliasesHere = approvalAliases.get(state.scope.url);
    if (!approvalAliasesHere)
      approvalAliases.set(state.scope.url, (approvalAliasesHere = new Map()));
    const all = new Map(state.operations.map((item) => [item.command.operationId, item]));
    const resolve = (
      ref: GithubCommentRef | GithubThreadRef,
    ): GithubCommentRef | GithubThreadRef => {
      if (ref.source === "remote") return ref;
      const result = all.get(ref.operationId)?.operation?.result;
      if (ref.kind === "thread" && result?.kind === "thread") {
        return { source: "remote", kind: "thread", nodeId: result.nodeId };
      }
      if (ref.kind === "thread" && result?.kind === "review-comment" && result.threadId) {
        return { source: "remote", kind: "thread", nodeId: result.threadId };
      }
      if (
        ref.kind !== "thread" &&
        (result?.kind === "issue-comment" || result?.kind === "review-comment")
      ) {
        return { source: "remote", kind: result.kind, id: result.id };
      }
      return ref;
    };
    function observed(operation: GithubOutboxOperation): boolean {
      const result = operation.result;
      if (!result) return false;
      const action = operation.command.action;
      if (result.kind === "issue-comment" || result.kind === "review-comment") {
        const comment = remote.comments.find(
          (item) => item.ref.id === result.id && item.ref.kind === result.kind,
        );
        return (
          !!comment &&
          (action.kind !== "edit-comment" ||
            clean(comment.body) === clean(result.body) ||
            (!!comment.updatedAt && Date.parse(comment.updatedAt) > Date.parse(result.updatedAt)))
        );
      }
      if (result.kind === "approval")
        return remote.approvals.some(
          (item) => item.id === result.id && item.commitSha === result.commitSha,
        );
      if (result.kind === "deleted")
        return !remote.comments.some(
          (item) => item.ref.kind === result.target.kind && item.ref.id === result.target.id,
        );
      return remote.threads.some(
        (item) => item.ref.nodeId === result.nodeId && item.resolved === result.resolved,
      );
    }
    for (const item of state.operations) {
      const action = item.command.action;
      const result = item.operation?.result;
      if (
        ["issue-comment", "inline-comment", "reply"].includes(action.kind) &&
        (result?.kind === "issue-comment" || result?.kind === "review-comment")
      ) {
        aliasesHere.set(githubEntityKey({ source: "remote", kind: result.kind, id: result.id }), {
          source: "local",
          kind: result.kind,
          operationId: item.command.operationId,
        });
      }
      if (
        action.kind === "inline-comment" &&
        result?.kind === "review-comment" &&
        result.threadId
      ) {
        threadAliasesHere.set(result.threadId, {
          source: "local",
          kind: "thread",
          operationId: item.command.operationId,
        });
      }
      if (action.kind === "approve" && result?.kind === "approval") {
        approvalAliasesHere.set(result.id, item.command.operationId);
      }
      if (
        item.status === "synced" &&
        item.operation &&
        read?.token.confirmed.get(item.command.operationId) === item.operation.revision &&
        observed(item.operation)
      ) {
        retiredHere.set(item.command.operationId, item.operation.revision);
      }
    }
    const comments = new Map<string, GithubCommentView>();
    const threads = new Map<string, GithubThreadView>();
    const approvals = new Map<string, GithubApprovalView>();
    for (const item of remote.comments) {
      const remoteKey = githubEntityKey(item.ref);
      const localRef = aliasesHere.get(remoteKey);
      comments.set(remoteKey, {
        ...item,
        body: clean(item.body),
        key: localRef ? githubEntityKey(localRef) : remoteKey,
        localRef,
        deleted: false,
        operationIds: [],
        pending: false,
      });
    }
    for (const item of remote.threads) {
      const key = githubEntityKey(item.ref);
      const alias = threadAliasesHere.get(item.ref.nodeId);
      threads.set(key, {
        ...item,
        key: alias ? githubEntityKey(alias) : key,
        operationIds: [],
        pending: false,
      });
    }
    for (const item of remote.approvals)
      approvals.set(`remote:approval:${item.id}`, {
        ...item,
        key: approvalAliasesHere.has(item.id)
          ? `local:approval:${approvalAliasesHere.get(item.id)}`
          : `remote:approval:${item.id}`,
        localOperationId: approvalAliasesHere.get(item.id),
        operationIds: [],
        pending: false,
      });
    const ordered: BrowserGithubOperation[] = [];
    const visited = new Set<string>();
    function visit(item: BrowserGithubOperation) {
      if (visited.has(item.command.operationId)) return;
      visited.add(item.command.operationId);
      for (const dependency of item.command.dependencies) {
        const parent = all.get(dependency);
        if (parent) visit(parent);
      }
      ordered.push(item);
    }
    state.operations.forEach(visit);
    for (const item of ordered) {
      const id = item.command.operationId;
      if (
        item.status === "cancelled" ||
        (item.operation && retiredHere.get(id) === item.operation.revision)
      )
        continue;
      const action = item.command.action;
      const result = item.operation?.result;
      const pending = item.status !== "synced";
      if (
        action.kind === "issue-comment" ||
        action.kind === "inline-comment" ||
        action.kind === "reply"
      ) {
        const kind = action.kind === "issue-comment" ? "issue-comment" : "review-comment";
        const localRef = { source: "local", kind, operationId: id } as const;
        const ref = resolve(localRef) as GithubCommentRef;
        const key = githubEntityKey(ref);
        const prior = comments.get(key);
        const body = result?.kind === kind ? result.body : action.body;
        comments.set(key, {
          ...prior,
          key: githubEntityKey(localRef),
          ref,
          localRef,
          body: clean(body),
          deleted: false,
          operationIds: [id],
          pending,
          action,
          author: item.command.expectedActor,
          confirmed:
            result?.kind === "issue-comment" || result?.kind === "review-comment"
              ? result
              : undefined,
        });
        if (action.kind === "inline-comment") {
          const localThread = { source: "local", kind: "thread", operationId: id } as const;
          const threadRef = resolve(localThread) as GithubThreadRef;
          const threadKey = githubEntityKey(threadRef);
          const priorThread = threads.get(threadKey);
          threads.set(threadKey, {
            ...priorThread,
            key: githubEntityKey(localThread),
            ref: threadRef,
            resolved: priorThread?.resolved ?? false,
            operationIds: [id],
            pending,
          });
        }
      } else if (action.kind === "edit-comment" || action.kind === "delete-comment") {
        const ref = resolve(action.target) as GithubCommentRef;
        const key = githubEntityKey(ref);
        const prior = comments.get(key);
        // Keep a tombstone even when a stale read omitted the target entirely.
        comments.set(key, {
          ...prior,
          ref,
          key: prior?.key ?? key,
          body: clean(
            action.kind === "edit-comment" ? action.body : (prior?.body ?? action.expectedBody),
          ),
          deleted: action.kind === "delete-comment",
          operationIds: [...(prior?.operationIds ?? []), id],
          pending: pending || !!prior?.pending,
          action,
          author:
            prior?.author ??
            (result?.kind === "issue-comment" || result?.kind === "review-comment"
              ? result.author
              : undefined),
          confirmed:
            result?.kind === "issue-comment" || result?.kind === "review-comment"
              ? result
              : prior?.confirmed,
        });
      } else if (action.kind === "resolve-thread" || action.kind === "unresolve-thread") {
        const ref = resolve(action.target) as GithubThreadRef;
        const key = githubEntityKey(ref);
        const prior = threads.get(key);
        threads.set(key, {
          ...prior,
          ref,
          key: prior?.key ?? githubEntityKey(action.target),
          resolved: action.kind === "resolve-thread",
          operationIds: [...(prior?.operationIds ?? []), id],
          pending: pending || !!prior?.pending,
        });
      } else if (action.kind === "approve") {
        const remoteId = result?.kind === "approval" ? result.id : undefined;
        const key = remoteId ? `remote:approval:${remoteId}` : `local:approval:${id}`;
        approvals.set(key, {
          ...approvals.get(key),
          key: `local:approval:${id}`,
          id: remoteId,
          localOperationId: id,
          commitSha: action.expectedHeadSha,
          operationIds: [id],
          pending,
        });
      }
    }
    return {
      comments: [...comments.values()],
      threads: [...threads.values()],
      approvals: [...approvals.values()],
      operations: state.operations,
      pendingCount: state.pendingCount,
      busy: state.busy,
    };
  }
  return { beginRead, acceptRemote, project };
}
