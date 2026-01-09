import { Effect } from "effect";
import { z } from "zod";

import { GhService } from "../../gh/gh";
import { router, publicProcedure, runEffect } from "../index";

export const prsRouter = router({
  list: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        yield* Effect.log("[prs.list] START");
        const startTime = Date.now();

        const gh = yield* GhService;
        const prs = yield* gh.searchReviewRequested();

        yield* Effect.log(`[prs.list] DONE total=${Date.now() - startTime}ms, count=${prs.length}`);
        return { prs };
      }),
    ),
  ),

  ciStatus: publicProcedure.input(z.object({ url: z.string() })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const ciStatus = yield* gh.getPrCiStatus(input.url);
        return { ciStatus };
      }),
    ),
  ),

  ciStatusBatch: publicProcedure.input(z.object({ urls: z.array(z.string()) })).query(({ input }) =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const results = yield* Effect.all(
          input.urls.map((url) =>
            gh.getPrCiStatus(url).pipe(
              Effect.map((status) => ({ url, status })),
              Effect.catchAll(() => Effect.succeed({ url, status: null })),
            ),
          ),
          { concurrency: 10 },
        );
        return {
          statuses: Object.fromEntries(results.map((r) => [r.url, r.status])),
        };
      }),
    ),
  ),
});
