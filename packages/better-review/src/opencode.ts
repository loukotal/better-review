import { Effect } from "effect";
import { createOpencode } from "@opencode-ai/sdk";

export class OpencodeService extends Effect.Service<OpencodeService>()(
  "OpencodeService",
  {
    scoped: Effect.gen(function* () {
      yield* Effect.log("[OpenCode] Starting opencode server...");
      const { client, server } = yield* Effect.tryPromise(() =>
        createOpencode({}),
      );
      yield* Effect.log(`[OpenCode] Server running at ${server.url}`);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          console.log("[OpenCode] Stopping opencode server...");
          server.close();
        }),
      );
      return { client, server, baseUrl: server.url };
    }),
  },
) {}

