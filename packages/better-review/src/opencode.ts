import { randomUUID } from "node:crypto";

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

type OpencodeServer = Awaited<ReturnType<typeof createOpencodeServer>>;

function getConfiguredPort(): number {
  const rawPort = process.env.OPENCODE_PORT?.trim();
  if (!rawPort) return 0;

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid OPENCODE_PORT "${rawPort}". Expected an integer from 0 to 65535.`);
  }

  return port;
}

function describePort(port: number): string {
  return port === 0 ? "on a random free port" : `on port ${port}`;
}

function isPortStartupFailure(error: unknown, port: number): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Failed to start server on port ${port}`);
}

async function startOpencodeServer(port: number): Promise<OpencodeServer> {
  try {
    return await createOpencodeServer({ port });
  } catch (error) {
    if (port !== 0 && isPortStartupFailure(error, port)) {
      console.warn(`[OpenCode] Port ${port} is unavailable, retrying on a random free port...`);
      return await createOpencodeServer({ port: 0 });
    }

    throw error;
  }
}

export interface OpencodeServiceApi {
  readonly client: ReturnType<typeof createOpencodeClient>;
  readonly server: OpencodeServer;
  readonly baseUrl: string;
}

export class OpencodeService extends Effect.Service<OpencodeService>()("OpencodeService", {
  scoped: Effect.gen(function* () {
    const port = getConfiguredPort();

    yield* Effect.log(`[OpenCode] Starting opencode server ${describePort(port)}...`);
    const OPENCODE_USERNAME = "better-review";
    const OPENCODE_PASSWORD = randomUUID();

    process.env.OPENCODE_SERVER_USERNAME = OPENCODE_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = OPENCODE_PASSWORD;

    const server = yield* Effect.tryPromise({
      try: () => startOpencodeServer(port),
      catch: (error) =>
        new Error(
          `[OpenCode] Failed to start server ${describePort(port)}: ${error instanceof Error ? error.message : String(error)}`,
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
}) {}

export const OpencodeServiceLive = OpencodeService.Default;
