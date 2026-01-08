import { Effect } from "effect";

import { GhService } from "../../gh/gh";
import { router, publicProcedure, runEffect } from "../index";

export const userRouter = router({
  current: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const login = yield* gh.getCurrentUser();
        return { login };
      }),
    ),
  ),
});
