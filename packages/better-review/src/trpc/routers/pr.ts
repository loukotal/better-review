import { parsePatchFiles } from "@pierre/diffs";
import { Effect } from "effect";
import { z } from "zod";

import { filterDiffByLineRange, isDiffCommentTargetInPatch } from "../../diff";
import { GhService } from "../../gh/gh";
import { PrCheckoutService } from "../../pr-checkout";
import { getOrGenerateReadingDiff } from "../../reading-diff";
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

  readingDiff: publicProcedure
    .input(
      z.object({
        url: z.string(),
        sha: z.string().min(7).max(64).optional(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const checkout = yield* PrCheckoutService;
          const pr = yield* gh.getPrInfo(input.url);
          const [headSha, baseSha, headRef, baseRef] = yield* Effect.all(
            [
              gh.getHeadSha(input.url),
              gh.getBaseSha(input.url),
              gh.getHeadRef(input.url),
              gh.getBaseRef(input.url),
            ],
            { concurrency: "unbounded" },
          );
          let diff: string;
          if (input.sha) {
            diff = yield* gh.getCommitDiff({ owner: pr.owner, repo: pr.repo, sha: input.sha });
          } else {
            diff = yield* gh.getDiff(input.url);
          }
          const files = parsePatchFiles(diff)
            .flatMap((patch) => patch.files)
            .map((file) => file.name);

          return yield* Effect.tryPromise({
            try: () =>
              getOrGenerateReadingDiff(diff, {
                force: input.force,
                sourceHeadSha: input.sha ?? headSha,
                prepareRepository: async () => {
                  const prepared = await Effect.runPromise(
                    checkout.prepare({
                      owner: pr.owner,
                      repo: pr.repo,
                      number: Number(pr.number),
                      prUrl: input.url,
                      baseSha,
                      headSha,
                      baseRef,
                      headRef,
                      reviewMode: input.sha ? "commit" : "full",
                      commitSha: input.sha ?? null,
                      files,
                    }),
                  );
                  return prepared.worktreePath;
                },
              }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
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
        const [comments, currentUser, threads] = yield* Effect.all([
          gh.listComments(input.url),
          gh.getCurrentUser(),
          gh.getReviewThreads(input.url),
        ]);

        // Build maps from comment node_id -> isResolved and threadId
        const resolvedByNodeId = new Map<string, boolean>();
        const threadIdByNodeId = new Map<string, string>();
        for (const thread of threads) {
          for (const nodeId of thread.commentNodeIds) {
            resolvedByNodeId.set(nodeId, thread.isResolved);
            threadIdByNodeId.set(nodeId, thread.threadId);
          }
        }

        return {
          comments: comments.map((c) => ({
            ...c,
            canEdit: c.user.login === currentUser,
            isResolved: resolvedByNodeId.get(c.node_id) ?? false,
            threadId: threadIdByNodeId.get(c.node_id),
          })),
        };
      }),
    ),
  ),

  issueComments: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const [comments, currentUser] = yield* Effect.all([
          gh.listIssueComments(input.url),
          gh.getCurrentUser(),
        ]);
        return {
          comments: comments.map((c) => ({
            ...c,
            canEdit: c.user.login === currentUser,
          })),
        };
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
        const [diff, info, commits, comments, issueComments, status, currentUser, threads] =
          yield* Effect.all(
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
              gh.getCurrentUser(),
              gh
                .getReviewThreads(input.url)
                .pipe(
                  Effect.tap(() =>
                    Effect.log(
                      `[pr.batch] getReviewThreads completed in ${Date.now() - startTime}ms`,
                    ),
                  ),
                ),
            ],
            { concurrency: 4 },
          );

        yield* Effect.log(`[pr.batch] DONE total=${Date.now() - startTime}ms`);

        // Build maps from comment node_id -> isResolved and threadId
        const resolvedByNodeId = new Map<string, boolean>();
        const threadIdByNodeId = new Map<string, string>();
        for (const thread of threads) {
          for (const nodeId of thread.commentNodeIds) {
            resolvedByNodeId.set(nodeId, thread.isResolved);
            threadIdByNodeId.set(nodeId, thread.threadId);
          }
        }

        return {
          diff,
          info,
          commits,
          comments: comments.map((c) => ({
            ...c,
            canEdit: c.user.login === currentUser,
            isResolved: resolvedByNodeId.get(c.node_id) ?? false,
            threadId: threadIdByNodeId.get(c.node_id),
          })),
          issueComments: issueComments.map((c) => ({
            ...c,
            canEdit: c.user.login === currentUser,
          })),
          status,
        };
      }),
    ),
  ),

  /** Fetch full file contents (old + new) for expanding unchanged lines in the diff viewer */
  fileContent: publicProcedure
    .input(
      z.object({
        url: z.string(),
        path: z.string(),
        /** For renamed files, the old path (before rename) */
        prevPath: z.string().optional(),
      }),
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const { owner, repo } = yield* gh.getPrInfo(input.url);

          const [baseSha, headSha] = yield* Effect.all(
            [gh.getBaseSha(input.url), gh.getHeadSha(input.url)],
            { concurrency: 2 },
          );

          // For renamed files, fetch old content from prevPath
          const oldPath = input.prevPath ?? input.path;

          const [oldContent, newContent] = yield* Effect.all(
            [
              gh
                .getFileContent({ owner, repo, path: oldPath, ref: baseSha })
                .pipe(Effect.catchAll(() => Effect.succeed(null))),
              gh
                .getFileContent({ owner, repo, path: input.path, ref: headSha })
                .pipe(Effect.catchAll(() => Effect.succeed(null))),
            ],
            { concurrency: 2 },
          );

          yield* Effect.log(
            `[fileContent] ${input.path} old=${oldContent ? oldContent.length : "null"}b new=${newContent ? newContent.length : "null"}b`,
          );

          return { oldContent, newContent };
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

          const sessionScope = yield* prContext.getSessionScope(input.sessionId);

          yield* Effect.log(
            `[file-diff] Session ${input.sessionId} -> PR ${prUrl}, file: ${input.file}`,
          );

          const prDiffs =
            sessionScope.mode === "commit" && sessionScope.commitSha
              ? yield* diffCache.getOrFetchCommit(prUrl, sessionScope.commitSha)
              : yield* diffCache.get(prUrl);
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

        const sessionScope = yield* prContext.getSessionScope(input.sessionId);

        yield* Effect.log(`[metadata] Session ${input.sessionId} -> PR ${prUrl}`);

        // Get PR status (includes description)
        const prStatus = yield* gh.getPrStatus(prUrl);

        // Get cached diffs and compute line counts
        const prDiffs =
          sessionScope.mode === "commit" && sessionScope.commitSha
            ? yield* diffCache.getOrFetchCommit(prUrl, sessionScope.commitSha)
            : yield* diffCache.get(prUrl);
        const fileStats: string[] = [];
        const files: string[] = [];

        if (prDiffs) {
          for (const [file, fileMeta] of prDiffs) {
            files.push(file);
            const { totalAdded, totalRemoved, hunks } = fileMeta;
            // Show hunk ranges for large files (>1k lines changed)
            if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
              const ranges = hunks
                .map(
                  (h: { newStart: number; newCount: number }) =>
                    `${h.newStart}-${h.newStart + h.newCount - 1}`,
                )
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

        const scopeLine =
          sessionScope.mode === "commit" && sessionScope.commitSha
            ? `Scope: commit ${sessionScope.commitSha.slice(0, 7)}\n`
            : "Scope: full PR\n";

        const metadata = `PR: ${owner}/${repo}#${number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}
${scopeLine}

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
        startLine: z.number().optional(),
        startSide: z.enum(["LEFT", "RIGHT"]).optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const diffCache = yield* DiffCacheService;
          const fileDiffs = yield* diffCache.getOrFetch(input.prUrl);
          const fileDiff = fileDiffs.get(input.filePath);
          const side = input.side ?? "RIGHT";
          const startSide = input.startSide ?? side;

          if (
            !fileDiff ||
            !isDiffCommentTargetInPatch(fileDiff, {
              line: input.line,
              side,
              startLine: input.startLine,
              startSide,
            })
          ) {
            return yield* Effect.fail(
              new Error(
                `Invalid review comment target: ${input.filePath}:${input.line} is not part of the PR diff patch. This can happen after expanding unchanged context locally; add the comment on a changed/default-context line or use a PR timeline comment instead.`,
              ),
            );
          }

          const comment = yield* gh.addComment({
            prUrl: input.prUrl,
            filePath: input.filePath,
            line: input.line,
            body: input.body,
            side,
            startLine: input.startLine,
            startSide,
          });
          // User just created this comment, so they can edit it
          return { comment: { ...comment, canEdit: true } };
        }),
      ),
    ),

  addIssueComment: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        body: z.string(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const comment = yield* gh.addIssueComment({
            prUrl: input.prUrl,
            body: input.body,
          });
          // User just created this comment, so they can edit it
          return { comment: { ...comment, canEdit: true } };
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
          // User just created this comment, so they can edit it
          return { comment: { ...comment, canEdit: true } };
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
          // User just edited this comment, so they can still edit it
          return { comment: { ...comment, canEdit: true } };
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

  resolveThread: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        threadId: z.string(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          yield* gh.resolveThread({
            prUrl: input.prUrl,
            threadNodeId: input.threadId,
          });
          return { success: true };
        }),
      ),
    ),

  unresolveThread: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        threadId: z.string(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          yield* gh.unresolveThread({
            prUrl: input.prUrl,
            threadNodeId: input.threadId,
          });
          return { success: true };
        }),
      ),
    ),

  editIssueComment: publicProcedure
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
          const comment = yield* gh.editIssueComment({
            prUrl: input.prUrl,
            commentId: input.commentId,
            body: input.body,
          });
          // User just edited this comment, so they can still edit it
          return { comment: { ...comment, canEdit: true } };
        }),
      ),
    ),

  deleteIssueComment: publicProcedure
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
          yield* gh.deleteIssueComment({
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
