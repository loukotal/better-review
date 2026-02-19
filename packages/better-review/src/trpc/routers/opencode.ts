import { Effect, Stream } from "effect";
import { z } from "zod";

import { EventBroadcaster } from "../../event-broadcaster";
import { GhService } from "../../gh/gh";
import { OpencodeService } from "../../opencode";
import { buildReviewContext } from "../../response";
import { DiffCacheService, PrContextService } from "../../state";
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
      }).pipe(Effect.catch((e) => Effect.succeed({ healthy: false, error: String(e) }))),
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
            const activeSession = (sessions as Array<{ id: string; headSha: string }>).find(
              (s) => s.id === activeSessionId,
            );
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

          const contextMessage = yield* Effect.tryPromise(() => buildReviewContext(input));
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

  events: publicProcedure.subscription(async function* () {
    console.log(`[SSE] Subscription requested`);

    // Get the runtime and subscribe to events
    const services = await runtime.services();

    const { stream, getState, getSubscriberCount } = await runtime.runPromise(
      Effect.gen(function* () {
        const broadcaster = yield* EventBroadcaster;
        return {
          stream: yield* broadcaster.subscribe(),
          getState: broadcaster.getState,
          getSubscriberCount: broadcaster.getSubscriberCount,
        };
      }),
    );

    console.log(`[SSE] Subscription established`);

    yield { type: "connected", serverTime: Date.now() };

    const pingIntervalMs = 15000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let nextPingAt = Date.now() + pingIntervalMs;
    let pingSequence = 0;

    // Convert Effect Stream to async iterable using our runtime
    // This properly handles cleanup when the iterator is returned
    const asyncIterable = Stream.toAsyncIterableWith(stream, services);
    const iterator = asyncIterable[Symbol.asyncIterator]();

    try {
      let nextPromise = iterator.next();

      while (true) {
        const timeoutMs = Math.max(0, nextPingAt - Date.now());
        const result = await Promise.race([
          nextPromise,
          sleep(timeoutMs).then(() => ({ __ping: true as const })),
        ]);

        if ("__ping" in result) {
          const [state, subscribers] = await Promise.all([
            runtime.runPromise(getState()),
            runtime.runPromise(getSubscriberCount()),
          ]);
          pingSequence += 1;
          yield {
            type: "ping",
            serverTime: Date.now(),
            sequence: pingSequence,
            upstream: state._tag,
            subscribers,
          };
          nextPingAt = Date.now() + pingIntervalMs;
          continue;
        }

        if (result.done) {
          break;
        }

        yield result.value;
        nextPingAt = Date.now() + pingIntervalMs;
        nextPromise = iterator.next();
      }
    } finally {
      console.log(`[SSE] Cleaning up subscription`);

      await iterator.return?.().catch(() => {});
    }
  }),
});
