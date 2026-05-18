import { Effect, Stream } from "effect";
import { z } from "zod";

import { EventBroadcaster } from "../../event-broadcaster";
import { GhService } from "../../gh/gh";
import { OpencodeService } from "../../opencode";
import { buildReviewContext } from "../../response";
import { DiffCacheService, PrContextService, type SessionReviewScope } from "../../state";
import { opencodeRuntime } from "../context";
import { router, publicProcedure, runOpencodeEffect } from "../index";
import { getCurrentModel } from "./models";

// =============================================================================
// OpenCode Router
// =============================================================================

let sseSubscriptionSequence = 0;

const activeSseByClientId = new Map<
  string,
  { subscriptionId: number; cancel: (reason: string) => void }
>();

export const opencodeRouter = router({
  /**
   * Health check for OpenCode service
   */
  health: publicProcedure.query(() =>
    runOpencodeEffect(
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
        reviewMode: z.enum(["full", "commit"]).optional(),
        commitSha: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runOpencodeEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const opencode = yield* OpencodeService;
          const diffCache = yield* DiffCacheService;
          const prContext = yield* PrContextService;
          yield* Effect.log("[OpenCode] Creating session for PR:", input.prUrl);

          const reviewScope: SessionReviewScope = {
            mode: input.reviewMode === "commit" ? "commit" : "full",
            commitSha: input.reviewMode === "commit" && input.commitSha ? input.commitSha : null,
          };

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
                yield* prContext.setSessionScope(activeSessionId, reviewScope);

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
          yield* prContext.setSessionScope(session.data.id, reviewScope);

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
        reviewMode: z.enum(["full", "commit"]).optional(),
        commitSha: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runOpencodeEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;
          const prContext = yield* PrContextService;
          const currentModel = yield* Effect.tryPromise(() => getCurrentModel());

          if (input.reviewMode) {
            yield* prContext.setSessionScope(input.sessionId, {
              mode: input.reviewMode,
              commitSha: input.reviewMode === "commit" ? (input.commitSha ?? null) : null,
            });
          }

          const result = yield* Effect.tryPromise(() =>
            opencode.client.session.prompt({
              sessionID: input.sessionId,
              model: {
                providerID: currentModel.providerId,
                modelID: currentModel.modelId,
              },
              variant: currentModel.variant ?? undefined,
              agent: input.agent,
              parts: [{ type: "text", text: input.message }],
              // Disable tools for remote PR review sessions.
              // The review agent should use pr_metadata / pr_diff instead of webfetch.
              tools: {
                bash: false,
                edit: false,
                write: false,
                glob: false,
                grep: false,
                read: false,
                todoread: true,
                todowrite: true,
                webfetch: false,
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
        reviewMode: z.enum(["full", "commit"]).optional(),
        commitSha: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      runOpencodeEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;
          const prContext = yield* PrContextService;
          const currentModel = yield* Effect.tryPromise(() => getCurrentModel());

          if (input.reviewMode) {
            yield* prContext.setSessionScope(input.sessionId, {
              mode: input.reviewMode,
              commitSha: input.reviewMode === "commit" ? (input.commitSha ?? null) : null,
            });
          }

          // Use the SDK's promptAsync method
          yield* Effect.tryPromise(() =>
            opencode.client.session.promptAsync({
              sessionID: input.sessionId,
              model: {
                providerID: currentModel.providerId,
                modelID: currentModel.modelId,
              },
              variant: currentModel.variant ?? undefined,
              agent: input.agent,
              parts: [{ type: "text", text: input.message }],
              // Disable local file tools - they would search the wrong repo.
              // Force remote PR review through pr_metadata / pr_diff instead of webfetch.
              tools: {
                bash: false,
                edit: false,
                write: false,
                glob: false,
                grep: false,
                read: false,
                todoread: true,
                todowrite: true,
                webfetch: false,
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
    runOpencodeEffect(
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
    runOpencodeEffect(
      Effect.gen(function* () {
        const opencode = yield* OpencodeService;

        yield* Effect.tryPromise(() =>
          opencode.client.session.abort({ sessionID: input.sessionId }),
        );

        return { success: true };
      }),
    ),
  ),

  events: publicProcedure
    .input(z.object({ clientId: z.string().optional() }).optional())
    .subscription(async function* ({ input }) {
      const subscriptionId = ++sseSubscriptionSequence;
      const debugSse = process.env.BETTER_REVIEW_DEBUG_SSE === "1";
      const clientLabel = input?.clientId ? ` client=${input.clientId.slice(0, 8)}` : "";
      const log = (message: string) =>
        console.log(`[SSE:${subscriptionId}${clientLabel}] ${message}`);

      log("Subscription requested");

      let cancelSubscription: ((reason: string) => void) | null = null;
      const cancelled = new Promise<{ __cancelled: true; reason: string }>((resolve) => {
        cancelSubscription = (reason: string) => resolve({ __cancelled: true, reason });
      });

      if (input?.clientId && cancelSubscription) {
        const existing = activeSseByClientId.get(input.clientId);
        if (existing) {
          log(`Replacing existing subscription SSE:${existing.subscriptionId}`);
          existing.cancel("replaced-by-new-subscription");
        }
        activeSseByClientId.set(input.clientId, { subscriptionId, cancel: cancelSubscription });
      }

      // Get the runtime and subscribe to events
      const effectRuntime = await opencodeRuntime.runtime().catch((error) => {
        throw new Error(
          `[SSE] Failed to acquire Effect runtime: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const { stream, getState, getSubscriberCount } = await opencodeRuntime
        .runPromise(
          Effect.gen(function* () {
            const broadcaster = yield* EventBroadcaster;
            return {
              stream: yield* broadcaster.subscribe(),
              getState: broadcaster.getState,
              getSubscriberCount: broadcaster.getSubscriberCount,
            };
          }),
        )
        .catch((error) => {
          throw new Error(
            `[SSE] Failed to initialize broadcaster subscription: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

      const pingIntervalMs = 2000;
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitForUpstreamConnected = async (timeoutMs = 5000): Promise<void> => {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const state = await opencodeRuntime.runPromise(getState());
          if (state._tag === "Connected") {
            return;
          }
          if (state._tag === "Error") {
            throw new Error(`[SSE] OpenCode event stream failed: ${state.error}`);
          }
          await sleep(25);
        }

        throw new Error("[SSE] Timed out waiting for OpenCode event stream");
      };

      await waitForUpstreamConnected();

      log("Subscription established");

      yield { type: "connected", serverTime: Date.now() };

      let nextPingAt = Date.now() + pingIntervalMs;
      let pingSequence = 0;

      // Convert Effect Stream to async iterable using our runtime
      // This properly handles cleanup when the iterator is returned
      const asyncIterable = Stream.toAsyncIterableRuntime(stream, effectRuntime);
      const iterator = asyncIterable[Symbol.asyncIterator]();

      try {
        let nextPromise = iterator.next();

        while (true) {
          const timeoutMs = Math.max(0, nextPingAt - Date.now());
          const result = await Promise.race([
            nextPromise,
            sleep(timeoutMs).then(() => ({ __ping: true as const })),
            cancelled,
          ]);

          if ("__cancelled" in result) {
            log(`Subscription cancelled: ${result.reason}`);
            break;
          }

          if ("__ping" in result) {
            const [state, subscribers] = await Promise.all([
              opencodeRuntime.runPromise(getState()),
              opencodeRuntime.runPromise(getSubscriberCount()),
            ]);
            pingSequence += 1;
            if (debugSse) {
              log(`ping #${pingSequence} upstream=${state._tag} subscribers=${subscribers}`);
            }
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
            log("Subscription stream completed");
            break;
          }

          if (debugSse) {
            log(`event ${result.value.type}`);
          }
          yield result.value;
          nextPingAt = Date.now() + pingIntervalMs;
          nextPromise = iterator.next();
        }
      } finally {
        log("Cleaning up subscription");

        await iterator.return?.().catch(() => {});
        if (
          input?.clientId &&
          activeSseByClientId.get(input.clientId)?.subscriptionId === subscriptionId
        ) {
          activeSseByClientId.delete(input.clientId);
        }
      }
    }),
});
