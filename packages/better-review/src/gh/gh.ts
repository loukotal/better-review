import { Context, Data, Effect, Layer, Schema } from "effect";
import { Command } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";

class GhError extends Data.TaggedError("GhError")<{
  readonly command: string;
  readonly cause: unknown;
}> { }

// ============================================================================
// Schemas
// ============================================================================

const parseJsonPreserve = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.decodeUnknown(Schema.parseJson(schema), { onExcessProperty: "preserve" })

const UserSchema = Schema.Struct({
  login: Schema.String,
  avatar_url: Schema.String,
})

const PRCommentSchema = Schema.Struct({
  id: Schema.Number,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  original_line: Schema.NullOr(Schema.Number),
  side: Schema.Literal("LEFT", "RIGHT"),
  body: Schema.String,
  html_url: Schema.String,
  user: UserSchema,
  created_at: Schema.String,
  in_reply_to_id: Schema.optional(Schema.Number),
})
export type PRComment = typeof PRCommentSchema.Type

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

export interface PrInfo {
  owner: string;
  repo: string;
  number: string;
}

const PrStateSchema = Schema.Literal("open", "closed", "merged")
export type PrState = typeof PrStateSchema.Type

const CheckRunSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("queued", "in_progress", "completed"),
  conclusion: Schema.NullOr(
    Schema.Literal("success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required")
  ),
})
export type CheckRun = typeof CheckRunSchema.Type

const PrStatusSchema = Schema.Struct({
  state: PrStateSchema,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  url: Schema.String,
  checks: Schema.Array(CheckRunSchema),
})
export type PrStatus = typeof PrStatusSchema.Type

const ReviewStateSchema = Schema.NullOr(
  Schema.Literal("PENDING", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED")
)
export type ReviewState = typeof ReviewStateSchema.Type

const RepositorySchema = Schema.Struct({
  name: Schema.String,
  nameWithOwner: Schema.String,
})

const AuthorSchema = Schema.Struct({
  login: Schema.String,
})

const CiStatusSchema = Schema.Struct({
  passed: Schema.Number,
  total: Schema.Number,
  state: Schema.Literal("SUCCESS", "FAILURE", "PENDING", "EXPECTED", "ERROR", "NEUTRAL"),
})
export type CiStatus = typeof CiStatusSchema.Type

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
})
export type SearchedPr = typeof SearchedPrSchema.Type

const PrCommitSchema = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  author: Schema.Struct({
    login: Schema.String,
    avatar_url: Schema.String,
  }),
  date: Schema.String,
})
export type PrCommit = typeof PrCommitSchema.Type

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
})

// Schema for raw commit from listCommits API
const RawCommitSchema = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.Struct({ date: Schema.String }),
  }),
  author: Schema.NullOr(Schema.Struct({
    login: Schema.String,
    avatar_url: Schema.String,
  })),
})

// Schema for GraphQL PR in searchReviewRequested
const GraphQLReviewSchema = Schema.Struct({
  author: Schema.Struct({ login: Schema.String }),
  state: Schema.String,
})

const GraphQLPrSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  repository: Schema.Struct({ name: Schema.String, nameWithOwner: Schema.String }),
  author: Schema.Struct({ login: Schema.String }),
  reviews: Schema.Struct({ nodes: Schema.Array(GraphQLReviewSchema) }),
})

const GraphQLSearchResponseSchema = Schema.Struct({
  data: Schema.Struct({
    requested: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)) }),
    reviewed: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)) }),
    authored: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(GraphQLPrSchema)) }),
  }),
})

/** GhCli methods return Effect<A, GhError, never> - no requirements after construction */
interface GhCli {
  getDiff: (urlOrNumber: string) => Effect.Effect<string, GhError, never>;
  getPrInfo: (urlOrNumber: string) => Effect.Effect<PrInfo, GhError, never>;
  getPrStatus: (urlOrNumber: string) => Effect.Effect<PrStatus, GhError, never>;
  listComments: (prUrl: string) => Effect.Effect<readonly PRComment[], GhError, never>;
  addComment: (params: AddCommentParams) => Effect.Effect<PRComment, GhError, never>;
  replyToComment: (params: AddReplyParams) => Effect.Effect<PRComment, GhError, never>;
  editComment: (params: EditCommentParams) => Effect.Effect<PRComment, GhError, never>;
  deleteComment: (params: DeleteCommentParams) => Effect.Effect<void, GhError, never>;
  getCurrentUser: () => Effect.Effect<string, GhError, never>;
  approvePr: (params: ApprovePrParams) => Effect.Effect<void, GhError, never>;
  searchReviewRequested: () => Effect.Effect<readonly SearchedPr[], GhError, never>;
  listCommits: (prUrl: string) => Effect.Effect<readonly PrCommit[], GhError, never>;
  getCommitDiff: (params: { owner: string; repo: string; sha: string }) => Effect.Effect<string, GhError, never>;
  getPrCiStatus: (prUrl: string) => Effect.Effect<CiStatus | null, GhError, never>;
  getHeadSha: (prUrl: string) => Effect.Effect<string, GhError, never>;
}

export class GhService extends Context.Tag("GHService")<GhService, GhCli>() { }

// Validate it's a PR number or valid PR URL (not an issue URL)
const validatePrUrl = (url: string): Effect.Effect<void, GhError> => {
  // Pure number is valid (PR number)
  if (/^\d+$/.test(url.trim())) {
    return Effect.void;
  }
  if (/^.+\/pull\/\d+/.test(url)) {
    return Effect.void;;
  }
  return Effect.fail(new GhError({
    command: "validateUrl",
    cause: "Invalid pull request URL/number. E.g. github.com/john/demo/pull/12582",
  }));
};

// Parse PR URL or get repo info from gh CLI
const getPrInfo = (urlOrNumber: string) =>
  Effect.gen(function* () {
    yield* validatePrUrl(urlOrNumber);

    // If it's a full URL, parse it
    const urlMatch = urlOrNumber.match(
      /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
    );
    if (urlMatch) {
      return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };
    }

    // Otherwise, use gh to get the repo info from the current directory
    const repoCmd = Command.make(
      "gh",
      "repo",
      "view",
      "--json",
      "owner,name",
      "--jq",
      '.owner.login + "/" + .name',
    );
    const repoInfo = (yield* Command.string(repoCmd)).trim();
    const [owner, repo] = repoInfo.split("/");

    return { owner, repo, number: urlOrNumber };
  }).pipe(Effect.provide(BunContext.layer));

export const GhServiceLive = Layer.succeed(GhService, {
  getPrInfo: (urlOrNumber: string) =>
    getPrInfo(urlOrNumber).pipe(
      Effect.mapError((cause) => new GhError({ command: "getPrInfo", cause })),
      Effect.withSpan("GhService.getPrInfo", { attributes: { urlOrNumber } }),
    ),

  getDiff: (urlOrNumber: string) =>
    Effect.gen(function* () {
      yield* validatePrUrl(urlOrNumber);
      const cmd = Command.make("gh", "pr", "diff", urlOrNumber);
      return yield* Command.string(cmd);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getDiff", cause })),
      Effect.withSpan("GhService.getDiff", { attributes: { urlOrNumber } }),
      Effect.provide(BunContext.layer),
    ),

  getPrStatus: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(urlOrNumber);

      // Get PR details
      const prCmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        "{ state, draft, mergeable, title, body, author: .user.login, merged: .merged, html_url }",
      );
      const prResult = (yield* Command.string(prCmd)).trim();
      if (!prResult) {
        return yield* Effect.fail(new GhError({ command: "getPrStatus", cause: "PR not found" }));
      }
      const prData = yield* parseJsonPreserve(PrDataResponseSchema)(prResult);

      // Get check runs for the PR's head commit
      const checksCmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/commits/${yield* Effect.tryPromise(() =>
          Bun.$`gh api repos/${owner}/${repo}/pulls/${number} --jq '.head.sha'`.text().then(s => s.trim())
        )}/check-runs`,
        "--jq",
        ".check_runs | map({ name, status, conclusion })",
      );
      const checksResult = yield* Command.string(checksCmd).pipe(
        Effect.catchAll(() => Effect.succeed("[]")),
      );
      const checks = yield* parseJsonPreserve(Schema.Array(CheckRunSchema))(checksResult);

      // Determine actual state (open/closed/merged)
      const state: PrState = prData.merged ? "merged" : prData.state as PrState;

      return {
        state,
        draft: prData.draft,
        mergeable: prData.mergeable,
        title: prData.title,
        body: prData.body ?? "",
        author: prData.author,
        url: prData.html_url,
        checks,
      } satisfies PrStatus;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getPrStatus", cause })),
      Effect.withSpan("GhService.getPrStatus", { attributes: { urlOrNumber } }),
      Effect.provide(BunContext.layer),
    ),

  listComments: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(urlOrNumber);
      const cmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/pulls/${number}/comments`,
        "--jq",
        ".",
      );
      const result = (yield* Command.string(cmd)).trim();
      if (!result) return [];
      return yield* parseJsonPreserve(Schema.Array(PRCommentSchema))(result);
    }).pipe(
      Effect.mapError(
        (cause) => new GhError({ command: "getComments", cause }),
      ),
      Effect.withSpan("GhService.getComments", { attributes: { urlOrNumber } }),
      Effect.provide(BunContext.layer),
    ),

  addComment: (params: AddCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      // Get the HEAD commit SHA
      const shaCmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        ".head.sha",
      );
      const commitSha = (yield* Command.string(shaCmd)).trim();

      // Create the comment using raw JSON body
      const payload = JSON.stringify({
        body: params.body,
        commit_id: commitSha,
        path: params.filePath,
        line: params.line,
        side: params.side ?? "RIGHT",
      });

      // Use Bun shell directly for easier stdin handling
      const result = yield* Effect.tryPromise(() =>
        Bun.$`echo ${payload} | gh api repos/${owner}/${repo}/pulls/${number}/comments -X POST -H "Accept: application/vnd.github+json" --input -`.text(),
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
      Effect.provide(BunContext.layer),
    ),

  replyToComment: (params: AddReplyParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      const payload = JSON.stringify({ body: params.body });

      // Use the dedicated reply endpoint
      const result = yield* Effect.tryPromise(() =>
        Bun.$`echo ${payload} | gh api repos/${owner}/${repo}/pulls/${number}/comments/${params.commentId}/replies -X POST -H "Accept: application/vnd.github+json" --input -`.text(),
      );
      return yield* parseJsonPreserve(PRCommentSchema)(result);
    }).pipe(
      Effect.mapError(
        (cause) => new GhError({ command: "replyToComment", cause }),
      ),
      Effect.withSpan("GhService.replyToComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
      Effect.provide(BunContext.layer),
    ),

  editComment: (params: EditCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      // Use gh api with field flag for the body
      const result = yield* Effect.tryPromise(() =>
        Bun.$`gh api repos/${owner}/${repo}/pulls/comments/${params.commentId} -X PATCH -f body=${params.body}`.text(),
      );
      return yield* parseJsonPreserve(PRCommentSchema)(result);
    }).pipe(
      Effect.mapError(
        (cause) => new GhError({ command: "editComment", cause }),
      ),
      Effect.withSpan("GhService.editComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
      Effect.provide(BunContext.layer),
    ),

  deleteComment: (params: DeleteCommentParams) =>
    Effect.gen(function* () {
      const { owner, repo } = yield* getPrInfo(params.prUrl);

      yield* Effect.tryPromise(() =>
        Bun.$`gh api repos/${owner}/${repo}/pulls/comments/${params.commentId} -X DELETE`.text(),
      );
    }).pipe(
      Effect.mapError(
        (cause) => new GhError({ command: "deleteComment", cause }),
      ),
      Effect.withSpan("GhService.deleteComment", {
        attributes: {
          prUrl: params.prUrl,
          commentId: params.commentId,
        },
      }),
      Effect.provide(BunContext.layer),
    ),

  getCurrentUser: () =>
    Effect.gen(function* () {
      const cmd = Command.make("gh", "api", "user", "--jq", ".login");
      return (yield* Command.string(cmd)).trim();
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getCurrentUser", cause })),
      Effect.withSpan("GhService.getCurrentUser"),
      Effect.provide(BunContext.layer),
    ),

  approvePr: (params: ApprovePrParams) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(params.prUrl);

      const payload = JSON.stringify({
        event: "APPROVE",
        body: params.body ?? "",
      });

      // Create a review with APPROVE event
      yield* Effect.tryPromise(() =>
        Bun.$`echo ${payload} | gh api repos/${owner}/${repo}/pulls/${number}/reviews -X POST -H "Accept: application/vnd.github+json" --input -`.text(),
      );
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "approvePr", cause })),
      Effect.withSpan("GhService.approvePr", {
        attributes: { prUrl: params.prUrl },
      }),
      Effect.provide(BunContext.layer),
    ),

  listCommits: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);
      const cmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/pulls/${number}/commits`,
        "--jq",
        ".",
      );
      const result = yield* Command.string(cmd);
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
      Effect.provide(BunContext.layer),
    ),

  getCommitDiff: (params: { owner: string; repo: string; sha: string }) =>
    Effect.gen(function* () {
      // Use Accept header to get diff format
      const cmd = Command.make(
        "gh",
        "api",
        `repos/${params.owner}/${params.repo}/commits/${params.sha}`,
        "-H",
        "Accept: application/vnd.github.diff",
      );
      return yield* Command.string(cmd);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getCommitDiff", cause })),
      Effect.withSpan("GhService.getCommitDiff", { attributes: { sha: params.sha } }),
      Effect.provide(BunContext.layer),
    ),

  searchReviewRequested: () =>
    Effect.gen(function* () {
      // Get current user login
      const userCmd = Command.make("gh", "api", "user", "--jq", ".login");
      const currentUser = (yield* Command.string(userCmd)).trim();

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

      const graphqlCmd = Command.make(
        "gh",
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
      const result = yield* Command.string(graphqlCmd);
      const data = yield* parseJsonPreserve(GraphQLSearchResponseSchema)(result);

      type GraphQLPr = typeof GraphQLPrSchema.Type;

      // Helper to get user's latest review state
      const getMyReviewState = (pr: GraphQLPr): ReviewState => {
        const myReviews = pr.reviews.nodes.filter(
          (r) => r.author.login === currentUser
        );
        if (myReviews.length === 0) return null;
        // Return the last review state
        return myReviews[myReviews.length - 1].state as ReviewState;
      };

      // Track which PRs came from which query
      const requestedUrls = new Set(
        data.data.requested.nodes.filter((pr): pr is GraphQLPr => pr !== null).map(pr => pr.url)
      );

      // Helper to convert GraphQL PR to SearchedPr (ciStatus loaded lazily)
      const toSearchedPr = (pr: GraphQLPr): SearchedPr => ({
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
      Effect.provide(BunContext.layer),
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

      const graphqlCmd = Command.make(
        "gh",
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
      const result = yield* Command.string(graphqlCmd);
      const data = yield* Effect.try(() => JSON.parse(result));

      const rollup = data?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      if (!rollup) return null;

      const contexts = rollup.contexts?.nodes ?? [];
      let passed = 0;
      const total = contexts.length;

      for (const ctx of contexts) {
        if (ctx.__typename === "StatusContext") {
          if (ctx.state === "SUCCESS") passed++;
        } else if (ctx.__typename === "CheckRun") {
          if (ctx.conclusion === "SUCCESS" || ctx.conclusion === "NEUTRAL" || ctx.conclusion === "SKIPPED") {
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
      Effect.provide(BunContext.layer),
    ),

  getHeadSha: (prUrl: string) =>
    Effect.gen(function* () {
      const { owner, repo, number } = yield* getPrInfo(prUrl);
      const cmd = Command.make(
        "gh",
        "api",
        `repos/${owner}/${repo}/pulls/${number}`,
        "--jq",
        ".head.sha",
      );
      const sha = (yield* Command.string(cmd)).trim();
      return sha;
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getHeadSha", cause })),
      Effect.withSpan("GhService.getHeadSha", { attributes: { prUrl } }),
      Effect.provide(BunContext.layer),
    ),
});
