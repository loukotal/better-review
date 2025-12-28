import { Context, Data, Effect, Layer } from "effect";
import { Command } from "@effect/platform";
import {
  BunCommandExecutor,
  BunContext,
  BunRuntime,
} from "@effect/platform-bun";

class GhError extends Data.TaggedError("GhError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

interface GhCli {
  getDiff: (urlOrNumber: string) => Effect.Effect<string, GhError>;
}

export class GhService extends Context.Tag("GHService")<GhService, GhCli>() {}

export const GhServiceLive = Layer.succeed(GhService, {
  getDiff: (urlOrNumber: string) =>
    Effect.gen(function* () {
      const cmd = Command.make("gh", "pr", "diff", urlOrNumber, "--patch");
      return yield* Command.string(cmd);
    }).pipe(
      Effect.mapError((cause) => new GhError({ command: "getDiff", cause })),
      Effect.withSpan("GhService.getDiff", { attributes: { urlOrNumber } }),
      Effect.provide(BunContext.layer),
    ),
});
