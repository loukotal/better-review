import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { GhService, GhServiceLive } from "./gh";

const program = Effect.gen(function* () {
  const gh = yield* GhService;
  const diff = yield* gh.getDiff("1");
  console.log({ diff });
});

BunRuntime.runMain(program.pipe(Effect.provide(GhServiceLive)));
