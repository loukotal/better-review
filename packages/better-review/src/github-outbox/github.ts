import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import {
  isGithubOutboxCommand,
  isGithubRemoteResult,
  type GithubActor,
  type GithubCommentKind,
  type GithubOutboxError,
  type GithubOutboxOperation,
  type GithubRemoteResult,
} from "@better-review/shared";

import type { GithubDispatchOutcome, GithubOutboxAdapter, GithubReconcileOutcome } from "./types";

export interface GithubOutboxAdapterOptions {
  /** Defaults to global fetch. All requests are to https://api.github.com. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to Date.now; used only for safe retry timestamps. */
  now?: () => number;
  /** Read current credentials once per top-level call; pin them only for that call. */
  token?: () => Promise<string>;
  /** Defaults to process.env. GH_TOKEN takes precedence over GITHUB_TOKEN, then gh auth token. */
  env?: NodeJS.ProcessEnv;
  /** Bounds each request including reading its body, even if fetch ignores AbortSignal. */
  timeoutMs?: number;
  /** Exhaustion returns conflict, never absence. Defaults to 1000 pages. */
  maxPages?: number;
}

type Json = Record<string, unknown>;
const object = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): v is string => typeof v === "string";
const error = (
  code: GithubOutboxError["code"],
  message: string,
  retryable = false,
): GithubOutboxError => ({ code, message, retryable });
class Failure {
  constructor(
    readonly error: GithubOutboxError,
    readonly uncertain = false,
    readonly status?: number,
  ) {}
}
const invalid = () =>
  new Failure(error("invalid", "GitHub returned invalid or incomplete evidence."));
const markerPattern =
  /<!-- better-review:op:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->/gi;
const marker = (id: string) => `<!-- better-review:op:${id} -->`;
// Only strip the adapter-owned suffix and its separator, never arbitrary user whitespace.
function clean(body: string): string {
  return body.replace(
    /(?:\n\n)?<!-- better-review:op:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/i,
    "",
  );
}
function wire(body: string, id: string): string {
  return body ? `${body}\n\n${marker(id)}` : marker(id);
}
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function defaultToken(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { env, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (cause, stdout) => {
        if (cause || !stdout.trim())
          reject(new Failure(error("auth", "GitHub credentials are unavailable.")));
        else resolve(stdout.trim());
      },
    );
  });
}

/** Direct HTTP adapter. Never logs credentials, persists tokens, or invokes CLI mutations. */
export function createGithubOutboxAdapter(
  options: GithubOutboxAdapterOptions = {},
): GithubOutboxAdapter {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxPages = options.maxPages ?? 1000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  )
    throw new Error("Invalid GitHub adapter limits.");
  const getToken = options.token ?? (() => defaultToken(options.env ?? process.env, timeoutMs));
  // Concurrent account refreshes must not change credentials halfway through an operation.
  const credentials = new AsyncLocalStorage<{
    token?: string;
    invalid?: boolean;
    signal?: AbortSignal;
    beforeMutation?: () => void;
  }>();
  const bound = <T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
    beforeMutation?: () => void,
  ): Promise<T> => credentials.run({ signal, beforeMutation }, run);

  async function request(
    path: string,
    method = "GET",
    payload?: unknown,
    extra: Record<string, string> = {},
  ) {
    // No API-provided next link, user URL, or redirect can receive credentials.
    if (!path.startsWith("/") || path.startsWith("//") || /[\\?#]/.test(path.split("?")[0]!))
      throw invalid();
    const snapshot = credentials.getStore();
    if (!snapshot || snapshot.invalid)
      throw new Failure(error("auth", "GitHub credentials are unavailable."));
    const controller = new AbortController();
    const signal = snapshot.signal
      ? AbortSignal.any([controller.signal, snapshot.signal])
      : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let sent = false;
    const cancelled = () =>
      new Failure(
        error("network", "GitHub request was cancelled or timed out.", true),
        sent && method !== "GET",
      );
    try {
      return await Promise.race([
        (async () => {
          if (signal.aborted) throw cancelled();
          if (!snapshot.token) {
            const token = await getToken();
            if (!token || /[\r\n]/.test(token))
              throw new Failure(error("auth", "GitHub credentials are unavailable."));
            snapshot.token = token;
          }
          // This check is adjacent to fetch: a held preflight/mock ignoring abort must never
          // let an expired worker send a mutation after ownership has been lost.
          if (method !== "GET") snapshot.beforeMutation?.();
          if (signal.aborted) throw cancelled();
          sent = true;
          const response = await fetcher(`https://api.github.com${path}`, {
            method,
            redirect: "error",
            signal,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${snapshot.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
              ...extra,
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          if (!response.ok) {
            if (response.status === 401) snapshot.invalid = true;
            const retryAfter = response.headers.get("retry-after");
            const reset = response.headers.get("x-ratelimit-reset");
            const limited =
              response.status === 429 ||
              (response.status === 403 &&
                (response.headers.get("x-ratelimit-remaining") === "0" || retryAfter !== null));
            const code = limited
              ? "rate-limit"
              : response.status === 401
                ? "auth"
                : response.status === 403
                  ? "permission"
                  : response.status === 409 || response.status === 412
                    ? "conflict"
                    : response.status >= 500
                      ? "unavailable"
                      : "invalid";
            const diagnostic = error(
              code,
              limited
                ? "GitHub rate limit reached."
                : response.status === 401
                  ? "GitHub authentication failed."
                  : response.status === 403
                    ? "GitHub access was denied."
                    : "GitHub rejected the request.",
              limited || response.status >= 500,
            );
            diagnostic.httpStatus = response.status;
            if (limited) {
              const delay =
                retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter)
                  ? now() + Number(retryAfter) * 1000
                  : retryAfter !== null
                    ? Date.parse(retryAfter)
                    : Number(reset) * 1000;
              if (Number.isFinite(delay) && delay > 0)
                diagnostic.retryAt = new Date(Math.max(now(), delay)).toISOString();
            }
            throw new Failure(
              diagnostic,
              method !== "GET" && (response.status >= 500 || response.status === 408),
              response.status,
            );
          }
          if (response.status === 202 || (method === "DELETE" && response.status !== 204))
            throw new Failure(
              error("unavailable", "GitHub has not confirmed completion.", true),
              method !== "GET",
            );
          if (response.status === 204)
            return {
              data: null as unknown,
              etag: response.headers.get("etag"),
              link: response.headers.get("link"),
            };
          try {
            return {
              data: JSON.parse(await response.text()) as unknown,
              etag: response.headers.get("etag"),
              link: response.headers.get("link"),
            };
          } catch {
            throw new Failure(
              error("unavailable", "GitHub returned an unreadable response.", true),
              method !== "GET",
            );
          }
        })(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(cancelled());
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => controller.abort(), timeoutMs);
        }),
      ]);
    } catch (cause) {
      if (cause instanceof Failure) throw cause;
      throw new Failure(
        error(
          sent ? "network" : "auth",
          sent ? "GitHub request failed." : "GitHub credentials are unavailable.",
          sent,
        ),
        sent && method !== "GET",
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async function identity(): ReturnType<GithubOutboxAdapter["identity"]> {
    try {
      const { data } = await request("/user");
      if (!object(data) || !positive(data.id) || !text(data.login) || !data.login) throw invalid();
      return { outcome: "known", actor: { id: data.id, login: data.login } };
    } catch (cause) {
      return {
        outcome: "unavailable",
        error:
          cause instanceof Failure
            ? cause.error
            : error("identity-unknown", "GitHub identity is unavailable.", true),
      };
    }
  }

  function context(operation: GithubOutboxOperation) {
    const command = operation.command;
    if (!isGithubOutboxCommand(command))
      throw new Failure(error("invalid", "Invalid GitHub operation."));
    if (
      ("body" in command.action && command.action.body.match(markerPattern)) ||
      ("expectedBody" in command.action && command.action.expectedBody.match(markerPattern))
    )
      throw new Failure(error("invalid", "Comment text contains a reserved operation marker."));
    if ("target" in command.action && command.action.target.source === "local")
      throw new Failure(error("dependency", "The GitHub target has not been resolved."));
    const { scope } = command;
    const base = `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`;
    return {
      command,
      base,
      pr: `${base}/pulls/${scope.number}`,
      issue: `${base}/issues/${scope.number}`,
    };
  }
  type Ctx = ReturnType<typeof context>;
  type Action = Ctx["command"]["action"];
  type CreationFacts = {
    collection: string;
    candidateCollection: string;
  } & (
    | {
        action: Extract<Action, { kind: "approve" }>;
        resultKind: "approval";
        event: "APPROVE";
        state: "APPROVED";
      }
    | {
        action: Extract<Action, { kind: "request-changes" }>;
        resultKind: "review";
        event: "REQUEST_CHANGES";
        state: "CHANGES_REQUESTED";
      }
    | {
        action: Extract<Action, { kind: "review-comment" }>;
        resultKind: "review";
        event: "COMMENT";
        state: "COMMENTED";
      }
    | { action: Extract<Action, { kind: "issue-comment" }>; resultKind: "issue-comment" }
    | {
        action: Extract<Action, { kind: "inline-comment" | "reply" }>;
        resultKind: "review-comment";
      }
  );
  function creationActionFacts(ctx: Ctx): CreationFacts | undefined {
    const action = ctx.command.action;
    const reviews = `${ctx.pr}/reviews`;
    switch (action.kind) {
      case "approve":
        return {
          action,
          collection: reviews,
          candidateCollection: reviews,
          resultKind: "approval",
          event: "APPROVE",
          state: "APPROVED",
        };
      case "request-changes":
        return {
          action,
          collection: reviews,
          candidateCollection: reviews,
          resultKind: "review",
          event: "REQUEST_CHANGES",
          state: "CHANGES_REQUESTED",
        };
      case "review-comment":
        return {
          action,
          collection: reviews,
          candidateCollection: reviews,
          resultKind: "review",
          event: "COMMENT",
          state: "COMMENTED",
        };
      case "issue-comment":
        return {
          action,
          collection: `${ctx.issue}/comments`,
          candidateCollection: `${ctx.base}/issues/comments`,
          resultKind: "issue-comment",
        };
      case "inline-comment":
      case "reply":
        return {
          action,
          collection: `${ctx.pr}/comments`,
          candidateCollection: `${ctx.base}/pulls/comments`,
          resultKind: "review-comment",
        };
      case "set-draft":
      case "edit-comment":
      case "delete-comment":
      case "resolve-thread":
      case "unresolve-thread":
        return undefined;
    }
    const exhaustive: never = action;
    return exhaustive;
  }

  async function verify(actor: GithubActor) {
    const current = await identity();
    if (current.outcome === "unavailable") throw new Failure(current.error);
    if (current.actor.id !== actor.id)
      throw new Failure(error("identity-mismatch", "The active GitHub account has changed."));
  }
  async function head(ctx: Ctx, expected: string) {
    const { data } = await request(ctx.pr);
    if (!object(data) || !object(data.head) || !text(data.head.sha)) throw invalid();
    if (data.head.sha !== expected)
      throw new Failure(error("head-changed", "The pull request head has changed."));
  }
  async function pages(path: string): Promise<Json[]> {
    const all: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, link } = await request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(data) || !data.every(object)) throw invalid();
      all.push(...data);
      if (!link?.match(/rel="next"/)) {
        // A full page without Link may be an incomplete proxy response; request the next page.
        if (data.length < 100) return all;
      }
    }
    throw new Failure(error("unavailable", "GitHub pagination could not be completed.", true));
  }
  function actorMatches(data: Json, ctx: Ctx) {
    return object(data.user) && data.user.id === ctx.command.expectedActor.id;
  }
  function comment(data: Json, kind: GithubCommentKind): GithubRemoteResult {
    if (
      !positive(data.id) ||
      !text(data.body) ||
      !text(data.html_url) ||
      !data.html_url.startsWith("https://github.com/") ||
      !object(data.user) ||
      !positive(data.user.id) ||
      !text(data.user.login) ||
      !data.user.login ||
      !text(data.created_at) ||
      !data.created_at ||
      !text(data.updated_at) ||
      !data.updated_at
    )
      throw invalid();
    const common = {
      id: data.id,
      url: data.html_url,
      body: clean(data.body),
      author: { id: data.user.id, login: data.user.login },
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      ...(text(data.node_id) ? { nodeId: data.node_id } : {}),
    };
    if (kind === "issue-comment") return { kind, ...common };
    if (
      !text(data.path) ||
      (data.side !== "LEFT" && data.side !== "RIGHT") ||
      !(data.line === null || positive(data.line)) ||
      !(data.original_line === null || positive(data.original_line)) ||
      !text(data.commit_id) ||
      !/^[0-9a-f]{40}$/i.test(data.commit_id) ||
      !(
        data.in_reply_to_id === null ||
        data.in_reply_to_id === undefined ||
        positive(data.in_reply_to_id)
      )
    )
      throw invalid();
    return {
      kind,
      ...common,
      location: {
        path: data.path,
        side: data.side,
        line: data.line,
        originalLine: data.original_line,
        commitSha: data.commit_id,
      },
      ...(positive(data.in_reply_to_id) ? { inReplyToId: data.in_reply_to_id } : {}),
    };
  }
  function belongs(data: Json, kind: GithubCommentKind, ctx: Ctx) {
    const value = data[kind === "issue-comment" ? "issue_url" : "pull_request_url"];
    if (!text(value)) return false;
    try {
      const url = new URL(value);
      if (
        url.origin !== "https://api.github.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return false;
      // Parse the raw path, not URL.pathname, which normalizes dot segments. Decode
      // owner/repo once only; encoded slashes or double-encoded escapes cannot match scope.
      const rawPath = value.match(/^https:\/\/[^/]+(\/[^?#]*)$/i)?.[1];
      const parts = rawPath?.match(/^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/([1-9]\d*)$/);
      return (
        !!parts &&
        decodeURIComponent(parts[1]!).toLowerCase() === ctx.command.scope.owner &&
        decodeURIComponent(parts[2]!).toLowerCase() === ctx.command.scope.repo &&
        parts[3] === (kind === "issue-comment" ? "issues" : "pulls") &&
        parts[4] === String(ctx.command.scope.number)
      );
    } catch {
      return false;
    }
  }
  function targetPath(ctx: Ctx, kind: GithubCommentKind, id: number) {
    return `${ctx.base}/${kind === "issue-comment" ? "issues" : "pulls"}/comments/${id}`;
  }
  async function target(ctx: Ctx, kind: GithubCommentKind, id: number, own = true) {
    const response = await request(targetPath(ctx, kind, id));
    if (!object(response.data) || response.data.id !== id || !belongs(response.data, kind, ctx))
      throw new Failure(
        error("target-changed", "The comment does not belong to this pull request."),
      );
    if (own && !actorMatches(response.data, ctx))
      throw new Failure(error("permission", "The comment belongs to another GitHub account."));
    if (!text(response.data.body)) throw invalid();
    return { ...response, data: response.data, body: clean(response.data.body) };
  }
  async function replyRoot(ctx: Ctx, id: number): Promise<Json> {
    let current = (await target(ctx, "review-comment", id, false)).data;
    const seen = new Set<number>([id]);
    for (let depth = 0; depth < maxPages; depth++) {
      if (current.in_reply_to_id === undefined || current.in_reply_to_id === null) return current;
      if (!positive(current.in_reply_to_id) || seen.has(current.in_reply_to_id)) throw invalid();
      const root = (await target(ctx, "review-comment", current.in_reply_to_id, false)).data;
      if (root.path !== current.path || root.commit_id !== current.commit_id)
        throw new Failure(
          error("target-changed", "The reply parent has conflicting location evidence."),
        );
      seen.add(current.in_reply_to_id);
      current = root;
    }
    throw new Failure(error("unavailable", "The reply parent could not be verified.", true));
  }
  function creationMatch(data: Json, ctx: Ctx, facts: CreationFacts, replyTarget?: Json): boolean {
    const action = facts.action;
    if (
      !actorMatches(data, ctx) ||
      !text(data.body) ||
      !data.body.includes(marker(ctx.command.operationId)) ||
      clean(data.body) !== action.body
    )
      return false;
    switch (facts.resultKind) {
      case "issue-comment":
        return belongs(data, "issue-comment", ctx);
      case "approval":
        return data.state === facts.state && data.commit_id === facts.action.expectedHeadSha;
      case "review":
        return (
          data.state === facts.state &&
          data.commit_id === facts.action.expectedHeadSha &&
          data.body === wire(action.body, ctx.command.operationId)
        );
      case "review-comment": {
        const action = facts.action;
        if (action.kind === "inline-comment") {
          const a = action.anchor;
          return (
            belongs(data, "review-comment", ctx) &&
            data.commit_id === action.expectedHeadSha &&
            (data.in_reply_to_id === null || data.in_reply_to_id === undefined) &&
            data.path === a.path &&
            data.side === a.side &&
            (data.line ?? data.original_line) === a.line &&
            (data.start_line ?? data.original_start_line ?? undefined) === a.startLine &&
            (data.start_side ?? undefined) === a.startSide
          );
        }
        return (
          action.target.source === "remote" &&
          belongs(data, "review-comment", ctx) &&
          replyTarget !== undefined &&
          data.in_reply_to_id === replyTarget.id &&
          text(replyTarget.commit_id) &&
          data.commit_id === replyTarget.commit_id &&
          data.path === replyTarget.path
        );
      }
    }
  }
  function creationResult(data: Json, facts: CreationFacts): GithubRemoteResult {
    if (facts.resultKind === "review") {
      const result = {
        kind: "review",
        id: data.id,
        url: data.html_url,
        state: data.state,
        commitSha: data.commit_id,
        body: text(data.body) ? clean(data.body) : undefined,
        author: object(data.user) ? { id: data.user.id, login: data.user.login } : undefined,
        submittedAt: data.submitted_at,
      };
      if (
        !isGithubRemoteResult(result) ||
        !text(data.html_url) ||
        !data.html_url.startsWith("https://github.com/")
      )
        throw invalid();
      return result;
    }
    if (facts.resultKind === "approval") {
      if (
        !positive(data.id) ||
        !text(data.html_url) ||
        data.commit_id !== facts.action.expectedHeadSha
      )
        throw invalid();
      return { kind: "approval", id: data.id, url: data.html_url, commitSha: data.commit_id };
    }
    return comment(data, facts.resultKind);
  }
  async function graphql(query: string, variables: Json, mutation = false) {
    // GraphQL reads also use POST, but a failed read never implies an uncertain write.
    try {
      const { data } = await request("/graphql", "POST", { query, variables });
      if (!object(data) || data.errors !== undefined || !object(data.data))
        throw new Failure(
          error("unavailable", "GitHub GraphQL evidence is incomplete.", true),
          mutation,
        );
      return data.data;
    } catch (cause) {
      if (!mutation && cause instanceof Failure)
        throw new Failure(cause.error, false, cause.status);
      throw cause;
    }
  }
  async function thread(ctx: Ctx, nodeId: string) {
    const data = await graphql(
      `
        query ($id: ID!) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              id
              isResolved
              pullRequest {
                number
                repository {
                  nameWithOwner
                }
              }
            }
          }
        }
      `,
      { id: nodeId },
    );
    const node = data.node;
    if (
      !object(node) ||
      node.id !== nodeId ||
      typeof node.isResolved !== "boolean" ||
      !object(node.pullRequest) ||
      node.pullRequest.number !== ctx.command.scope.number ||
      !object(node.pullRequest.repository) ||
      !text(node.pullRequest.repository.nameWithOwner) ||
      node.pullRequest.repository.nameWithOwner.toLowerCase() !==
        `${ctx.command.scope.owner}/${ctx.command.scope.repo}`
    )
      throw new Failure(
        error("target-changed", "The thread does not belong to this pull request."),
      );
    return { kind: "thread" as const, nodeId, resolved: node.isResolved };
  }

  function stageResult(ctx: Ctx, node: unknown) {
    const action = ctx.command.action;
    if (
      action.kind !== "set-draft" ||
      !object(node) ||
      node.id !== action.pullRequestId ||
      !text(node.url) ||
      node.url.toLowerCase() !== ctx.command.scope.url
    )
      throw new Failure(error("target-changed", "The pull request identity does not match."));
    if (node.state !== "OPEN")
      throw new Failure(error("target-changed", "The pull request is no longer open."));
    if (typeof node.isDraft !== "boolean") throw invalid();
    return {
      kind: "pull-request-draft" as const,
      nodeId: action.pullRequestId,
      url: ctx.command.scope.url,
      draft: node.isDraft,
    };
  }

  async function stage(ctx: Ctx) {
    const data = await graphql(
      `
        query ($owner: String!, $repo: String!, $number: Int!) {
          viewer {
            databaseId
          }
          repository(owner: $owner, name: $repo) {
            viewerPermission
            pullRequest(number: $number) {
              id
              url
              state
              isDraft
              viewerCanUpdate
              viewerDidAuthor
            }
          }
        }
      `,
      {
        owner: ctx.command.scope.owner,
        repo: ctx.command.scope.repo,
        number: ctx.command.scope.number,
      },
    );
    if (!object(data.viewer) || data.viewer.databaseId !== ctx.command.expectedActor.id)
      throw new Failure(error("identity-mismatch", "The active GitHub account has changed."));
    if (!object(data.repository)) throw invalid();
    const node = data.repository.pullRequest;
    const result = stageResult(ctx, node);
    if (
      !object(node) ||
      node.viewerCanUpdate !== true ||
      !(
        node.viewerDidAuthor === true ||
        ["WRITE", "MAINTAIN", "ADMIN"].includes(String(data.repository.viewerPermission))
      )
    )
      throw new Failure(
        error("permission", "GitHub has not verified permission to change draft status."),
      );
    return result;
  }

  async function enrich(
    result: GithubRemoteResult,
    ctx: Ctx,
    operation: GithubOutboxOperation,
  ): Promise<GithubRemoteResult> {
    if (result.kind !== "review-comment" || operation.status !== "synced") return result;
    try {
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page++) {
        const data = await graphql(
          `
            query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) {
                  reviewThreads(first: 100, after: $cursor) {
                    nodes {
                      id
                      comments(first: 100) {
                        nodes {
                          databaseId
                        }
                        pageInfo {
                          hasNextPage
                          endCursor
                        }
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
              }
            }
          `,
          {
            owner: ctx.command.scope.owner,
            repo: ctx.command.scope.repo,
            number: ctx.command.scope.number,
            cursor,
          },
        );
        const repository = data.repository;
        if (
          !object(repository) ||
          !object(repository.pullRequest) ||
          !object(repository.pullRequest.reviewThreads)
        )
          return result;
        const threads = repository.pullRequest.reviewThreads;
        if (!Array.isArray(threads.nodes) || !object(threads.pageInfo)) return result;
        for (const node of threads.nodes) {
          if (!object(node) || !text(node.id) || !object(node.comments)) continue;
          let comments = node.comments;
          for (let commentPage = 0; commentPage < maxPages; commentPage++) {
            if (!Array.isArray(comments.nodes) || !object(comments.pageInfo)) break;
            if (comments.nodes.some((item) => object(item) && item.databaseId === result.id))
              return { ...result, threadId: node.id };
            if (comments.pageInfo.hasNextPage !== true || !text(comments.pageInfo.endCursor)) break;
            const more = await graphql(
              `
                query ($id: ID!, $cursor: String!) {
                  node(id: $id) {
                    ... on PullRequestReviewThread {
                      comments(first: 100, after: $cursor) {
                        nodes {
                          databaseId
                        }
                        pageInfo {
                          hasNextPage
                          endCursor
                        }
                      }
                    }
                  }
                }
              `,
              { id: node.id, cursor: comments.pageInfo.endCursor },
            );
            if (!object(more.node) || !object(more.node.comments)) break;
            comments = more.node.comments;
          }
        }
        if (threads.pageInfo.hasNextPage !== true || !text(threads.pageInfo.endCursor))
          return result;
        cursor = threads.pageInfo.endCursor;
      }
    } catch {
      /* Enrichment cannot invalidate a confirmed creation. */
    }
    return result;
  }

  async function dispatch(operation: GithubOutboxOperation): Promise<GithubDispatchOutcome> {
    let mutated = false;
    try {
      const ctx = context(operation);
      await verify(ctx.command.expectedActor);
      const action = ctx.command.action;
      if (action.kind === "set-draft") {
        const before = await stage(ctx);
        if (before.draft === action.draft) return { outcome: "accepted", result: before };
        const field = action.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        const data = await graphql(
          `mutation($id:ID!){${field}(input:{pullRequestId:$id}){pullRequest{id url state isDraft}}}`,
          { id: action.pullRequestId },
          true,
        );
        mutated = true;
        const payload = data[field];
        const result = stageResult(ctx, object(payload) ? payload.pullRequest : undefined);
        if (result.draft !== action.draft) throw invalid();
        return { outcome: "accepted", result };
      }
      if (action.kind === "resolve-thread" || action.kind === "unresolve-thread") {
        if (action.target.source !== "remote") throw invalid();
        const before = await thread(ctx, action.target.nodeId);
        const resolved = action.kind === "resolve-thread";
        if (before.resolved === resolved) return { outcome: "accepted", result: before };
        const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
        const data = await graphql(
          `mutation($id:ID!){${field}(input:{threadId:$id}){thread{id isResolved}}}`,
          { id: action.target.nodeId },
          true,
        );
        mutated = true;
        const result = data[field];
        if (
          !object(result) ||
          !object(result.thread) ||
          result.thread.id !== action.target.nodeId ||
          result.thread.isResolved !== resolved
        )
          throw invalid();
        return {
          outcome: "accepted",
          result: { kind: "thread", nodeId: action.target.nodeId, resolved },
        };
      }
      if (action.kind === "edit-comment" || action.kind === "delete-comment") {
        if (action.target.source !== "remote") throw invalid();
        const original = await target(ctx, action.target.kind, action.target.id);
        if (hash(original.body) !== hash(action.expectedBody))
          throw new Failure(
            error("target-changed", "The comment has changed since it was observed."),
          );
        // GitHub comment endpoints do not support conditional unsafe requests:
        // https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests
        // Keep the fresh expectedBody check above, but do not forward the GET ETag.
        // This is an optimistic preflight, not an atomic compare-and-swap.
        const path = targetPath(ctx, action.target.kind, action.target.id);
        if (action.kind === "delete-comment") {
          await request(path, "DELETE");
          mutated = true;
          return { outcome: "accepted", result: { kind: "deleted", target: action.target } };
        }
        const suffix = text(original.data.body)
          ? (original.data.body.match(markerPattern) ?? [])
          : [];
        const body = suffix.length ? `${action.body}\n\n${suffix.join("\n")}` : action.body;
        const { data } = await request(path, "PATCH", { body });
        mutated = true;
        if (
          !object(data) ||
          data.id !== action.target.id ||
          !actorMatches(data, ctx) ||
          !belongs(data, action.target.kind, ctx) ||
          data.body !== body
        )
          throw invalid();
        return { outcome: "accepted", result: comment(data, action.target.kind) };
      }
      const facts = creationActionFacts(ctx);
      if (!facts) throw invalid();
      let path = facts.collection;
      let payload: Json;
      let replyTarget: Json | undefined;
      const body = wire(facts.action.body, ctx.command.operationId);
      switch (facts.resultKind) {
        case "approval":
        case "review":
          await head(ctx, facts.action.expectedHeadSha);
          payload = {
            event: facts.event,
            commit_id: facts.action.expectedHeadSha,
            body,
          };
          break;
        case "issue-comment":
          payload = { body };
          break;
        case "review-comment": {
          const action = facts.action;
          if (action.kind === "reply") {
            if (action.target.source !== "remote") throw invalid();
            replyTarget = await replyRoot(ctx, action.target.id);
            // Replies POST only to the verified root, never to the list collection.
            path = `${ctx.pr}/comments/${replyTarget.id}/replies`;
            payload = { body };
            break;
          }
          await head(ctx, action.expectedHeadSha);
          const a = action.anchor;
          payload = {
            body,
            commit_id: action.expectedHeadSha,
            path: a.path,
            side: a.side,
            line: a.line,
            ...(a.startLine === undefined
              ? {}
              : { start_line: a.startLine, start_side: a.startSide }),
          };
          break;
        }
      }
      const { data } = await request(path, "POST", payload);
      mutated = true;
      if (!object(data) || !creationMatch(data, ctx, facts, replyTarget)) throw invalid();
      return { outcome: "accepted", result: creationResult(data, facts) };
    } catch (cause) {
      const failure = cause instanceof Failure ? cause : invalid();
      return {
        outcome: mutated || failure.uncertain ? "uncertain" : "rejected",
        error: failure.error,
      };
    }
  }

  async function reconcile(
    operation: GithubOutboxOperation,
    verified = false,
  ): Promise<GithubReconcileOutcome> {
    try {
      const ctx = context(operation);
      if (!verified) await verify(ctx.command.expectedActor);
      const action = ctx.command.action;
      if (action.kind === "set-draft") {
        const result = await stage(ctx);
        // Desired state is confirmed, not proof that this operation caused it.
        return result.draft === action.draft
          ? { outcome: "matched", result }
          : {
              outcome: "conflict",
              error: error(
                "target-changed",
                "The pull request is not in the requested draft state.",
              ),
            };
      }
      // Synced delivery is already durable. Enrich its immutable remote identity even
      // after a later edit changed its clean body; uncertain writes still use strict
      // marker + original-body reconciliation below.
      if (
        operation.status === "synced" &&
        (action.kind === "inline-comment" || action.kind === "reply") &&
        operation.result?.kind === "review-comment"
      ) {
        const durable = operation.result;
        if (!isGithubRemoteResult(durable) || durable.author.id !== ctx.command.expectedActor.id)
          throw invalid();
        const found = await target(ctx, "review-comment", durable.id);
        const result = comment(found.data, "review-comment");
        const created = Date.parse(durable.createdAt);
        const updated = Date.parse(durable.updatedAt);
        if (
          result.kind !== "review-comment" ||
          !Number.isFinite(created) ||
          !Number.isFinite(updated) ||
          Date.parse(result.createdAt) !== created ||
          !(Date.parse(result.updatedAt) >= updated) ||
          (durable.nodeId !== undefined && durable.nodeId !== result.nodeId)
        )
          throw new Failure(
            error(
              "target-changed",
              "The confirmed comment has conflicting identity or revision evidence.",
            ),
          );
        return { outcome: "matched", result: await enrich(result, ctx, operation) };
      }
      if (action.kind === "resolve-thread" || action.kind === "unresolve-thread") {
        if (action.target.source !== "remote") throw invalid();
        const result = await thread(ctx, action.target.nodeId);
        return result.resolved === (action.kind === "resolve-thread")
          ? { outcome: "matched", result }
          : {
              outcome: "conflict",
              error: error("target-changed", "The thread is not in the requested state."),
            };
      }
      if (action.kind === "edit-comment" || action.kind === "delete-comment") {
        if (action.target.source !== "remote") throw invalid();
        // A generic GET 404 is not deletion proof. A complete, accessible PR-scoped list is.
        const list = await pages(
          action.target.kind === "issue-comment" ? `${ctx.issue}/comments` : `${ctx.pr}/comments`,
        );
        const targetId = action.target.id;
        const found = list.filter((item) => item.id === targetId);
        if (found.length > 1) throw invalid();
        if (!found.length) {
          return action.kind === "delete-comment"
            ? { outcome: "matched", result: { kind: "deleted", target: action.target } }
            : {
                outcome: "conflict",
                error: error("target-changed", "The edited comment is no longer accessible."),
              };
        }
        const data = found[0]!;
        if (!belongs(data, action.target.kind, ctx) || !actorMatches(data, ctx) || !text(data.body))
          throw invalid();
        const body = clean(data.body);
        if (action.kind === "edit-comment" && body === action.body)
          return { outcome: "matched", result: comment(data, action.target.kind) };
        if (body === action.expectedBody) return { outcome: "absent" };
        return {
          outcome: "conflict",
          error: error("target-changed", "The comment has a different remote version."),
        };
      }
      const facts = creationActionFacts(ctx);
      if (!facts) throw invalid();
      const replyTarget =
        action.kind === "reply" && action.target.source === "remote"
          ? await replyRoot(ctx, action.target.id)
          : undefined;
      const all = await pages(facts.collection);
      const matches = all.filter((data) => creationMatch(data, ctx, facts, replyTarget));
      const results = matches.map((data) => creationResult(data, facts));
      if (results.length > 1) return { outcome: "ambiguous", candidates: results };
      if (results.length === 1)
        return { outcome: "matched", result: await enrich(results[0]!, ctx, operation) };
      // A marker with mismatched evidence must not be reported as clean absence.
      if (
        all.some((data) => text(data.body) && data.body.includes(marker(ctx.command.operationId)))
      )
        return {
          outcome: "conflict",
          error: error("conflict", "The operation marker has conflicting remote evidence."),
        };
      return { outcome: "absent" };
    } catch (cause) {
      const diagnostic =
        cause instanceof Failure
          ? cause.error
          : error("unavailable", "GitHub reconciliation failed.", true);
      return {
        outcome:
          diagnostic.code === "auth" ||
          diagnostic.code === "identity-mismatch" ||
          diagnostic.code === "permission"
            ? "auth"
            : "conflict",
        error: diagnostic,
      };
    }
  }
  async function verifyApplied(
    operation: GithubOutboxOperation,
    candidate: GithubRemoteResult,
  ): Promise<GithubReconcileOutcome> {
    try {
      const ctx = context(operation);
      if (!isGithubRemoteResult(candidate)) throw invalid();
      await verify(ctx.command.expectedActor);
      const action = ctx.command.action;
      if (action.kind === "set-draft") {
        if (
          candidate.kind !== "pull-request-draft" ||
          candidate.nodeId !== action.pullRequestId ||
          candidate.url !== ctx.command.scope.url ||
          candidate.draft !== action.draft
        )
          throw invalid();
        return reconcile(operation, true);
      }
      if (action.kind === "delete-comment") {
        if (
          candidate.kind !== "deleted" ||
          action.target.source !== "remote" ||
          candidate.target.kind !== action.target.kind ||
          candidate.target.id !== action.target.id
        )
          throw invalid();
        return reconcile(operation, true);
      }
      if (action.kind === "resolve-thread" || action.kind === "unresolve-thread") {
        if (
          candidate.kind !== "thread" ||
          action.target.source !== "remote" ||
          candidate.nodeId !== action.target.nodeId
        )
          throw invalid();
        const result = await thread(ctx, action.target.nodeId);
        return result.resolved === (action.kind === "resolve-thread")
          ? { outcome: "matched", result }
          : {
              outcome: "conflict",
              error: error("target-changed", "The thread is not in the requested state."),
            };
      }
      if (action.kind === "edit-comment") {
        if (
          action.target.source !== "remote" ||
          candidate.kind !== action.target.kind ||
          !("id" in candidate) ||
          candidate.id !== action.target.id
        )
          throw invalid();
        const found = await target(ctx, action.target.kind, action.target.id);
        if (found.body !== action.body)
          return {
            outcome: "conflict",
            error: error("target-changed", "The comment is not in the requested state."),
          };
        return { outcome: "matched", result: comment(found.data, action.target.kind) };
      }
      const facts = creationActionFacts(ctx);
      if (!facts || candidate.kind !== facts.resultKind || !("id" in candidate)) throw invalid();
      const path = `${facts.candidateCollection}/${candidate.id}`;
      const replyTarget =
        action.kind === "reply" && action.target.source === "remote"
          ? await replyRoot(ctx, action.target.id)
          : undefined;
      const { data } = await request(path);
      if (
        !object(data) ||
        data.id !== candidate.id ||
        !creationMatch(data, ctx, facts, replyTarget)
      )
        return {
          outcome: "conflict",
          error: error("conflict", "The candidate does not confirm this operation."),
        };
      return {
        outcome: "matched",
        result: await enrich(creationResult(data, facts), ctx, operation),
      };
    } catch (cause) {
      const diagnostic =
        cause instanceof Failure
          ? cause.error
          : error("unavailable", "GitHub verification failed.", true);
      return {
        outcome:
          diagnostic.code === "auth" ||
          diagnostic.code === "identity-mismatch" ||
          diagnostic.code === "permission"
            ? "auth"
            : "conflict",
        error: diagnostic,
      };
    }
  }
  return {
    identity: (options) => bound(identity, options?.signal),
    dispatch: (operation, options) =>
      bound(() => dispatch(operation), options?.signal, options?.beforeMutation),
    reconcile: (operation, options) => bound(() => reconcile(operation), options?.signal),
    verifyApplied: (operation, candidate, options) =>
      bound(() => verifyApplied(operation, candidate), options?.signal),
  };
}
