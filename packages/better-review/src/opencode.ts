import { createOpencode } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

export class OpencodeService extends Effect.Service<OpencodeService>()("OpencodeService", {
  scoped: Effect.gen(function* () {
    yield* Effect.log("[OpenCode] Starting opencode server...");
    const { client, server } = yield* Effect.tryPromise(() =>
      createOpencode({
        port: process.env.OPENCODE_PORT ? parseInt(process.env.OPENCODE_PORT, 10) : undefined,
      }),
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
}) {}
