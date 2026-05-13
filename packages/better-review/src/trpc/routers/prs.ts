import { Effect } from "effect";
import { z } from "zod";

import { GhService } from "../../gh/gh";
import { PrListCacheService } from "../../state";
import { router, publicProcedure, runEffect } from "../index";

export const prsRouter = router({
  list: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        yield* Effect.log("[prs.list] START");
        const startTime = Date.now();

        const prListCache = yield* PrListCacheService;

        // Return cached data + trigger background refresh.
        // If no cache yet, the background refresh will populate it —
        // but we need data now, so fetch synchronously on first call.
        const cached = yield* prListCache.getAndRefresh;

        if (cached) {
          const ageMs = Date.now() - cached.fetchedAt;
          yield* Effect.log(
            `[prs.list] DONE (cached, age=${Math.round(ageMs / 1000)}s) total=${Date.now() - startTime}ms, count=${cached.prs.length}`,
          );
          return { prs: cached.prs, fetchedAt: cached.fetchedAt };
        }

        // No cache yet — wait for a fresh fetch
        yield* Effect.log("[prs.list] No cache, fetching synchronously...");
        const data = yield* prListCache.refresh;
        yield* Effect.log(
          `[prs.list] DONE (fresh) total=${Date.now() - startTime}ms, count=${data?.prs.length ?? 0}`,
        );
        return { prs: data?.prs ?? [], fetchedAt: data?.fetchedAt ?? Date.now() };
      }),
    ),
  ),

  /** Hard refresh — bypasses cache and waits for fresh data from GitHub */
  refresh: publicProcedure.mutation(() =>
    runEffect(
      Effect.gen(function* () {
        yield* Effect.log("[prs.refresh] START");
        const startTime = Date.now();

        const prListCache = yield* PrListCacheService;
        const data = yield* prListCache.refresh;

        yield* Effect.log(
          `[prs.refresh] DONE total=${Date.now() - startTime}ms, count=${data?.prs.length ?? 0}`,
        );
        return { prs: data?.prs ?? [], fetchedAt: data?.fetchedAt ?? Date.now() };
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
