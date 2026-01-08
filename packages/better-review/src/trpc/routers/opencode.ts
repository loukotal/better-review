import { z } from "zod";
import { router, publicProcedure, runEffect } from "../index";
import { runtime } from "../context";
import { OpencodeService } from "../../opencode";
import { Effect } from "effect";
import { observable } from "@trpc/server/observable";
import {
  transformEvent,
  type StreamEvent,
} from "../../stream";
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
      }).pipe(
        Effect.catchAll((e) =>
          Effect.succeed({ healthy: false, error: String(e) })
        )
      )
    )
  ),

  /**
   * Create a new OpenCode session for PR review
   */
  createSession: publicProcedure
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
          const opencode = yield* OpencodeService;

          yield* Effect.log("[OpenCode] Creating session for PR:", input.prUrl);

          const session = yield* Effect.tryPromise(() =>
            opencode.client.session.create({
              title: `PR Review: ${input.repoOwner}/${input.repoName}#${input.prNumber}`,
            })
          );

          if (!session.data) {
            return yield* Effect.fail(new Error("Failed to create session"));
          }

          yield* Effect.log("[OpenCode] Session created:", session.data.id);

          return { session: session.data };
        })
      )
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
      })
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
            })
          );

          return { result: result.data };
        })
      )
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
      })
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;
          const currentModel = getCurrentModel();

          // Use the async endpoint (prompt_async) - fire and forget
          const response = yield* Effect.tryPromise(() =>
            fetch(
              `${opencode.baseUrl}/session/${input.sessionId}/prompt_async`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
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
              }
            )
          );

          if (!response.ok) {
            const text = yield* Effect.tryPromise(() => response.text());
            return yield* Effect.fail(
              new Error(`OpenCode error: ${response.status} - ${text}`)
            );
          }

          // Returns 204 No Content on success
          return { success: true };
        })
      )
    ),

  /**
   * Get messages for a session
   */
  messages: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;

          const messages = yield* Effect.tryPromise(() =>
            opencode.client.session.messages({ sessionID: input.sessionId })
          );

          return { messages: messages.data };
        })
      )
    ),

  /**
   * Abort an in-progress prompt
   */
  abort: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const opencode = yield* OpencodeService;

          yield* Effect.tryPromise(() =>
            opencode.client.session.abort({ sessionID: input.sessionId })
          );

          return { success: true };
        })
      )
    ),

  /**
   * SSE subscription for streaming events from an OpenCode session
   */
  events: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ input }) => {
      return observable<StreamEvent>((emit) => {
        let aborted = false;
        let abortController: AbortController | null = null;

        // Start async connection
        (async () => {
          try {
            // Get OpenCode service URL from runtime
            const opencode = await runtime.runPromise(
              Effect.gen(function* () {
                return yield* OpencodeService;
              })
            );

            const eventUrl = `${opencode.baseUrl}/event`;
            console.log(`[tRPC SSE] Connecting to OpenCode: ${eventUrl}`);

            abortController = new AbortController();

            const response = await fetch(eventUrl, {
              headers: { Accept: "text/event-stream" },
              signal: abortController.signal,
            });

            if (!response.ok || !response.body) {
              emit.error(
                new Error(`Failed to connect to OpenCode: ${response.status}`)
              );
              return;
            }

            console.log(`[tRPC SSE] Connection established for session: ${input.sessionId}`);

            // Emit connected event
            emit.next({ type: "connected" });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (!aborted) {
              const { done, value } = await reader.read();

              if (done) {
                console.log(`[tRPC SSE] Stream ended for session: ${input.sessionId}`);
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;

                try {
                  const data = line.slice(6);
                  const event = JSON.parse(data);
                  const transformed = transformEvent(event, input.sessionId);

                  if (transformed) {
                    emit.next(transformed);
                  }
                } catch (e) {
                  console.error("[tRPC SSE] Parse error:", e);
                }
              }
            }

            emit.complete();
          } catch (error) {
            if (!aborted) {
              console.error("[tRPC SSE] Error:", error);
              emit.error(error instanceof Error ? error : new Error(String(error)));
            }
          }
        })();

        // Cleanup function
        return () => {
          console.log(`[tRPC SSE] Unsubscribing from session: ${input.sessionId}`);
          aborted = true;
          if (abortController) {
            abortController.abort();
          }
        };
      });
    }),
});
