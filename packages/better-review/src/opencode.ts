import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

export class OpencodeService extends Effect.Service<OpencodeService>()("OpencodeService", {
  scoped: Effect.gen(function* () {
    yield* Effect.log("[OpenCode] Starting opencode server...");
    const OPENCODE_USERNAME = "better-review";
    const OPENCODE_PASSWORD = Bun.randomUUIDv7();

    process.env.OPENCODE_SERVER_USERNAME = OPENCODE_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = OPENCODE_PASSWORD;

    const server = yield* Effect.tryPromise(() =>
      createOpencodeServer({
        port: process.env.OPENCODE_PORT ? parseInt(process.env.OPENCODE_PORT, 10) : undefined,
      }),
    );

    const client = createOpencodeClient({
      baseUrl: server.url,
      headers: {
        Authorization: `Basic ${btoa(`${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`)}`,
      },
    });

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
