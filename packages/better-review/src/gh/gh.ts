import { Context, Data, Effect, Layer } from "effect";
import { Command } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";

class GhError extends Data.TaggedError("GhError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

export interface PRComment {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  in_reply_to_id?: number;
}

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

export interface ApprovePrParams {
  prUrl: string;
  body?: string;
}

export interface PrInfo {
  owner: string;
  repo: string;
  number: string;
}

export type PrState = "open" | "closed" | "merged";

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
}

export interface PrStatus {
  state: PrState;
  draft: boolean;
  mergeable: boolean | null;
  title: string;
  body: string;
  author: string;
  url: string;
  checks: CheckRun[];
}

export type ReviewState = "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | null;

export interface SearchedPr {
  number: number;
  title: string;
  url: string;
  repository: {
    name: string;
    nameWithOwner: string;
  };
  author: {
    login: string;
  };
  createdAt: string;
  isDraft: boolean;
  /** User's latest review state on this PR, null if not reviewed */
  myReviewState: ReviewState;
  /** Whether the current user is the author of this PR */
  isAuthor: boolean;
  /** Whether a review is requested from the current user */
  reviewRequested: boolean;
}

interface GhCli {
  getDiff: (urlOrNumber: string) => Effect.Effect<string, GhError>;
  getPrInfo: (urlOrNumber: string) => Effect.Effect<PrInfo, GhError>;
  getPrStatus: (urlOrNumber: string) => Effect.Effect<PrStatus, GhError>;
  listComments: (prUrl: string) => Effect.Effect<PRComment[], GhError>;
  addComment: (params: AddCommentParams) => Effect.Effect<PRComment, GhError>;
  replyToComment: (params: AddReplyParams) => Effect.Effect<PRComment, GhError>;
  approvePr: (params: ApprovePrParams) => Effect.Effect<void, GhError>;
  searchReviewRequested: () => Effect.Effect<SearchedPr[], GhError>;
}

export class GhService extends Context.Tag("GHService")<GhService, GhCli>() {}

// Parse PR URL or get repo info from gh CLI
const getPrInfo = (urlOrNumber: string) =>
  Effect.gen(function* () {
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
      const cmd = Command.make("gh", "pr", "diff", urlOrNumber, "--patch");
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
      const prData = JSON.parse(yield* Command.string(prCmd)) as {
        state: string;
        draft: boolean;
        mergeable: boolean | null;
        title: string;
        body: string | null;
        author: string;
        merged: boolean;
        html_url: string;
      };

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
      const checks = JSON.parse(checksResult) as CheckRun[];

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
      const result = yield* Command.string(cmd);
      return JSON.parse(result) as PRComment[];
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
      return JSON.parse(result) as PRComment;
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
      return JSON.parse(result) as PRComment;
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

  searchReviewRequested: () =>
    Effect.gen(function* () {
      // Get current user login
      const userCmd = Command.make("gh", "api", "user", "--jq", ".login");
      const currentUser = (yield* Command.string(userCmd)).trim();

      // GraphQL query to get PRs with review state
      const query = `
        query($requestedQuery: String!, $reviewedQuery: String!, $authoredQuery: String!) {
          requested: search(query: $requestedQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest {
                number
                title
                url
                isDraft
                createdAt
                repository { name, nameWithOwner }
                author { login }
                reviews(last: 20) {
                  nodes { author { login }, state }
                }
              }
            }
          }
          reviewed: search(query: $reviewedQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest {
                number
                title
                url
                isDraft
                createdAt
                repository { name, nameWithOwner }
                author { login }
                reviews(last: 20) {
                  nodes { author { login }, state }
                }
              }
            }
          }
          authored: search(query: $authoredQuery, type: ISSUE, first: 100) {
            nodes {
              ... on PullRequest {
                number
                title
                url
                isDraft
                createdAt
                repository { name, nameWithOwner }
                author { login }
                reviews(last: 20) {
                  nodes { author { login }, state }
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
        "-f",
        "requestedQuery=is:pr is:open review-requested:@me",
        "-f",
        "reviewedQuery=is:pr is:open reviewed-by:@me",
        "-f",
        "authoredQuery=is:pr is:open author:@me",
      );
      const result = yield* Command.string(graphqlCmd);
      const data = JSON.parse(result) as {
        data: {
          requested: { nodes: GraphQLPr[] };
          reviewed: { nodes: GraphQLPr[] };
          authored: { nodes: GraphQLPr[] };
        };
      };

      interface GraphQLPr {
        number: number;
        title: string;
        url: string;
        isDraft: boolean;
        createdAt: string;
        repository: { name: string; nameWithOwner: string };
        author: { login: string };
        reviews: { nodes: { author: { login: string }; state: string }[] };
      }

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
      const requestedUrls = new Set(data.data.requested.nodes.filter(Boolean).map(pr => pr.url));

      // Helper to convert GraphQL PR to SearchedPr
      const toSearchedPr = (pr: GraphQLPr): SearchedPr => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        createdAt: pr.createdAt,
        repository: pr.repository,
        author: pr.author,
        myReviewState: getMyReviewState(pr),
        isAuthor: pr.author.login === currentUser,
        reviewRequested: requestedUrls.has(pr.url),
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
});
