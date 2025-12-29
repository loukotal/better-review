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

interface GhCli {
  getDiff: (urlOrNumber: string) => Effect.Effect<string, GhError>;
  listComments: (prUrl: string) => Effect.Effect<PRComment[], GhError>;
  addComment: (params: AddCommentParams) => Effect.Effect<PRComment, GhError>;
  replyToComment: (params: AddReplyParams) => Effect.Effect<PRComment, GhError>;
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
  getDiff: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const cmd = Command.make("gh", "pr", "diff", urlOrNumber, "--patch");
      return yield* Command.string(cmd);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getDiff", cause })),
      Effect.withSpan("GhService.getDiff", { attributes: { urlOrNumber } }),
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
});
