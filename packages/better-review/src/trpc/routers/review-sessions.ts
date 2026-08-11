import { Effect } from "effect";
import { z } from "zod";

import { ReviewSessionService } from "../../agent-sessions";
import { router, publicProcedure, runEffect } from "../index";

const reviewSessionPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("markdown"),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("message"),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("diff"),
    rawPatch: z.string(),
    label: z.string().optional(),
    selectedVariantId: z.string().optional(),
    variants: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          description: z.string().optional(),
          rawPatch: z.string(),
        }),
      )
      .optional(),
  }),
]);

const reviewSessionAnnotationSchema = z.object({
  id: z.string(),
  quote: z.string(),
  comment: z.string(),
  createdAt: z.number(),
  kind: z.enum(["selection", "file", "line-range"]).optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  filePath: z.string().optional(),
  line: z.number().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
});

export const reviewSessionsRouter = router({
  create: publicProcedure
    .input(
      z.object({
        mode: z.enum(["plan", "message", "diff"]),
        origin: z.string(),
        title: z.string(),
        cwd: z.string().optional(),
        repoRoot: z.string().optional(),
        payload: reviewSessionPayloadSchema,
        returnChannel: z
          .object({
            type: z.enum(["stdout", "http"]),
            endpoint: z.string().optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const reviewSessions = yield* ReviewSessionService;
          return yield* reviewSessions.createSession(input);
        }),
      ),
    ),

  get: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const reviewSessions = yield* ReviewSessionService;
        return yield* reviewSessions.getSession(input.sessionId);
      }),
    ),
  ),

  submitResult: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        approved: z.boolean(),
        feedback: z.string(),
        annotations: z.array(reviewSessionAnnotationSchema).default([]),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const reviewSessions = yield* ReviewSessionService;
          const session = yield* reviewSessions.getSession(input.sessionId);
          if (!session) {
            return yield* Effect.fail(new Error(`Review session not found: ${input.sessionId}`));
          }

          return yield* reviewSessions.submitResult(input.sessionId, {
            mode: session.mode,
            approved: input.approved,
            feedback: input.feedback,
            annotations: input.annotations,
          });
        }),
      ),
    ),

  getResult: publicProcedure.input(z.object({ sessionId: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const reviewSessions = yield* ReviewSessionService;
        return yield* reviewSessions.getResult(input.sessionId);
      }),
    ),
  ),
});
