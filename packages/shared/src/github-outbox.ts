/** Durable GitHub writes. All wire values are JSON; timestamps are UTC ISO strings. */
export const DEFAULT_GITHUB_QUEUE_TIMEOUT_MS = 5 * 60_000;
export const MIN_GITHUB_QUEUE_TIMEOUT_MS = 60_000;
export const MAX_GITHUB_QUEUE_TIMEOUT_MS = 60 * 60_000;
export function isGithubQueueTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_GITHUB_QUEUE_TIMEOUT_MS &&
    value <= MAX_GITHUB_QUEUE_TIMEOUT_MS
  );
}
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
  | { kind: "set-draft"; pullRequestId: string; draft: boolean }
  | { kind: "approve"; expectedHeadSha: string; body: string }
  | { kind: "request-changes"; expectedHeadSha: string; body: string }
  | { kind: "review-comment"; expectedHeadSha: string; body: string }
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
  /** Frozen scheduling metadata, excluded from content dedup but included in UUID replay identity. */
  queueDeadlineAt?: string;
  queueTimeoutMs?: number;
}
export interface GithubOutboxAdmissionCycle {
  requestId: string;
  queueTimeoutMs: number;
  queueDeadlineAt: string;
}
export type GithubOutboxAdmissionInput =
  | GithubOutboxCommand
  | { command: GithubOutboxCommand; cycle: GithubOutboxAdmissionCycle };

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
    | "unavailable"
    | "timeout";
  message: string;
  retryable: boolean;
  retryAt?: string;
  /** Numeric HTTP status only; never retain response bodies or headers. */
  httpStatus?: number;
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
  | { kind: "pull-request-draft"; nodeId: string; url: string; draft: boolean }
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
  | {
      kind: "review";
      id: number;
      url: string;
      state: "CHANGES_REQUESTED" | "COMMENTED";
      commitSha: string;
      body: string;
      author: GithubActor;
      submittedAt: string;
    }
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
  queueDeadlineAt?: string;
  timedOutAt?: string;
  /** Dismissed from active queue, not proof of delivery or permission to repost. */
  archivedAt?: string;
}

export interface GithubOutboxSnapshot {
  scope: GithubPrScope;
  /** Monotonic snapshot revision; clients must ignore older snapshots. */
  revision: number;
  operations: GithubOutboxOperation[];
}

/** Read-only global queue discovery. No comment bodies, credentials or actions. */
export interface GithubOutboxPendingScope {
  scope: GithubPrScope;
  revision: number;
  pendingCount: number;
  counts: Record<Exclude<GithubOutboxStatus, "synced" | "cancelled">, number>;
  updatedAt: string;
  blockedByOperationId?: string;
}

/** Admission-only refusal: nothing was accepted or aliased; this UUID may retry later. */
export interface GithubApprovalCooldownError {
  code: "approval-cooldown";
  message: string;
  retryable: true;
  /** Trusted server first-synced timestamp plus the 60-second content window. */
  retryAt: string;
}

export interface GithubReviewCooldownError extends Omit<GithubApprovalCooldownError, "code"> {
  code: "review-cooldown";
}

export type GithubOutboxReceipt =
  /** Content duplicates can return a different canonical operation UUID. The
   * submitted UUID remains a durable alias with its own replay fingerprint. */
  | { outcome: "accepted" | "duplicate"; operation: GithubOutboxOperation }
  | {
      outcome: "rejected";
      operationId: string;
      error: GithubOutboxError | GithubApprovalCooldownError | GithubReviewCooldownError;
    };

interface GithubControlBase {
  requestId: string;
  operationId: string;
  expectedRevision: number;
}
export type GithubOutboxControl = GithubControlBase &
  (
    | { kind: "retry"; queueTimeoutMs?: number; queueDeadlineAt?: string }
    | { kind: "reconcile" | "cancel" }
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

export interface GithubOutboxBatchControl {
  requestId: string;
  kind: "retry" | "clear";
  operations: Array<{ operationId: string; expectedRevision: number }>;
  /** Only clear may include browser intents whose admission acknowledgement was lost. */
  commands?: GithubOutboxCommand[];
  queueTimeoutMs?: number;
  queueDeadlineAt?: string;
}
export type GithubOutboxBatchReceipt =
  | {
      outcome: "applied" | "duplicate";
      operations: GithubOutboxOperation[];
      requiresConfirmation: string[];
      skipped: string[];
      aliases: Record<string, string>;
      localPending?: number;
    }
  | { outcome: "rejected"; error: GithubOutboxError };

/** Optional UI presence; not authorization or a requirement for dispatch. */
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
    case "set-draft":
      return nonempty(value.pullRequestId) && typeof value.draft === "boolean";
    case "approve":
      return sha(value.expectedHeadSha) && text(value.body);
    case "request-changes":
    case "review-comment":
      return sha(value.expectedHeadSha) && text(value.body) && value.body.trim().length > 0;
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
    value.dependencies.includes(value.operationId) ||
    (value.queueDeadlineAt !== undefined &&
      (!text(value.queueDeadlineAt) || !Number.isFinite(Date.parse(value.queueDeadlineAt)))) ||
    (value.queueTimeoutMs !== undefined && !isGithubQueueTimeoutMs(value.queueTimeoutMs))
  )
    return false;
  const action = value.action;
  return (
    !("target" in action && action.target.source === "local") ||
    value.dependencies.includes(action.target.operationId)
  );
}
export function isGithubOutboxAdmissionCycle(value: unknown): value is GithubOutboxAdmissionCycle {
  return (
    record(value) &&
    uuid(value.requestId) &&
    isGithubQueueTimeoutMs(value.queueTimeoutMs) &&
    text(value.queueDeadlineAt) &&
    Number.isFinite(Date.parse(value.queueDeadlineAt))
  );
}
export function isGithubOutboxAdmissionInput(value: unknown): value is GithubOutboxAdmissionInput {
  return (
    isGithubOutboxCommand(value) ||
    (record(value) &&
      isGithubOutboxCommand(value.command) &&
      isGithubOutboxAdmissionCycle(value.cycle))
  );
}

export function isGithubRemoteResult(value: unknown): value is GithubRemoteResult {
  if (!record(value)) return false;
  switch (value.kind) {
    case "pull-request-draft": {
      const parts = text(value.url)
        ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/.exec(value.url)
        : null;
      return (
        nonempty(value.nodeId) &&
        !!parts &&
        isGithubPrScope({
          host: "github.com",
          owner: parts[1],
          repo: parts[2],
          number: Number(parts[3]),
          url: value.url,
        }) &&
        typeof value.draft === "boolean"
      );
    }
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
    case "review":
      return (
        positive(value.id) &&
        text(value.url) &&
        sha(value.commitSha) &&
        (value.state === "CHANGES_REQUESTED" || value.state === "COMMENTED") &&
        text(value.body) &&
        isGithubActor(value.author) &&
        nonempty(value.submittedAt)
      );
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
      return (
        (value.queueTimeoutMs === undefined || isGithubQueueTimeoutMs(value.queueTimeoutMs)) &&
        (value.queueDeadlineAt === undefined ||
          (text(value.queueDeadlineAt) && Number.isFinite(Date.parse(value.queueDeadlineAt))))
      );
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

export function isGithubOutboxBatchControl(value: unknown): value is GithubOutboxBatchControl {
  return (
    record(value) &&
    uuid(value.requestId) &&
    (value.kind === "retry" || value.kind === "clear") &&
    Array.isArray(value.operations) &&
    value.operations.length <= 1_000 &&
    value.operations.every(
      (op) => record(op) && uuid(op.operationId) && positive(op.expectedRevision),
    ) &&
    new Set(value.operations.map((op) => op.operationId)).size === value.operations.length &&
    (value.queueTimeoutMs === undefined || isGithubQueueTimeoutMs(value.queueTimeoutMs)) &&
    (value.queueDeadlineAt === undefined ||
      (text(value.queueDeadlineAt) && Number.isFinite(Date.parse(value.queueDeadlineAt)))) &&
    (value.commands === undefined ||
      (value.kind === "clear" &&
        Array.isArray(value.commands) &&
        value.commands.length <= 1_000 &&
        value.commands.every(isGithubOutboxCommand) &&
        new Set(value.commands.map((command) => command.operationId)).size ===
          value.commands.length))
  );
}

export function isGithubOutboxHeartbeat(value: unknown): value is GithubOutboxHeartbeat {
  return (
    record(value) &&
    uuid(value.clientId) &&
    isGithubPrScope(value.scope) &&
    typeof value.visible === "boolean"
  );
}
