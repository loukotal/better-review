import { router, publicProcedure, runEffect } from "../index";
import { GhService } from "../../gh/gh";
import { Effect } from "effect";

export const userRouter = router({
  current: publicProcedure.query(() =>
    runEffect(
      Effect.gen(function* () {
        const gh = yield* GhService;
        const login = yield* gh.getCurrentUser();
        return { login };
      })
    )
  ),
});
