import { z } from "zod";
import { router, publicProcedure, runEffect } from "../index";
import { PrContextService } from "../../state";
import { GhService } from "../../gh/gh";
import { OpencodeService } from "../../opencode";
import { buildReviewContext } from "../../response";
import { Effect } from "effect";

export const sessionsRouter = router({
  /**
   * List sessions for a PR
   */
  list: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        includeHidden: z.boolean().optional(),
      })
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          return yield* prContext.listSessions(input.prUrl, input.includeHidden);
        })
      )
    ),

  /**
   * Switch to a different session for a PR
   */
  switch: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        sessionId: z.string(),
      })
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          yield* prContext.setActiveSession(input.prUrl, input.sessionId);
          // Register session -> PR mapping for O(1) lookup by tools
          yield* prContext.registerSession(input.sessionId, input.prUrl);
          return { success: true, activeSessionId: input.sessionId };
        })
      )
    ),

  /**
   * Create a new session for a PR
   */
  create: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        prNumber: z.number(),
        repoOwner: z.string(),
        repoName: z.string(),
        files: z.array(z.string()),
      })
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const gh = yield* GhService;
          const opencode = yield* OpencodeService;

          yield* Effect.log("[API] Creating new session for PR:", input.prUrl);

          // Fetch current head SHA
          const currentHeadSha = yield* gh.getHeadSha(input.prUrl);

          // Create a new OpenCode session
          const session = yield* Effect.tryPromise(() =>
            opencode.client.session.create({
              title: `PR Review: ${input.repoOwner}/${input.repoName}#${input.prNumber}`,
            })
          );

          if (!session.data) {
            return yield* Effect.fail(new Error("Failed to create session"));
          }

          // Persist to storage
          const prData = yield* prContext.addSession(
            input.prUrl,
            session.data.id,
            currentHeadSha
          );

          // Inject initial context
          const contextMessage = buildReviewContext(input);
          yield* Effect.tryPromise(() =>
            opencode.client.session.prompt({
              sessionID: session.data.id,
              parts: [{ type: "text", text: contextMessage }],
              noReply: true,
            })
          );

          yield* Effect.log("[API] New session created:", session.data.id);

          return {
            session: session.data,
            sessions: prData.sessions,
            activeSessionId: prData.activeSessionId,
          };
        })
      )
    ),

  /**
   * Hide a session (soft delete)
   */
  hide: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        sessionId: z.string(),
      })
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const prData = yield* prContext.hideSession(
            input.prUrl,
            input.sessionId
          );
          return {
            success: true,
            sessions: prData.sessions.filter((s) => !s.hidden),
            activeSessionId: prData.activeSessionId,
          };
        })
      )
    ),
});
