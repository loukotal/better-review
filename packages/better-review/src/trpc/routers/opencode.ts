import { observable } from "@trpc/server/observable";
import { Effect } from "effect";
import { z } from "zod";

import { GhService } from "../../gh/gh";
import { OpencodeService } from "../../opencode";
import { buildReviewContext } from "../../response";
import { DiffCacheService, PrContextService } from "../../state";
import { transformEvent, type StreamEvent } from "../../stream";
import { runtime } from "../context";
import { router, publicProcedure, runEffect } from "../index";
import { getCurrentModel } from "./models";

// =============================================================================
// OpenCode Router
// =============================================================================

export const opencodeRouter = router({
  /**
   * Health check for OpenCode service
   */
  health: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        const opencode = yield* OpencodeService;
        yield* Effect.tryPromise(() => opencode.client.global.health());
        return { healthy: true };
      }).pipe(Effect.catchAll((e) => Effect.succeed({ healthy: false, error: String(e) }))),
    ),
  ),

  getOrCreateSession: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        prNumber: z.number(),
        repoOwner: z.string(),
        repoName: z.string(),
        files: z.array(z.string()),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const opencode = yield* OpencodeService;
          const diffCache = yield* DiffCacheService;
          const prContext = yield* PrContextService;
          yield* Effect.log("[OpenCode] Creating session for PR:", input.prUrl);

          // Run independent operations in parallel
          const [currentHeadSha] = yield* Effect.all(
            [
              gh.getHeadSha(input.prUrl),
              prContext.setCurrent(input.prUrl, input.files, {
                owner: input.repoOwner,
                repo: input.repoName,
                number: String(input.prNumber),
              }),
              diffCache.getOrFetch(input.prUrl),
            ],
            { concurrency: "unbounded" },
          );

          const { sessions, activeSessionId } = yield* prContext.listSessions(input.prUrl);

          if (activeSessionId) {
            const activeSession = sessions.find((s) => s.id === activeSessionId);
            if (activeSession) {
              if (activeSession.headSha !== currentHeadSha) {
                yield* diffCache.clear(input.prUrl);
              }

              const existingSessionData = yield* Effect.tryPromise(() =>
                opencode.client.session.get({ sessionID: activeSessionId }),
              );

              if (existingSessionData.data) {
                yield* prContext.registerSession(activeSessionId, input.prUrl);

                return {
                  session: existingSessionData.data,
                  sessions,
                  activeSessionId,
                  existing: true,
                  headSha: currentHeadSha,
                  sessionHeadSha: activeSession.headSha,
                };
              }
            }
          }

          const session = yield* Effect.tryPromise(() =>
            opencode.client.session.create({
              title: `PR Review: ${input.repoOwner}/${input.repoName}#${input.prNumber}`,
            }),
          );

          if (!session.data) {
            return yield* Effect.fail(new Error("Failed to create session"));
          }

          const prData = yield* prContext.addSession(input.prUrl, session.data.id, currentHeadSha);

          const contextMessage = buildReviewContext(input);
          yield* Effect.tryPromise(() =>
            opencode.client.session.prompt({
              sessionID: session.data!.id,
              parts: [{ type: "text", text: contextMessage }],
              noReply: true,
            }),
          );

          return {
            session: session.data,
            sessions: prData.sessions,
            activeSessionId: prData.activeSessionId,
            existing: false,
            headSha: currentHeadSha,
            sessionHeadSha: currentHeadSha,
          };
        }),
      ),
    ),

  /**
   * Send a prompt to an OpenCode session (synchronous, waits for response)
   */
  prompt: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        message: z.string(),
        agent: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;
          const currentModel = getCurrentModel();

          const result = yield* Effect.tryPromise(() =>
            opencode.client.session.prompt({
              sessionID: input.sessionId,
              model: {
                providerID: currentModel.providerId,
                modelID: currentModel.modelId,
              },
              agent: input.agent,
              parts: [{ type: "text", text: input.message }],
              // Disable tools for read-only mode
              tools: {
                bash: false,
                edit: false,
                write: false,
                glob: false,
                grep: false,
                read: false,
                todoread: true,
                todowrite: true,
                webfetch: true,
              },
            }),
          );

          return { result: result.data };
        }),
      ),
    ),

  /**
   * Start a prompt asynchronously (fire-and-forget, use with events subscription)
   */
  promptStart: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        message: z.string(),
        agent: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;
          const currentModel = getCurrentModel();

          // Use the SDK's promptAsync method
          yield* Effect.tryPromise(() =>
            opencode.client.session.promptAsync({
              sessionID: input.sessionId,
              model: {
                providerID: currentModel.providerId,
                modelID: currentModel.modelId,
              },
              agent: input.agent,
              parts: [{ type: "text", text: input.message }],
              // Disable local file tools - they would search the wrong repo
              // The pr_diff custom tool is enabled by default
              tools: {
                bash: false,
                edit: false,
                write: false,
                glob: false,
                grep: false,
                read: false,
                todoread: true,
                todowrite: true,
                webfetch: true,
              },
            }),
          );

          return { success: true };
        }),
      ),
    ),

  /**
   * Get messages for a session
   */
  messages: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const opencode = yield* OpencodeService;

        const messages = yield* Effect.tryPromise(() =>
          opencode.client.session.messages({ sessionID: input.sessionId }),
        );

        return { messages: messages.data };
      }),
    ),
  ),

  /**
   * Abort an in-progress prompt
   */
  abort: publicProcedure.input(z.object({ sessionId: z.string() })).mutation(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const opencode = yield* OpencodeService;

        yield* Effect.tryPromise(() =>
          opencode.client.session.abort({ sessionID: input.sessionId }),
        );

        return { success: true };
      }),
    ),
  ),

  /**
   * SSE subscription for streaming events from an OpenCode session
   */
  events: publicProcedure.input(z.object({ sessionId: z.string() })).subscription(({ input }) => {
    return observable<StreamEvent>((emit) => {
      const abortController = new AbortController();

      // Start async connection
      (async () => {
        try {
          // Get OpenCode service from runtime
          const opencode = await runtime.runPromise(
            Effect.gen(function* () {
              return yield* OpencodeService;
            }),
          );

          console.log(`[tRPC SSE] Connecting to OpenCode events for session: ${input.sessionId}`);

          // Use the SDK's event.subscribe() which handles auth via configured headers
          const { stream } = await opencode.client.event.subscribe(
            {},
            { signal: abortController.signal },
          );

          console.log(`[tRPC SSE] Connection established for session: ${input.sessionId}`);

          // Emit connected event
          emit.next({ type: "connected" });

          // Consume the async generator
          for await (const event of stream) {
            const transformed = transformEvent(event, input.sessionId);
            if (transformed) {
              emit.next(transformed);
            }
          }

          console.log(`[tRPC SSE] Stream ended for session: ${input.sessionId}`);
          emit.complete();
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error("[tRPC SSE] Error:", error);
            emit.error(error instanceof Error ? error : new Error(String(error)));
          }
        }
      })();

      // Cleanup function
      return () => {
        console.log(`[tRPC SSE] Unsubscribing from session: ${input.sessionId}`);
        abortController.abort();
      };
    });
  }),
});
