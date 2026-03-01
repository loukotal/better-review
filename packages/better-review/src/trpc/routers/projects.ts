import { Effect } from "effect";
import { z } from "zod";

import { GhService } from "../../gh/gh";
import { router, publicProcedure, runEffect } from "../index";

export const projectsRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          owner: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const projects = yield* gh.listProjects(input?.owner ?? "@me");
          return { projects };
        }),
      ),
    ),

  board: publicProcedure
    .input(
      z.object({
        owner: z.string().min(1),
        number: z.number().int().positive(),
        itemQuery: z.string().optional(),
      }),
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          const board = yield* gh.getProjectBoard(input.owner, input.number, input.itemQuery);
          return board;
        }),
      ),
    ),

  moveItem: publicProcedure
    .input(
      z.object({
        owner: z.string().min(1),
        number: z.number().int().positive(),
        itemId: z.string().min(1),
        statusOptionId: z.string().min(1).nullable(),
        projectId: z.string().min(1).optional(),
        statusFieldId: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const gh = yield* GhService;
          yield* gh.moveProjectItem(input);
          return { ok: true };
        }),
      ),
    ),

  rateLimit: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const graphql = yield* gh.getProjectGraphqlRateLimit();
        return { graphql };
      }),
    ),
  ),
});
