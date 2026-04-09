import { Data, Effect, Layer, Schema, ServiceMap } from "effect";

import type {
  PrInfo,
  PrState,
  PrStatus,
  CheckRun,
  ReviewState,
  CiStatus,
  SearchedPr,
  PRComment,
  PrCommit,
  ProjectSummary,
  ProjectBoard,
  ProjectBoardColumn,
  ProjectBoardItem,
  ProjectStatusField,
  ProjectGraphqlRateLimit,
} from "@better-review/shared";

class GhError extends Data.TaggedError("GhError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

// Re-export shared types for convenience
export type {
  PrInfo,
  PrState,
  PrStatus,
  CheckRun,
  ReviewState,
  CiStatus,
  SearchedPr,
  PRComment,
  PrCommit,
  ProjectSummary,
  ProjectBoard,
  ProjectBoardColumn,
  ProjectBoardItem,
  ProjectStatusField,
  ProjectGraphqlRateLimit,
};

// ============================================================================
// Schemas (for runtime validation - types come from @better-review/shared)
// ============================================================================

const parseJsonPreserve =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (json: string): Effect.Effect<Schema.Schema.Type<S>> =>
    Effect.sync(() => Schema.decodeUnknownSync(schema)(JSON.parse(json)));

const UserSchema = Schema.Struct({
  login: Schema.String,
  avatar_url: Schema.String,
});

// Raw comment from GitHub API (without canEdit which is added by the router)
const PRCommentSchema = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  original_line: Schema.NullOr(Schema.Number),
  side: Schema.Literals(["LEFT", "RIGHT"]),
  body: Schema.String,
  html_url: Schema.String,
  user: UserSchema,
  created_at: Schema.String,
  in_reply_to_id: Schema.optional(Schema.Number),
});
/** Raw PR comment from GitHub API (without canEdit) */
export type RawPRComment = typeof PRCommentSchema.Type;

// Issue comments (top-level PR conversation comments)
const IssueCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  html_url: Schema.String,
  user: UserSchema,
  created_at: Schema.String,
  updated_at: Schema.String,
});
/** Raw issue comment from GitHub API (without canEdit) */
export type RawIssueComment = typeof IssueCommentSchema.Type;

export interface AddCommentParams {
  prUrl: string;
  filePath: string;
  line: number;
  body: string;
  side?: "LEFT" | "RIGHT";
}

export interface AddReplyParams {
  prUrl: string;
  commentId: number;
  body: string;
}

export interface EditCommentParams {
  prUrl: string;
  commentId: number;
  body: string;
}

export interface DeleteCommentParams {
  prUrl: string;
  commentId: number;
}

export interface ApprovePrParams {
  prUrl: string;
  body?: string;
}

const PrStateSchema = Schema.Literals(["open", "closed", "merged"]);

const CheckRunSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["queued", "in_progress", "completed", "pending"]),
  conclusion: Schema.NullOr(
    Schema.Literals([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
    ]),
  ),
});

const PrStatusSchema = Schema.Struct({
  state: PrStateSchema,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  url: Schema.String,
  headRef: Schema.String,
  checks: Schema.Array(CheckRunSchema),
});

const ReviewStateSchema = Schema.NullOr(
  Schema.Literals(["PENDING", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
);

const RepositorySchema = Schema.Struct({
  name: Schema.String,
  nameWithOwner: Schema.String,
});

const AuthorSchema = Schema.Struct({
  login: Schema.String,
});

const CiStatusSchema = Schema.Struct({
  passed: Schema.Number,
  total: Schema.Number,
  state: Schema.Literals(["SUCCESS", "FAILURE", "PENDING", "EXPECTED", "ERROR", "NEUTRAL"]),
});

const SearchedPrSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  repository: RepositorySchema,
  author: AuthorSchema,
  createdAt: Schema.String,
  isDraft: Schema.Boolean,
  myReviewState: ReviewStateSchema,
  isAuthor: Schema.Boolean,
  reviewRequested: Schema.Boolean,
  additions: Schema.Number,
  deletions: Schema.Number,
  ciStatus: Schema.NullOr(CiStatusSchema),
});

// ============================================================================
// Internal API Response Schemas
// ============================================================================

// Schema for getPrStatus API response (before transformation)
const PrDataResponseSchema = Schema.Struct({
  state: Schema.String,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  author: Schema.String,
  merged: Schema.Boolean,
  html_url: Schema.String,
  head_ref: Schema.String,
  head_sha: Schema.String,
});

// Schema for raw commit from listCommits API
const RawCommitSchema = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.Struct({ date: Schema.String }),
  }),
  author: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      avatar_url: Schema.String,
    }),
  ),
});

// Schema for GraphQL PR in searchReviewRequested
const GraphQLReviewSchema = Schema.Struct({
  author: Schema.Struct({ login: Schema.String }),
  state: Schema.String,
});

const GraphQLPrSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  repository: Schema.Struct({
    name: Schema.String,
    nameWithOwner: Schema.String,
  }),
  author: Schema.Struct({ login: Schema.String }),
  reviews: Schema.Struct({ nodes: Schema.Array(GraphQLReviewSchema) }),
});

const GraphQLSearchResponseSchema = Schema.Struct({
  data: Schema.Struct({
    requested: Schema.Struct({
      nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)),
    }),
    reviewed: Schema.Struct({
      nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)),
    }),
    authored: Schema.Struct({
      nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)),
    }),
  }),
});

export interface ResolveThreadParams {
  prUrl: string;
  /** The GraphQL node_id of a comment in the thread */
  threadNodeId: string;
}

export interface AddIssueCommentParams {
  prUrl: string;
  body: string;
}

export interface MoveProjectItemParams {
  owner: string;
  number: number;
  itemId: string;
  statusOptionId: string | null;
  projectId?: string;
  statusFieldId?: string;
}

/** GhCli methods */
interface GhCli {
  getDiff: (urlOrNumber: string) => Effect.Effect<string, GhError, never>;
  getPrInfo: (urlOrNumber: string) => Effect.Effect<PrInfo, GhError, never>;
  getPrStatus: (urlOrNumber: string) => Effect.Effect<PrStatus, GhError, never>;
  listComments: (prUrl: string) => Effect.Effect<readonly RawPRComment[], GhError, never>;
  listIssueComments: (prUrl: string) => Effect.Effect<readonly RawIssueComment[], GhError, never>;
  addComment: (params: AddCommentParams) => Effect.Effect<RawPRComment, GhError, never>;
  addIssueComment: (
    params: AddIssueCommentParams,
  ) => Effect.Effect<RawIssueComment, GhError, never>;
  replyToComment: (params: AddReplyParams) => Effect.Effect<RawPRComment, GhError, never>;
  editComment: (params: EditCommentParams) => Effect.Effect<RawPRComment, GhError, never>;
  editIssueComment: (params: EditCommentParams) => Effect.Effect<RawIssueComment, GhError, never>;
  deleteComment: (params: DeleteCommentParams) => Effect.Effect<void, GhError, never>;
  deleteIssueComment: (params: DeleteCommentParams) => Effect.Effect<void, GhError, never>;
  getCurrentUser: () => Effect.Effect<string, GhError, never>;
  /** Get review thread node IDs and resolution state for a PR */
  getReviewThreads: (
    prUrl: string,
  ) => Effect.Effect<
    readonly { threadId: string; isResolved: boolean; commentNodeIds: string[] }[],
    GhError,
    never
  >;
  resolveThread: (params: ResolveThreadParams) => Effect.Effect<void, GhError, never>;
  unresolveThread: (params: ResolveThreadParams) => Effect.Effect<void, GhError, never>;
  approvePr: (params: ApprovePrParams) => Effect.Effect<void, GhError, never>;
  searchReviewRequested: () => Effect.Effect<readonly SearchedPr[], GhError, never>;
  listProjects: (owner: string) => Effect.Effect<readonly ProjectSummary[], GhError, never>;
  getProjectBoard: (
    owner: string,
    number: number,
    itemQuery?: string,
  ) => Effect.Effect<ProjectBoard, GhError, never>;
  moveProjectItem: (params: MoveProjectItemParams) => Effect.Effect<void, GhError, never>;
  getProjectGraphqlRateLimit: () => Effect.Effect<ProjectGraphqlRateLimit, GhError, never>;
  listCommits: (prUrl: string) => Effect.Effect<readonly PrCommit[], GhError, never>;
  getCommitDiff: (params: {
    owner: string;
    repo: string;
    sha: string;
  }) => Effect.Effect<string, GhError, never>;
  getPrCiStatus: (prUrl: string) => Effect.Effect<CiStatus | null, GhError, never>;
  getHeadSha: (prUrl: string) => Effect.Effect<string, GhError, never>;
  getBaseSha: (prUrl: string) => Effect.Effect<string, GhError, never>;
  /** Fetch raw file content at a specific git ref. Returns null if file doesn't exist at that ref. */
  getFileContent: (params: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }) => Effect.Effect<string | null, GhError, never>;
}

export type GhServiceApi = GhCli;

const GH_COMMAND_TIMEOUT_MS = Number(process.env.GH_COMMAND_TIMEOUT_MS ?? 45_000);

const runGh = (...args: string[]) =>
  Effect.tryPromise(async () => {
    const process = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, GH_COMMAND_TIMEOUT_MS);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);

      if (timedOut) {
        throw new Error(
          `gh command timed out after ${GH_COMMAND_TIMEOUT_MS}ms: gh ${args.join(" ")}`,
        );
      }

      if (code !== 0) {
        throw new Error(stderr.trim() || stdout.trim() || `gh exited with code ${code}`);
      }

      return stdout;
    } finally {
      clearTimeout(timeout);
    }
  });

// Validate it's a PR number or valid PR URL (not an issue URL)
const validatePrUrl = (url: string): Effect.Effect<void, GhError> => {
  // Pure number is valid (PR number)
  if (/^\d+$/.test(url.trim())) {
    return Effect.void;
  }
  if (/^.+\/pull\/\d+/.test(url)) {
    return Effect.void;
  }
  return Effect.fail(
    new GhError({
      command: "validateUrl",
      cause: "Invalid pull request URL/number. E.g. github.com/john/demo/pull/12582",
    }),
  );
};

// Parse PR URL or get repo info from gh CLI
const getPrInfo = (urlOrNumber: string) =>
  Effect.gen(function* () {
    yield* validatePrUrl(urlOrNumber);

    // If it's a full URL, parse it
    const urlMatch = urlOrNumber.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (urlMatch) {
      return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };
    }

    // Otherwise, use gh to get the repo info from the current directory
    const repoInfo = (yield* runGh(
      "repo",
      "view",
      "--json",
      "owner,name",
      "--jq",
      '.owner.login + "/" + .name',
    )).trim();
    const [owner, repo] = repoInfo.split("/");

    return { owner, repo, number: urlOrNumber };
  });

const toCamelCase = (value: string): string => {
  if (!value) return "";
  return value.charAt(0).toLowerCase() + value.slice(1);
};

const normalizeOwner = (owner: string): string => {
  const trimmed = owner.trim();
  return trimmed.length > 0 ? trimmed : "@me";
};

const parseJsonUnknown = (json: string): Effect.Effect<unknown, GhError> =>
  Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: (cause) => new GhError({ command: "parseJson", cause }),
  });

const toProjectSummary = (raw: unknown): ProjectSummary | null => {
  if (!raw || typeof raw !== "object") return null;
  const project = raw as Record<string, unknown>;
  const owner =
    project.owner && typeof project.owner === "object"
      ? (project.owner as Record<string, unknown>)
      : null;

  const id = typeof project.id === "string" ? project.id : null;
  const number = typeof project.number === "number" ? project.number : null;
  const title = typeof project.title === "string" ? project.title : null;
  const url = typeof project.url === "string" ? project.url : null;
  const closed = typeof project.closed === "boolean" ? project.closed : false;
  const ownerLogin = owner && typeof owner.login === "string" ? owner.login : null;
  const ownerType = owner && typeof owner.type === "string" ? owner.type : null;

  if (!id || number === null || !title || !url || !ownerLogin || !ownerType) {
    return null;
  }

  return {
    id,
    number,
    title,
    url,
    closed,
    owner: {
      login: ownerLogin,
      type: ownerType,
    },
  };
};

const toProjectStatusField = (rawFields: unknown[]): ProjectStatusField | null => {
  const normalized = rawFields
    .map((field) => {
      if (!field || typeof field !== "object") return null;
      const f = field as Record<string, unknown>;
      const id = typeof f.id === "string" ? f.id : null;
      const name = typeof f.name === "string" ? f.name : null;
      const optionsRaw = Array.isArray(f.options) ? f.options : null;
      if (!id || !name || !optionsRaw) return null;

      const options = optionsRaw
        .map((opt) => {
          if (!opt || typeof opt !== "object") return null;
          const o = opt as Record<string, unknown>;
          const optionId = typeof o.id === "string" ? o.id : null;
          const optionName = typeof o.name === "string" ? o.name : null;
          if (!optionId || !optionName) return null;
          return { id: optionId, name: optionName };
        })
        .filter((opt): opt is { id: string; name: string } => opt !== null);

      if (options.length === 0) return null;

      return {
        id,
        name,
        key: toCamelCase(name),
        options,
      } satisfies ProjectStatusField;
    })
    .filter((field): field is ProjectStatusField => field !== null);

  if (normalized.length === 0) return null;

  return (
    normalized.find((field) => field.name.toLowerCase() === "status") ??
    normalized.find((field) => field.key === "status") ??
    normalized[0]
  );
};

const findField = (
  rawFields: unknown[],
  matcher: (fieldName: string) => boolean,
): { key: string; name: string } | null => {
  for (const field of rawFields) {
    if (!field || typeof field !== "object") continue;
    const record = field as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    if (!name) continue;
    if (matcher(name.trim().toLowerCase())) {
      return { key: toCamelCase(name), name };
    }
  }
  return null;
};

const findFieldKey = (
  rawFields: unknown[],
  matcher: (fieldName: string) => boolean,
): string | null => findField(rawFields, matcher)?.key ?? null;

const toStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
};

const toProjectFieldDisplay = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => toProjectFieldDisplay(entry))
      .filter((entry): entry is string => !!entry);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const titled = typeof record.title === "string" ? record.title.trim() : "";
    if (titled.length > 0) return titled;

    const named = typeof record.name === "string" ? record.name.trim() : "";
    if (named.length > 0) return named;

    const startDate = typeof record.startDate === "string" ? record.startDate.trim() : "";
    if (startDate.length > 0) return startDate;
  }

  return null;
};

const getUnknownErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const isUnsupportedProjectItemQueryError = (errorMessage: string): boolean => {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("unknown flag: --query") ||
    normalized.includes("`--query` flag is not supported on this github host")
  );
};

const normalizeProjectQueryFieldName = (fieldName: string): string =>
  fieldName.toLowerCase().replace(/[\s_\-"]/g, "");

const isTargetWeekLteNextQuery = (query: string, targetWeekFieldName: string | null): boolean => {
  const trimmed = query.trim();
  if (!trimmed.endsWith(":<=@next")) return false;

  const fieldPart = trimmed.slice(0, -":<=@next".length).replace(/^"|"$/g, "");
  const normalizedFieldPart = normalizeProjectQueryFieldName(fieldPart);

  if (normalizedFieldPart === "targetweek") return true;

  if (targetWeekFieldName) {
    return normalizedFieldPart === normalizeProjectQueryFieldName(targetWeekFieldName);
  }

  return false;
};

const parseIsoDateOnlyUtc = (raw: string): Date | null => {
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(Date.UTC(year, month - 1, day));
};

const resolveTargetWeekStartDate = (value: unknown): Date | null => {
  if (!value) return null;

  if (typeof value === "string") {
    const date = parseIsoDateOnlyUtc(value);
    if (date) return date;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const startDate = typeof record.startDate === "string" ? record.startDate : null;
    if (startDate) {
      const parsedStartDate = parseIsoDateOnlyUtc(startDate) ?? new Date(startDate);
      if (!Number.isNaN(parsedStartDate.getTime())) return parsedStartDate;
    }
  }

  return null;
};

const isTargetWeekAtOrBeforeNext = (value: unknown): boolean => {
  const targetDate = resolveTargetWeekStartDate(value);
  if (!targetDate) return false;

  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7, 23, 59, 59, 999),
  );

  return targetDate.getTime() <= cutoff.getTime();
};

const filterProjectItemsByQuery = (
  itemsRaw: unknown[],
  itemQuery: string,
  targetWeekKey: string | null,
  targetWeekFieldName: string | null,
): unknown[] => {
  if (!itemQuery.trim()) return itemsRaw;

  if (!isTargetWeekLteNextQuery(itemQuery, targetWeekFieldName)) {
    return itemsRaw;
  }

  if (!targetWeekKey) {
    return [];
  }

  return itemsRaw.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return isTargetWeekAtOrBeforeNext(record[targetWeekKey]);
  });
};

const toProjectBoardItem = (
  raw: unknown,
  statusKey: string | null,
  assigneesKey: string | null,
  targetWeekKey: string | null,
): ProjectBoardItem | null => {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : null;
  if (!id) return null;

  const rawStatus = statusKey ? item[statusKey] : null;
  const status = typeof rawStatus === "string" ? rawStatus : null;

  const assignees = assigneesKey ? toStringList(item[assigneesKey]) : [];

  const targetWeek = targetWeekKey ? toProjectFieldDisplay(item[targetWeekKey]) : null;

  const contentRaw =
    item.content && typeof item.content === "object"
      ? (item.content as Record<string, unknown>)
      : null;

  const content = contentRaw
    ? {
        type: typeof contentRaw.type === "string" ? contentRaw.type : "Unknown",
        title: typeof contentRaw.title === "string" ? contentRaw.title : "Untitled",
        body: typeof contentRaw.body === "string" ? contentRaw.body : null,
        url: typeof contentRaw.url === "string" ? contentRaw.url : null,
        number: typeof contentRaw.number === "number" ? contentRaw.number : null,
        repository: typeof contentRaw.repository === "string" ? contentRaw.repository : null,
      }
    : null;

  return {
    id,
    status,
    targetWeek,
    assignees,
    content,
  };
};

const toProjectGraphqlRateLimit = (raw: unknown): ProjectGraphqlRateLimit | null => {
  if (!raw || typeof raw !== "object") return null;
  const limit =
    typeof (raw as { limit?: unknown }).limit === "number"
      ? (raw as { limit: number }).limit
      : null;
  const remaining =
    typeof (raw as { remaining?: unknown }).remaining === "number"
      ? (raw as { remaining: number }).remaining
      : null;
  const used =
    typeof (raw as { used?: unknown }).used === "number" ? (raw as { used: number }).used : null;
  const reset =
    typeof (raw as { reset?: unknown }).reset === "number"
      ? (raw as { reset: number }).reset
      : null;

  if (limit === null || remaining === null || used === null || reset === null) {
    return null;
  }

  return {
    limit,
    remaining,
    used,
    reset,
    resetAt: new Date(reset * 1000).toISOString(),
  };
};

const ghCli: GhCli = {
  getPrInfo: (urlOrNumber: string) =>
    getPrInfo(urlOrNumber).pipe(
      Effect.mapError((cause) => new GhError({ command: "getPrInfo", cause })),
      Effect.withSpan("GhService.getPrInfo", { attributes: { urlOrNumber } }),
    ),

  getDiff: (urlOrNumber: string) =>
    Effect.gen(function* () {
      yield* validatePrUrl(urlOrNumber);
      return yield* runGh("pr", "diff", urlOrNumber);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getDiff", cause })),
      Effect.withSpan("GhService.getDiff", { attributes: { urlOrNumber } }),
    ),

  getPrStatus: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(urlOrNumber);

      // Get PR details
      const prResult = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        "{ state, draft, mergeable, title, body, author: .user.login, merged: .merged, html_url, head_ref: .head.ref, head_sha: .head.sha }",
      )).trim();
      if (!prResult) {
        return yield* Effect.fail(new GhError({ command: "getPrStatus", cause: "PR not found" }));
      }
      const prData = yield* parseJsonPreserve(PrDataResponseSchema)(prResult);

      // Get check runs for the PR's head commit (using head_sha from PR data above)
      const checksResult = yield* runGh(
        "api",
        `repos/${owner}/${repo}/commits/${prData.head_sha}/check-runs`,
        "--jq",
        ".check_runs | map({ name, status, conclusion })",
      ).pipe(Effect.catch(() => Effect.succeed("[]")));
      const checks = yield* parseJsonPreserve(Schema.Array(CheckRunSchema))(checksResult);

      // Determine actual state (open/closed/merged)
      const state = prData.merged ? "merged" : prData.state;

      return Schema.decodeUnknownSync(PrStatusSchema)({
        state,
        draft: prData.draft,
        mergeable: prData.mergeable,
        title: prData.title,
        body: prData.body ?? "",
        author: prData.author,
        url: prData.html_url,
        headRef: prData.head_ref,
        checks,
      });
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getPrStatus", cause })),
      Effect.withSpan("GhService.getPrStatus", { attributes: { urlOrNumber } }),
    ),

  listComments: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(urlOrNumber);
      const result = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}/comments`,
        "--jq",
        ".",
      )).trim();
      if (!result) return [];
      return yield* parseJsonPreserve(Schema.Array(PRCommentSchema))(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getComments", cause })),
      Effect.withSpan("GhService.getComments", { attributes: { urlOrNumber } }),
    ),

  listIssueComments: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(urlOrNumber);
      // PRs are issues in GitHub's API, so we use the issues endpoint for top-level comments
      const result = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "--jq",
        ".",
      )).trim();
      if (!result) return [];
      return yield* parseJsonPreserve(Schema.Array(IssueCommentSchema))(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getIssueComments", cause })),
      Effect.withSpan("GhService.getIssueComments", {
        attributes: { urlOrNumber },
      }),
    ),

  addIssueComment: (params: AddIssueCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      // Use the issues endpoint for top-level PR comments
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-f",
        `body=${params.body}`,
      );
      return yield* parseJsonPreserve(IssueCommentSchema)(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "addIssueComment", cause })),
      Effect.withSpan("GhService.addIssueComment", {
        attributes: {
          prUrl: params.prUrl,
        },
      }),
    ),

  addComment: (params: AddCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      // Get the HEAD commit SHA
      const commitSha = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        ".head.sha",
      )).trim();

      // Create a PR review comment
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}/comments`,
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-f",
        `body=${params.body}`,
        "-f",
        `commit_id=${commitSha}`,
        "-f",
        `path=${params.filePath}`,
        "-F",
        `line=${params.line}`,
        "-f",
        `side=${params.side ?? "RIGHT"}`,
      );
      return yield* parseJsonPreserve(PRCommentSchema)(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "addComment", cause })),
      Effect.withSpan("GhService.addComment", {
        attributes: {
          prUrl: params.prUrl,
          filePath: params.filePath,
          line: params.line,
        },
      }),
    ),

  replyToComment: (params: AddReplyParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      // Use the dedicated reply endpoint
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}/comments/${params.commentId}/replies`,
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-f",
        `body=${params.body}`,
      );
      return yield* parseJsonPreserve(PRCommentSchema)(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "replyToComment", cause })),
      Effect.withSpan("GhService.replyToComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
    ),

  editComment: (params: EditCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      // Use gh api with field flag for the body
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/comments/${params.commentId}`,
        "-X",
        "PATCH",
        "-f",
        `body=${params.body}`,
      );
      return yield* parseJsonPreserve(PRCommentSchema)(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "editComment", cause })),
      Effect.withSpan("GhService.editComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
    ),

  deleteComment: (params: DeleteCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/comments/${params.commentId}`,
        "-X",
        "DELETE",
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "deleteComment", cause })),
      Effect.withSpan("GhService.deleteComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
    ),

  editIssueComment: (params: EditCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      // Issue comments use a different endpoint than PR review comments
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/issues/comments/${params.commentId}`,
        "-X",
        "PATCH",
        "-f",
        `body=${params.body}`,
      );
      return yield* parseJsonPreserve(IssueCommentSchema)(result);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "editIssueComment", cause })),
      Effect.withSpan("GhService.editIssueComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
    ),

  deleteIssueComment: (params: DeleteCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      yield* runGh(
        "api",
        `repos/${owner}/${repo}/issues/comments/${params.commentId}`,
        "-X",
        "DELETE",
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "deleteIssueComment", cause })),
      Effect.withSpan("GhService.deleteIssueComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
    ),

  getCurrentUser: () =>
    Effect.gen(function* () {
      return (yield* runGh("api", "user", "--jq", ".login")).trim();
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getCurrentUser", cause })),
      Effect.withSpan("GhService.getCurrentUser"),
    ),

  getReviewThreads: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);

      // GraphQL query to fetch all review threads with their comment node IDs and resolution state
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 100) {
                    nodes {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const result = yield* runGh(
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `number=${number}`,
      );
      type ReviewThreadsPayload = {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  id: string;
                  isResolved: boolean;
                  comments: { nodes: Array<{ id: string }> };
                }>;
              };
            };
          };
        };
      };
      const data = yield* Effect.sync(() => JSON.parse(result) as ReviewThreadsPayload);

      const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

      return threads.map(
        (t: { id: string; isResolved: boolean; comments: { nodes: { id: string }[] } }) => ({
          threadId: t.id,
          isResolved: t.isResolved,
          commentNodeIds: t.comments.nodes.map((c: { id: string }) => c.id),
        }),
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getReviewThreads", cause })),
      Effect.withSpan("GhService.getReviewThreads", { attributes: { prUrl } }),
    ),

  resolveThread: (params: ResolveThreadParams) =>
    Effect.gen(function* () {
      const mutation = `
        mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }
      `;

      yield* Effect.tryPromise(() =>
        Bun.$`gh api graphql -f query=${mutation} -f threadId=${params.threadNodeId}`.text(),
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "resolveThread", cause })),
      Effect.withSpan("GhService.resolveThread", {
        attributes: { threadNodeId: params.threadNodeId },
      }),
    ),

  unresolveThread: (params: ResolveThreadParams) =>
    Effect.gen(function* () {
      const mutation = `
        mutation($threadId: ID!) {
          unresolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }
      `;

      yield* Effect.tryPromise(() =>
        Bun.$`gh api graphql -f query=${mutation} -f threadId=${params.threadNodeId}`.text(),
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "unresolveThread", cause })),
      Effect.withSpan("GhService.unresolveThread", {
        attributes: { threadNodeId: params.threadNodeId },
      }),
    ),

  approvePr: (params: ApprovePrParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      const args = [
        "api",
        `repos/${owner}/${repo}/pulls/${number}/reviews`,
        "-X",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-f",
        "event=APPROVE",
      ];

      if (params.body !== undefined) {
        args.push("-f", `body=${params.body}`);
      }

      yield* runGh(...args);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "approvePr", cause })),
      Effect.withSpan("GhService.approvePr", {
        attributes: { prUrl: params.prUrl },
      }),
    ),

  listCommits: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);
      const result = yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}/commits`,
        "--jq",
        ".",
      );
      const rawCommits = yield* parseJsonPreserve(Schema.Array(RawCommitSchema))(result);

      return rawCommits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: {
          login: c.author?.login ?? "unknown",
          avatar_url: c.author?.avatar_url ?? "",
        },
        date: c.commit.author.date,
      })) satisfies readonly PrCommit[];
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "listCommits", cause })),
      Effect.withSpan("GhService.listCommits", { attributes: { prUrl } }),
    ),

  getCommitDiff: (params: { owner: string; repo: string; sha: string }) =>
    Effect.gen(function* () {
      // Use Accept header to get diff format
      return yield* runGh(
        "api",
        `repos/${params.owner}/${params.repo}/commits/${params.sha}`,
        "-H",
        "Accept: application/vnd.github.diff",
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getCommitDiff", cause })),
      Effect.withSpan("GhService.getCommitDiff", {
        attributes: { sha: params.sha },
      }),
    ),

  searchReviewRequested: () =>
    Effect.gen(function* () {
      // Get current user login
      const currentUser = (yield* runGh("api", "user", "--jq", ".login")).trim();

      // GraphQL query to get PRs with review state, CI status, and line counts
      const prFields = `
        number
        title
        url
        isDraft
        createdAt
        additions
        deletions
        repository { name, nameWithOwner }
        author { login }
        reviews(last: 20) {
          nodes { author { login }, state }
        }

      `;

      const query = `
        query($requestedQuery: String!, $reviewedQuery: String!, $authoredQuery: String!) {
          requested: search(query: $requestedQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest { ${prFields} }
            }
          }
          reviewed: search(query: $reviewedQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest { ${prFields} }
            }
          }
          authored: search(query: $authoredQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest { ${prFields} }
            }
          }
        }
      `;

      const result = yield* runGh(
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        "requestedQuery=is:pr is:open review-requested:@me",
        "-f",
        "reviewedQuery=is:pr is:open reviewed-by:@me",
        "-f",
        "authoredQuery=is:pr is:open author:@me",
      );
      const data = yield* parseJsonPreserve(GraphQLSearchResponseSchema)(result);

      type GraphQLPr = typeof GraphQLPrSchema.Type;

      // Helper to get user's latest review state
      const getMyReviewState = (pr: GraphQLPr): ReviewState => {
        const myReviews = pr.reviews.nodes.filter((r) => r.author.login === currentUser);
        if (myReviews.length === 0) return null;
        // Return the last review state
        return myReviews[myReviews.length - 1].state as ReviewState;
      };

      // Track which PRs came from which query
      const requestedUrls = new Set(
        data.data.requested.nodes.filter((pr): pr is GraphQLPr => pr !== null).map((pr) => pr.url),
      );

      // Helper to convert GraphQL PR to SearchedPr (ciStatus loaded lazily)
      const toSearchedPr = (pr: GraphQLPr) =>
        Schema.decodeUnknownSync(SearchedPrSchema)({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          isDraft: pr.isDraft,
          createdAt: pr.createdAt,
          additions: pr.additions,
          deletions: pr.deletions,
          repository: pr.repository,
          author: pr.author,
          myReviewState: getMyReviewState(pr),
          isAuthor: pr.author.login === currentUser,
          reviewRequested: requestedUrls.has(pr.url),
          ciStatus: null, // Loaded lazily via /api/prs/ci-status
        });

      // Merge and deduplicate by URL
      const seen = new Set<string>();
      const merged: SearchedPr[] = [];

      for (const pr of data.data.requested.nodes) {
        if (pr && !seen.has(pr.url)) {
          seen.add(pr.url);
          merged.push(toSearchedPr(pr));
        }
      }

      for (const pr of data.data.reviewed.nodes) {
        if (pr && !seen.has(pr.url)) {
          seen.add(pr.url);
          merged.push(toSearchedPr(pr));
        }
      }

      for (const pr of data.data.authored.nodes) {
        if (pr && !seen.has(pr.url)) {
          seen.add(pr.url);
          merged.push(toSearchedPr(pr));
        }
      }

      // Sort by createdAt descending (newest first)
      merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return merged;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "searchReviewRequested", cause })),
      Effect.withSpan("GhService.searchReviewRequested"),
    ),

  listProjects: (owner: string) =>
    Effect.gen(function* () {
      const normalizedOwner = normalizeOwner(owner);
      const result = yield* runGh(
        "project",
        "list",
        "--owner",
        normalizedOwner,
        "--limit",
        "100",
        "--format",
        "json",
      );

      const parsed = yield* parseJsonUnknown(result);
      const projectsRaw =
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { projects?: unknown[] }).projects)
          ? ((parsed as { projects: unknown[] }).projects ?? [])
          : [];

      return projectsRaw
        .map(toProjectSummary)
        .filter((project): project is ProjectSummary => project !== null)
        .sort((a, b) => {
          if (a.closed !== b.closed) return a.closed ? 1 : -1;
          return a.number - b.number;
        });
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "listProjects", cause })),
      Effect.withSpan("GhService.listProjects", { attributes: { owner } }),
    ),

  getProjectBoard: (owner: string, number: number, itemQuery?: string) =>
    Effect.gen(function* () {
      const normalizedOwner = normalizeOwner(owner);

      const [viewResult, fieldsResult] = yield* Effect.all(
        [
          runGh("project", "view", String(number), "--owner", normalizedOwner, "--format", "json"),
          runGh(
            "project",
            "field-list",
            String(number),
            "--owner",
            normalizedOwner,
            "--limit",
            "100",
            "--format",
            "json",
          ),
        ],
        { concurrency: "unbounded" },
      );

      const parsedView = yield* parseJsonUnknown(viewResult);
      const parsedFields = yield* parseJsonUnknown(fieldsResult);

      const project = toProjectSummary(parsedView);
      if (!project) {
        return yield* Effect.fail(
          new GhError({ command: "getProjectBoard", cause: "Could not parse project metadata" }),
        );
      }

      const fields =
        parsedFields &&
        typeof parsedFields === "object" &&
        Array.isArray((parsedFields as { fields?: unknown[] }).fields)
          ? ((parsedFields as { fields: unknown[] }).fields ?? [])
          : [];

      const targetWeekField = findField(fields, (fieldName) => {
        const normalized = fieldName.replace(/\s+/g, "-");
        return normalized === "target-week" || normalized === "targetweek";
      });

      let resolvedItemQuery = itemQuery?.trim() || "";
      if (resolvedItemQuery === "target-week:<=@next" && targetWeekField) {
        const needsQuotes = /[^a-z0-9-]/i.test(targetWeekField.name);
        const queryFieldName = needsQuotes ? `"${targetWeekField.name}"` : targetWeekField.name;
        resolvedItemQuery = `${queryFieldName}:<=@next`;
      }

      const baseItemListArgs = [
        "project",
        "item-list",
        String(number),
        "--owner",
        normalizedOwner,
        "--limit",
        "200",
        "--format",
        "json",
      ];

      const itemListArgs =
        resolvedItemQuery.length > 0
          ? [...baseItemListArgs, "--query", resolvedItemQuery]
          : [...baseItemListArgs];

      let usedClientSideQueryFallback = false;
      const itemsResult = yield* runGh(...itemListArgs).pipe(
        Effect.catch((error: unknown) => {
          if (resolvedItemQuery.length === 0) {
            return Effect.fail(error);
          }

          const errorMessage = getUnknownErrorMessage(error);
          if (!isUnsupportedProjectItemQueryError(errorMessage)) {
            return Effect.fail(error);
          }

          usedClientSideQueryFallback = true;
          return runGh(...baseItemListArgs);
        }),
      );
      const parsedItems = yield* parseJsonUnknown(itemsResult);

      const statusField = toProjectStatusField(fields);
      const statusKey = statusField?.key ?? null;
      const assigneesKey = findFieldKey(
        fields,
        (fieldName) => fieldName === "assignees" || fieldName === "assignee",
      );
      const targetWeekKey =
        targetWeekField?.key ??
        findFieldKey(fields, (fieldName) => {
          const normalized = fieldName.replace(/\s+/g, "-");
          return normalized === "target-week" || normalized === "targetweek";
        });

      let itemsRaw =
        parsedItems &&
        typeof parsedItems === "object" &&
        Array.isArray((parsedItems as { items?: unknown[] }).items)
          ? ((parsedItems as { items: unknown[] }).items ?? [])
          : [];

      if (resolvedItemQuery.length > 0) {
        itemsRaw = filterProjectItemsByQuery(
          itemsRaw,
          resolvedItemQuery,
          targetWeekKey,
          targetWeekField?.name ?? null,
        );
      }

      const boardItems = itemsRaw
        .map((item) => toProjectBoardItem(item, statusKey, assigneesKey, targetWeekKey))
        .filter((item): item is ProjectBoardItem => item !== null);

      const columns: ProjectBoardColumn[] = [];

      if (statusField) {
        for (const option of statusField.options) {
          columns.push({
            id: option.id,
            name: option.name,
            items: boardItems.filter((item) => item.status === option.name),
          });
        }

        const uncategorized = boardItems.filter(
          (item) =>
            !item.status || !statusField.options.some((option) => option.name === item.status),
        );

        if (uncategorized.length > 0) {
          columns.push({
            id: null,
            name: "No status",
            items: uncategorized,
          });
        }
      } else {
        columns.push({
          id: null,
          name: "Items",
          items: boardItems,
        });
      }

      const totalCount =
        resolvedItemQuery.length > 0 || usedClientSideQueryFallback
          ? boardItems.length
          : parsedItems &&
              typeof parsedItems === "object" &&
              typeof (parsedItems as { totalCount?: unknown }).totalCount === "number"
            ? ((parsedItems as { totalCount: number }).totalCount ?? boardItems.length)
            : boardItems.length;

      return {
        project,
        statusField,
        columns,
        totalCount,
      } satisfies ProjectBoard;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getProjectBoard", cause })),
      Effect.withSpan("GhService.getProjectBoard", {
        attributes: {
          owner,
          projectNumber: number,
          itemQuery: itemQuery?.trim() || "",
        },
      }),
    ),

  moveProjectItem: (params: MoveProjectItemParams) =>
    Effect.gen(function* () {
      const normalizedOwner = normalizeOwner(params.owner);

      let projectId = params.projectId ?? null;
      let statusFieldId = params.statusFieldId ?? null;

      if (!projectId || !statusFieldId) {
        const [viewResult, fieldsResult] = yield* Effect.all(
          [
            runGh(
              "project",
              "view",
              String(params.number),
              "--owner",
              normalizedOwner,
              "--format",
              "json",
            ),
            runGh(
              "project",
              "field-list",
              String(params.number),
              "--owner",
              normalizedOwner,
              "--limit",
              "100",
              "--format",
              "json",
            ),
          ],
          { concurrency: "unbounded" },
        );

        const parsedView = yield* parseJsonUnknown(viewResult);
        const parsedFields = yield* parseJsonUnknown(fieldsResult);

        const project = toProjectSummary(parsedView);
        if (!project) {
          return yield* Effect.fail(
            new GhError({ command: "moveProjectItem", cause: "Could not parse project metadata" }),
          );
        }

        const fields =
          parsedFields &&
          typeof parsedFields === "object" &&
          Array.isArray((parsedFields as { fields?: unknown[] }).fields)
            ? ((parsedFields as { fields: unknown[] }).fields ?? [])
            : [];

        const statusField = toProjectStatusField(fields);
        if (!statusField) {
          return yield* Effect.fail(
            new GhError({
              command: "moveProjectItem",
              cause: "No single-select Status field found",
            }),
          );
        }

        projectId = project.id;
        statusFieldId = statusField.id;
      }

      if (!projectId || !statusFieldId) {
        return yield* Effect.fail(
          new GhError({ command: "moveProjectItem", cause: "Missing projectId or statusFieldId" }),
        );
      }

      const args = [
        "project",
        "item-edit",
        "--id",
        params.itemId,
        "--field-id",
        statusFieldId,
        "--project-id",
        projectId,
      ];

      if (params.statusOptionId) {
        args.push("--single-select-option-id", params.statusOptionId);
      } else {
        args.push("--clear");
      }

      yield* runGh(...args);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "moveProjectItem", cause })),
      Effect.withSpan("GhService.moveProjectItem", {
        attributes: {
          owner: params.owner,
          projectNumber: params.number,
          itemId: params.itemId,
          statusOptionId: params.statusOptionId ?? "clear",
        },
      }),
    ),

  getProjectGraphqlRateLimit: () =>
    Effect.gen(function* () {
      const result = yield* runGh("api", "rate_limit", "--jq", ".resources.graphql");
      const parsed = yield* parseJsonUnknown(result);
      const rateLimit = toProjectGraphqlRateLimit(parsed);

      if (!rateLimit) {
        return yield* Effect.fail(
          new GhError({
            command: "getProjectGraphqlRateLimit",
            cause: "Could not parse GraphQL rate limit",
          }),
        );
      }

      return rateLimit;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getProjectGraphqlRateLimit", cause })),
      Effect.withSpan("GhService.getProjectGraphqlRateLimit"),
    ),

  getPrCiStatus: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);

      // GraphQL query to get CI status for a single PR
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      state
                      contexts(first: 100) {
                        nodes {
                          __typename
                          ... on StatusContext { state }
                          ... on CheckRun { conclusion, status }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const result = yield* runGh(
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `number=${number}`,
      );
      type CiRollupPayload = {
        data?: {
          repository?: {
            pullRequest?: {
              commits?: {
                nodes?: Array<{
                  commit?: {
                    statusCheckRollup?: {
                      state: CiStatus["state"];
                      contexts?: {
                        nodes?: Array<
                          | { __typename: "StatusContext"; state: string }
                          | { __typename: "CheckRun"; conclusion: string | null; status: string }
                        >;
                      };
                    };
                  };
                }>;
              };
            };
          };
        };
      };
      const data = yield* Effect.sync(() => JSON.parse(result) as CiRollupPayload);

      const rollup =
        data?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      if (!rollup) return null;

      const contexts = rollup.contexts?.nodes ?? [];
      let passed = 0;
      const total = contexts.length;

      for (const ctx of contexts) {
        if (ctx.__typename === "StatusContext") {
          if (ctx.state === "SUCCESS") passed++;
        } else if (ctx.__typename === "CheckRun") {
          if (
            ctx.conclusion === "SUCCESS" ||
            ctx.conclusion === "NEUTRAL" ||
            ctx.conclusion === "SKIPPED"
          ) {
            passed++;
          }
        }
      }

      return {
        passed,
        total,
        state: rollup.state as CiStatus["state"],
      };
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getPrCiStatus", cause })),
      Effect.withSpan("GhService.getPrCiStatus", { attributes: { prUrl } }),
    ),

  getHeadSha: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);
      const sha = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        ".head.sha",
      )).trim();
      return sha;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getHeadSha", cause })),
      Effect.withSpan("GhService.getHeadSha", { attributes: { prUrl } }),
    ),

  getBaseSha: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);
      const sha = (yield* runGh(
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        ".base.sha",
      )).trim();
      return sha;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getBaseSha", cause })),
      Effect.withSpan("GhService.getBaseSha", { attributes: { prUrl } }),
    ),

  getFileContent: (params: { owner: string; repo: string; path: string; ref: string }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        Bun.$`gh api repos/${params.owner}/${params.repo}/contents/${params.path}?ref=${params.ref} -H "Accept: application/vnd.github.raw+json"`.text(),
      ).pipe(Effect.catch(() => Effect.succeed(null)));
      return result;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getFileContent", cause })),
      Effect.withSpan("GhService.getFileContent", {
        attributes: { path: params.path, ref: params.ref },
      }),
    ),
};

export class GhService extends ServiceMap.Service<GhService, GhCli>()("GhService", {
  make: Effect.succeed(ghCli),
}) {}

export const GhServiceLive = Layer.effect(GhService, Effect.succeed(ghCli));
