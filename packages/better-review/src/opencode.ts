import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import { Effect, Layer, ServiceMap } from "effect";

export interface OpencodeServiceApi {
  readonly client: ReturnType<typeof createOpencodeClient>;
  readonly server: Awaited<ReturnType<typeof createOpencodeServer>>;
  readonly baseUrl: string;
}

export class OpencodeService extends ServiceMap.Service<OpencodeService, OpencodeServiceApi>()(
  "OpencodeService",
  {
    make: Effect.gen(function* () {
      yield* Effect.log("[OpenCode] Starting opencode server...");
      const OPENCODE_USERNAME = "better-review";
      const OPENCODE_PASSWORD = Bun.randomUUIDv7();

      process.env.OPENCODE_SERVER_USERNAME = OPENCODE_USERNAME;
      process.env.OPENCODE_SERVER_PASSWORD = OPENCODE_PASSWORD;

      const server = yield* Effect.tryPromise({
        try: () =>
          createOpencodeServer({
            port: process.env.OPENCODE_PORT ? parseInt(process.env.OPENCODE_PORT, 10) : undefined,
          }),
        catch: (error) =>
          new Error(
            `[OpenCode] Failed to start server${process.env.OPENCODE_PORT ? ` on port ${process.env.OPENCODE_PORT}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });

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
  },
) {}

export const OpencodeServiceLive = Layer.effect(OpencodeService, OpencodeService.make);
