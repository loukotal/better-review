import { Context, Effect } from "effect";
import { Command } from "@effect/platform";
import { BunCommandExecutor, BunRuntime } from "@effect/platform-bun";

const getDiff = Effect.fn("ghGetDiff")(function* (pr: string) {
  Command.make("gh pr diff" + pr);
});

interface GhCli {}

class GhService extends Context.Tag("GHService")<GhService, GhCli>() {}

const program = Effect.gen(function* () {
  const gh = yield* GhService;
});

BunRuntime.runMain();
