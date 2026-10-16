/** Durable GitHub writes. All wire values are JSON; timestamps are UTC ISO strings. */
export interface GithubPrScope {
  host: "github.com";
  owner: string;
  repo: string;
  number: number;
  /** Exact canonical https://github.com/{owner}/{repo}/pull/{number}. */
  url: string;
}

export interface GithubActor {
  /** GitHub REST user ID, not login (which can change). */
  id: number;
  login: string;
}

export type GithubCommentKind = "issue-comment" | "review-comment";
export type GithubCommentRef =
  | { source: "remote"; kind: GithubCommentKind; id: number }
  | { source: "local"; kind: GithubCommentKind; operationId: string };
export type GithubThreadRef =
  | { source: "remote"; kind: "thread"; nodeId: string }
  | { source: "local"; kind: "thread"; operationId: string };

export interface GithubInlineAnchor {
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  /** Both start fields must be present together; ranges stay on one side. */
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export type GithubWriteAction =
  | { kind: "approve"; expectedHeadSha: string; body: string }
  | { kind: "issue-comment"; body: string }
  | { kind: "inline-comment"; expectedHeadSha: string; anchor: GithubInlineAnchor; body: string }
  | { kind: "reply"; target: GithubCommentRef & { kind: "review-comment" }; body: string }
  | { kind: "edit-comment"; target: GithubCommentRef; body: string; expectedBody: string }
  | { kind: "delete-comment"; target: GithubCommentRef; expectedBody: string }
  | { kind: "resolve-thread" | "unresolve-thread"; target: GithubThreadRef };

export interface GithubOutboxCommand {
  /** Browser-generated UUID, stable through admission retries and restart. */
  operationId: string;
  scope: GithubPrScope;
  expectedActor: GithubActor;
  action: GithubWriteAction;
  /** Local references must also appear here. Dependencies must belong to this PR/actor. */
  dependencies: string[];
}

export type GithubOutboxStatus =
  | "queued"
  | "inflight"
  | "synced"
  | "retry-failed"
  | "uncertain"
  | "cancelled";

/** Safe user-facing diagnostics only: never CLI output, tokens, headers or raw causes. */
export interface GithubOutboxError {
  code:
    | "identity-unknown"
    | "identity-mismatch"
    | "auth"
    | "permission"
    | "rate-limit"
    | "network"
    | "head-changed"
    | "target-changed"
    | "dependency"
    | "invalid"
    | "conflict"
    | "unavailable";
  message: string;
  retryable: boolean;
  retryAt?: string;
}

interface GithubConfirmedComment {
  id: number;
  nodeId?: string;
  url: string;
  body: string;
  author: GithubActor;
  createdAt: string;
  updatedAt: string;
}

export type GithubRemoteResult =
  | (GithubConfirmedComment & { kind: "issue-comment" })
  | (GithubConfirmedComment & {
      kind: "review-comment";
      location: {
        path: string;
        side: "LEFT" | "RIGHT";
        line: number | null;
        originalLine: number | null;
        commitSha: string;
      };
      inReplyToId?: number;
      /** GraphQL review thread identity, never the comment node ID. May be discovered later. */
      threadId?: string;
    })
  | { kind: "approval"; id: number; url: string; commitSha: string }
  | { kind: "deleted"; target: GithubCommentRef & { source: "remote" } }
  | { kind: "thread"; nodeId: string; resolved: boolean };

export interface GithubOutboxOperation {
  command: GithubOutboxCommand;
  /** Monotonic revision for compare-and-set controls. */
  revision: number;
  /** Durable, monotonic per-PR admission ordering. */
  sequence: number;
  status: GithubOutboxStatus;
  retryMode: "automatic" | "manual" | "blocked";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  error?: GithubOutboxError;
  result?: GithubRemoteResult;
}

export interface GithubOutboxSnapshot {
  scope: GithubPrScope;
  /** Monotonic snapshot revision; clients must ignore older snapshots. */
  revision: number;
  operations: GithubOutboxOperation[];
}

export type GithubOutboxReceipt =
  | { outcome: "accepted" | "duplicate"; operation: GithubOutboxOperation }
  | { outcome: "rejected"; operationId: string; error: GithubOutboxError };

interface GithubControlBase {
  requestId: string;
  operationId: string;
  expectedRevision: number;
}
export type GithubOutboxControl = GithubControlBase &
  (
    | { kind: "retry" | "reconcile" | "cancel" }
    /** Only body changes, never identity/scope/anchor/head. No attempted or uncertain writes. */
    | { kind: "revise"; body: string }
    | {
        kind: "resolve-uncertainty";
        resolution:
          | { kind: "confirm-applied"; result: GithubRemoteResult }
          | { kind: "confirm-not-applied" };
      }
  );
export type GithubOutboxControlReceipt =
  | { outcome: "applied" | "duplicate"; operation: GithubOutboxOperation }
  | { outcome: "rejected"; operationId: string; error: GithubOutboxError };

export interface GithubOutboxHeartbeat {
  clientId: string;
  scope: GithubPrScope;
  visible: boolean;
}

/** IndexedDB admission journal: commit before HTTP; delete only after durable receipt. */
export interface GithubOutboxJournal {
  put(command: GithubOutboxCommand): Promise<void>;
  list(scope?: GithubPrScope): Promise<GithubOutboxCommand[]>;
  remove(operationId: string): Promise<void>;
  close(): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const uuid = (value: unknown): value is string =>
  text(value) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha = (value: unknown): value is string => text(value) && /^[0-9a-f]{40}$/i.test(value);

export function isGithubPrScope(value: unknown): value is GithubPrScope {
  return (
    record(value) &&
    value.host === "github.com" &&
    text(value.owner) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.owner) &&
    text(value.repo) &&
    /^[a-z0-9_.-]+$/.test(value.repo) &&
    value.repo !== "." &&
    value.repo !== ".." &&
    positive(value.number) &&
    value.url === `https://github.com/${value.owner}/${value.repo}/pull/${value.number}`
  );
}

export function isGithubActor(value: unknown): value is GithubActor {
  return record(value) && positive(value.id) && nonempty(value.login);
}

export function isGithubCommentRef(value: unknown): value is GithubCommentRef {
  return (
    record(value) &&
    (value.kind === "issue-comment" || value.kind === "review-comment") &&
    ((value.source === "remote" && positive(value.id)) ||
      (value.source === "local" && uuid(value.operationId)))
  );
}

export function isGithubThreadRef(value: unknown): value is GithubThreadRef {
  return (
    record(value) &&
    value.kind === "thread" &&
    ((value.source === "remote" && nonempty(value.nodeId)) ||
      (value.source === "local" && uuid(value.operationId)))
  );
}

export function isGithubInlineAnchor(value: unknown): value is GithubInlineAnchor {
  return (
    record(value) &&
    nonempty(value.path) &&
    !value.path.startsWith("/") &&
    !value.path.split("/").includes("..") &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    positive(value.line) &&
    ((value.startLine === undefined && value.startSide === undefined) ||
      (positive(value.startLine) &&
        value.startLine <= value.line &&
        value.startSide === value.side))
  );
}

export function isGithubWriteAction(value: unknown): value is GithubWriteAction {
  if (!record(value)) return false;
  switch (value.kind) {
    case "approve":
      return sha(value.expectedHeadSha) && text(value.body);
    case "issue-comment":
      return nonempty(value.body);
    case "inline-comment":
      return (
        sha(value.expectedHeadSha) && isGithubInlineAnchor(value.anchor) && nonempty(value.body)
      );
    case "reply":
      return (
        isGithubCommentRef(value.target) &&
        value.target.kind === "review-comment" &&
        nonempty(value.body)
      );
    case "edit-comment":
      return isGithubCommentRef(value.target) && nonempty(value.body) && text(value.expectedBody);
    case "delete-comment":
      return isGithubCommentRef(value.target) && text(value.expectedBody);
    case "resolve-thread":
    case "unresolve-thread":
      return isGithubThreadRef(value.target);
    default:
      return false;
  }
}

export function isGithubOutboxCommand(value: unknown): value is GithubOutboxCommand {
  if (
    !record(value) ||
    !uuid(value.operationId) ||
    !isGithubPrScope(value.scope) ||
    !isGithubActor(value.expectedActor) ||
    !isGithubWriteAction(value.action) ||
    !Array.isArray(value.dependencies) ||
    !value.dependencies.every(uuid) ||
    new Set(value.dependencies).size !== value.dependencies.length ||
    value.dependencies.includes(value.operationId)
  )
    return false;
  const action = value.action;
  return (
    !("target" in action && action.target.source === "local") ||
    value.dependencies.includes(action.target.operationId)
  );
}

export function isGithubRemoteResult(value: unknown): value is GithubRemoteResult {
  if (!record(value)) return false;
  switch (value.kind) {
    case "issue-comment":
    case "review-comment":
      return (
        positive(value.id) &&
        text(value.url) &&
        text(value.body) &&
        isGithubActor(value.author) &&
        nonempty(value.createdAt) &&
        nonempty(value.updatedAt) &&
        (value.nodeId === undefined || nonempty(value.nodeId)) &&
        (value.kind === "issue-comment" ||
          (record(value.location) &&
            nonempty(value.location.path) &&
            (value.location.side === "LEFT" || value.location.side === "RIGHT") &&
            (value.location.line === null || positive(value.location.line)) &&
            (value.location.originalLine === null || positive(value.location.originalLine)) &&
            sha(value.location.commitSha) &&
            (value.inReplyToId === undefined || positive(value.inReplyToId)) &&
            (value.threadId === undefined || nonempty(value.threadId))))
      );
    case "approval":
      return positive(value.id) && text(value.url) && sha(value.commitSha);
    case "deleted":
      return isGithubCommentRef(value.target) && value.target.source === "remote";
    case "thread":
      return nonempty(value.nodeId) && typeof value.resolved === "boolean";
    default:
      return false;
  }
}

export function isGithubOutboxControl(value: unknown): value is GithubOutboxControl {
  if (
    !record(value) ||
    !uuid(value.requestId) ||
    !uuid(value.operationId) ||
    !positive(value.expectedRevision)
  )
    return false;
  switch (value.kind) {
    case "retry":
    case "reconcile":
    case "cancel":
      return true;
    case "revise":
      return text(value.body);
    case "resolve-uncertainty":
      return (
        record(value.resolution) &&
        (value.resolution.kind === "confirm-not-applied" ||
          (value.resolution.kind === "confirm-applied" &&
            isGithubRemoteResult(value.resolution.result)))
      );
    default:
      return false;
  }
}

export function isGithubOutboxHeartbeat(value: unknown): value is GithubOutboxHeartbeat {
  return (
    record(value) &&
    uuid(value.clientId) &&
    isGithubPrScope(value.scope) &&
    typeof value.visible === "boolean"
  );
}
