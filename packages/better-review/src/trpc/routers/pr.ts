import { Effect } from "effect";
import { z } from "zod";

import { filterDiffByLineRange } from "../../diff";
import { GhService } from "../../gh/gh";
import { DiffCacheService, PrContextService } from "../../state";
import { router, publicProcedure, runEffect } from "../index";

export const prRouter = router({
  // =========================================================================
  // Read Operations
  // =========================================================================

  diff: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return { diff: yield* gh.getDiff(input.url) };
      }),
    ),
  ),

  info: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return yield* gh.getPrInfo(input.url);
      }),
    ),
  ),

  status: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return yield* gh.getPrStatus(input.url);
      }),
    ),
  ),

  commits: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return { commits: yield* gh.listCommits(input.url) };
      }),
    ),
  ),

  commitDiff: publicProcedure
    .input(z.object({ url: z.string(), sha: z.string() }))
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const { owner, repo } = yield* gh.getPrInfo(input.url);
          const diff = yield* gh.getCommitDiff({ owner, repo, sha: input.sha });
          return { diff, sha: input.sha };
        }),
      ),
    ),

  commitDiffsBatch: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const { owner, repo } = yield* gh.getPrInfo(input.url);
        const commits = yield* gh.listCommits(input.url);

        const diffs = yield* Effect.all(
          commits.map((commit) =>
            gh.getCommitDiff({ owner, repo, sha: commit.sha }).pipe(
              Effect.map((diff) => ({ sha: commit.sha, diff })),
              Effect.catchAll(() => Effect.succeed({ sha: commit.sha, diff: null })),
            ),
          ),
          { concurrency: 5 },
        );

        return {
          diffs: Object.fromEntries(diffs.map((d) => [d.sha, d.diff])),
        };
      }),
    ),
  ),

  comments: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return { comments: yield* gh.listComments(input.url) };
      }),
    ),
  ),

  issueComments: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        return { comments: yield* gh.listIssueComments(input.url) };
      }),
    ),
  ),

  batch: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        yield* Effect.log(`[pr.batch] START url=${input.url}`);
        const startTime = Date.now();

        const gh = yield* GhService;

        // Fetch all data in parallel with individual timing
        const [diff, info, commits, comments, issueComments, status] = yield* Effect.all(
          [
            gh
              .getDiff(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(`[pr.batch] getDiff completed in ${Date.now() - startTime}ms`),
                ),
              ),
            gh
              .getPrInfo(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(`[pr.batch] getPrInfo completed in ${Date.now() - startTime}ms`),
                ),
              ),
            gh
              .listCommits(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(`[pr.batch] listCommits completed in ${Date.now() - startTime}ms`),
                ),
              ),
            gh
              .listComments(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(`[pr.batch] listComments completed in ${Date.now() - startTime}ms`),
                ),
              ),
            gh
              .listIssueComments(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(
                    `[pr.batch] listIssueComments completed in ${Date.now() - startTime}ms`,
                  ),
                ),
              ),
            gh
              .getPrStatus(input.url)
              .pipe(
                Effect.tap(() =>
                  Effect.log(`[pr.batch] getPrStatus completed in ${Date.now() - startTime}ms`),
                ),
              ),
          ],
          { concurrency: "unbounded" },
        );

        yield* Effect.log(`[pr.batch] DONE total=${Date.now() - startTime}ms`);

        return {
          diff,
          info,
          commits,
          comments,
          issueComments,
          status,
        };
      }),
    ),
  ),

  // File diff endpoint for the pr_diff tool
  fileDiff: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        file: z.string(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
      }),
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const diffCache = yield* DiffCacheService;

          // O(1) lookup of PR URL from session
          const prUrl = yield* prContext.getPrUrlBySessionId(input.sessionId);

          if (!prUrl) {
            return yield* Effect.fail(new Error("Session not found. Load a PR first."));
          }

          yield* Effect.log(
            `[file-diff] Session ${input.sessionId} -> PR ${prUrl}, file: ${input.file}`,
          );

          // Get from cache
          const prDiffs = yield* diffCache.get(prUrl);
          if (!prDiffs) {
            return yield* Effect.fail(new Error("Diffs not cached. This shouldn't happen."));
          }

          const fileMeta = prDiffs.get(input.file);
          if (!fileMeta) {
            return yield* Effect.fail(new Error(`No diff found for file: ${input.file}`));
          }

          // Filter by line range if specified
          let diffOutput = fileMeta.diff;
          if (input.startLine !== undefined || input.endLine !== undefined) {
            diffOutput = filterDiffByLineRange(diffOutput, input.startLine, input.endLine);
          }

          yield* Effect.log(
            `[file-diff] Returning diff for ${input.file} (${diffOutput.length} chars)`,
          );
          return { diff: diffOutput };
        }),
      ),
    ),

  // PR metadata endpoint for the pr_metadata tool
  metadata: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const prContext = yield* PrContextService;
        const diffCache = yield* DiffCacheService;

        // O(1) lookup of PR URL from session
        const prUrl = yield* prContext.getPrUrlBySessionId(input.sessionId);

        if (!prUrl) {
          return yield* Effect.fail(new Error("Session not found. Load a PR first."));
        }

        yield* Effect.log(`[metadata] Session ${input.sessionId} -> PR ${prUrl}`);

        // Get PR status (includes description)
        const prStatus = yield* gh.getPrStatus(prUrl);

        // Get cached diffs and compute line counts
        const prDiffs = yield* diffCache.get(prUrl);
        const fileStats: string[] = [];
        const files: string[] = [];

        if (prDiffs) {
          for (const [file, fileMeta] of prDiffs) {
            files.push(file);
            const { totalAdded, totalRemoved, hunks } = fileMeta;
            // Show hunk ranges for large files (>1k lines changed)
            if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
              const ranges = hunks
                .map((h) => `${h.newStart}-${h.newStart + h.newCount - 1}`)
                .join(", ");
              fileStats.push(`${file} +${totalAdded} -${totalRemoved} [hunks: ${ranges}]`);
            } else {
              fileStats.push(`${file} +${totalAdded} -${totalRemoved}`);
            }
          }
        }

        // Parse owner/repo/number from PR URL
        const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        const owner = match?.[1] ?? "unknown";
        const repo = match?.[2] ?? "unknown";
        const number = match?.[3] ?? "?";

        // Build compact text output
        const description = prStatus.body
          ? prStatus.body.length > 500
            ? prStatus.body.slice(0, 500) + "..."
            : prStatus.body
          : "(no description)";

        const metadata = `PR: ${owner}/${repo}#${number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}

Description:
${description}

Files (${files.length} changed):
${fileStats.join("\n")}`;

        return { metadata };
      }),
    ),
  ),

  // =========================================================================
  // Write Operations (Mutations)
  // =========================================================================

  addComment: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        filePath: z.string(),
        line: z.number(),
        body: z.string(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const comment = yield* gh.addComment({
            prUrl: input.prUrl,
            filePath: input.filePath,
            line: input.line,
            body: input.body,
            side: input.side,
          });
          return { comment };
        }),
      ),
    ),

  replyToComment: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        commentId: z.number(),
        body: z.string(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const comment = yield* gh.replyToComment({
            prUrl: input.prUrl,
            commentId: input.commentId,
            body: input.body,
          });
          return { comment };
        }),
      ),
    ),

  editComment: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        commentId: z.number(),
        body: z.string(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const comment = yield* gh.editComment({
            prUrl: input.prUrl,
            commentId: input.commentId,
            body: input.body,
          });
          return { comment };
        }),
      ),
    ),

  deleteComment: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        commentId: z.number(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          yield* gh.deleteComment({
            prUrl: input.prUrl,
            commentId: input.commentId,
          });
          return { success: true };
        }),
      ),
    ),

  approve: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        body: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          yield* gh.approvePr({
            prUrl: input.prUrl,
            body: input.body,
          });
          return { success: true };
        }),
      ),
    ),
});
