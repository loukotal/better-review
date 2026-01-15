import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Effect, Fiber } from "effect";

import { filterDiffByLineRange } from "./diff";
import { GhService } from "./gh/gh";
import { getErrorMessage } from "./response";
import { runtime } from "./runtime";
import { DiffCacheService, PrContextService } from "./state";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";

// =============================================================================
// Static File Serving (Production)
// =============================================================================

const isProduction = process.env.NODE_ENV === "production";
const staticDir = import.meta.dir + "/../../web/dist";

if (isProduction) {
  console.log(`[static] Production mode enabled, serving from: ${staticDir}`);
}

async function serveStatic(pathname: string): Promise<Response> {
  const filePath = `${staticDir}${pathname}`;
  const file = Bun.file(filePath);

  if (await file.exists()) {
    return new Response(file);
  }

  return new Response(Bun.file(`${staticDir}/index.html`), {
    headers: { "Content-Type": "text/html" },
  });
}

// =============================================================================
// Route Handlers
// =============================================================================

type RouteServices = {
  gh: Effect.Effect.Success<typeof GhService>;
  diffCache: Effect.Effect.Success<typeof DiffCacheService>;
  prContext: Effect.Effect.Success<typeof PrContextService>;
};

const createRoutes = ({ gh, diffCache, prContext }: RouteServices) => ({
  // tRPC endpoint
  "/api/trpc/*": (req: Request) =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext,
    }),

  // REST endpoint: /api/pr/file-diff (used by OpenCode pr_diff tool)
  "/api/pr/file-diff": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const sessionId = url.searchParams.get("sessionId");
      const file = url.searchParams.get("file");
      const startLine = url.searchParams.get("startLine");
      const endLine = url.searchParams.get("endLine");

      if (!sessionId || !file) {
        return Response.json({ error: "Missing sessionId or file" }, { status: 400 });
      }

      try {
        const prUrl = await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId));

        if (!prUrl) {
          return Response.json({ error: "Session not found. Load a PR first." }, { status: 404 });
        }

        const prDiffs = await runtime.runPromise(diffCache.get(prUrl));

        if (!prDiffs) {
          return Response.json(
            { error: "Diffs not cached. This shouldn't happen." },
            { status: 500 },
          );
        }

        const fileMeta = prDiffs.get(file);
        if (!fileMeta) {
          return Response.json({ error: `No diff found for file: ${file}` }, { status: 404 });
        }

        let diffOutput = fileMeta.diff;
        if (startLine !== null || endLine !== null) {
          diffOutput = filterDiffByLineRange(
            diffOutput,
            startLine ? parseInt(startLine, 10) : undefined,
            endLine ? parseInt(endLine, 10) : undefined,
          );
        }

        return Response.json({ diff: diffOutput });
      } catch (error) {
        return Response.json({ error: getErrorMessage(error) }, { status: 500 });
      }
    },
  },

  // REST endpoint: /api/pr/metadata (used by OpenCode pr_metadata tool)
  "/api/pr/metadata": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const sessionId = url.searchParams.get("sessionId");

      if (!sessionId) {
        return Response.json({ error: "Missing sessionId" }, { status: 400 });
      }

      try {
        const prUrl = await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId));

        if (!prUrl) {
          return Response.json({ error: "Session not found. Load a PR first." }, { status: 404 });
        }

        // Fetch PR status and diffs in parallel
        const [prStatus, prDiffs] = await runtime.runPromise(
          Effect.all([gh.getPrStatus(prUrl), diffCache.get(prUrl)], {
            concurrency: "unbounded",
          }),
        );

        const fileStats: string[] = [];
        const files: string[] = [];

        if (prDiffs) {
          for (const [f, fileMeta] of prDiffs) {
            files.push(f);
            const { totalAdded, totalRemoved, hunks } = fileMeta;
            if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
              const ranges = hunks
                .map((h) => `${h.newStart}-${h.newStart + h.newCount - 1}`)
                .join(", ");
              fileStats.push(`${f} +${totalAdded} -${totalRemoved} [hunks: ${ranges}]`);
            } else {
              fileStats.push(`${f} +${totalAdded} -${totalRemoved}`);
            }
          }
        }

        const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        const owner = match?.[1] ?? "unknown";
        const repo = match?.[2] ?? "unknown";
        const number = match?.[3] ?? "?";

        const description = prStatus.body
          ? prStatus.body.length > 500
            ? prStatus.body.slice(0, 500) + "..."
            : prStatus.body
          : "(no description)";

        const metadata = `PR: ${owner}/${repo}#${number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}

Description:
${description}

Files (${files.length} changed):
${fileStats.join("\n")}`;

        return Response.json({ metadata });
      } catch (error) {
        return Response.json({ error: getErrorMessage(error) }, { status: 500 });
      }
    },
  },
});

// =============================================================================
// Main Application Effect
// =============================================================================

const main = Effect.gen(function* () {
  // Get services from the shared runtime
  const gh = yield* GhService;
  const diffCache = yield* DiffCacheService;
  const prContext = yield* PrContextService;

  const routes = createRoutes({ gh, diffCache, prContext });

  const server = Bun.serve({
    port: Number(process.env.API_PORT ?? 3001),
    routes,
    // Fallback for static files in production
    fetch: isProduction ? (req) => serveStatic(new URL(req.url).pathname) : undefined,
  });

  yield* Effect.log(`API server running at http://localhost:${server.port}`);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      console.log("[Shutdown] Stopping server...");
      server.stop();
    }),
  );

  yield* Effect.never;
});

// =============================================================================
// Run the application using the shared runtime
// =============================================================================

declare global {
  var __appFiber: Fiber.RuntimeFiber<void, unknown> | undefined;
  var __shutdownHandler: (() => void) | undefined;
}

if (globalThis.__appFiber) {
  console.log("[HMR] Stopping previous instance...");
  await Effect.runPromise(Fiber.interrupt(globalThis.__appFiber)).catch(() => {});
}

if (globalThis.__shutdownHandler) {
  process.off("SIGINT", globalThis.__shutdownHandler);
  process.off("SIGTERM", globalThis.__shutdownHandler);
}

const fiber = runtime.runFork(Effect.scoped(main));
globalThis.__appFiber = fiber;

const shutdown = () => {
  console.log("\n[Shutdown] Received signal, stopping...");
  Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    console.log("[Shutdown] Complete");
    process.exit(0);
  });
};
globalThis.__shutdownHandler = shutdown;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    console.log("[HMR] Disposing...");
    await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
    globalThis.__appFiber = undefined;
  });
}
