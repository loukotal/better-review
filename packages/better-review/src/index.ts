import path from "node:path";

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Effect, Fiber } from "effect";

import { filterDiffByLineRange } from "./diff";
import { GhService } from "./gh/gh";
import { getErrorMessage } from "./response";
import { runtime } from "./runtime";
import { DiffCacheService, PrContextService, PrListCacheService } from "./state";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";

// =============================================================================
// Static File Serving (Production)
// =============================================================================

const isProduction = process.env.NODE_ENV === "production";
const staticDir = path.resolve(import.meta.dir, "../../web/dist");

if (isProduction) {
  console.log(`[static] Production mode enabled, serving from: ${staticDir}`);
}

function resolveStaticFilePath(urlPathname: string): string | null {
  // Treat the pathname as a URL path, normalize it, and ensure it stays within staticDir.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  const normalized = path.posix.normalize(decoded);
  const rel = normalized.replace(/^\/+/, "");
  const abs = path.resolve(staticDir, rel);
  const staticDirWithSep = staticDir.endsWith(path.sep) ? staticDir : staticDir + path.sep;
  if (abs !== staticDir && !abs.startsWith(staticDirWithSep)) return null;
  return abs;
}

async function serveStatic(pathname: string): Promise<Response> {
  const resolved = resolveStaticFilePath(pathname);
  if (resolved) {
    const file = Bun.file(resolved);

    if (await file.exists()) {
      return new Response(file);
    }
  }

  return new Response(Bun.file(`${staticDir}/index.html`), {
    headers: { "Content-Type": "text/html" },
  });
}

// =============================================================================
// Route Handlers
// =============================================================================

function parseOptionalPositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (value.trim() === "") return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

type RouteServices = {
  gh: Effect.Effect.Success<typeof GhService>;
  diffCache: Effect.Effect.Success<typeof DiffCacheService>;
  prContext: Effect.Effect.Success<typeof PrContextService>;
};

const createRoutes = ({ gh, diffCache, prContext }: RouteServices) => ({
  // Proxy for GitHub assets (images/videos in PR descriptions)
  // This bypasses CORS/ORB issues by fetching through the server with auth
  "/api/github-asset/*": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      // Extract the asset ID from the path: /api/github-asset/{asset-id}
      const assetId = url.pathname.replace("/api/github-asset/", "");

      if (!assetId) {
        return new Response("Missing asset ID", { status: 400 });
      }

      const githubUrl = `https://github.com/user-attachments/assets/${assetId}`;

      try {
        // Get GitHub token using gh CLI
        const token = await Bun.$`gh auth token`.text().then((t) => t.trim());

        const response = await fetch(githubUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "*/*",
          },
          redirect: "follow",
        });

        if (!response.ok) {
          return new Response(`Failed to fetch asset: ${response.status}`, {
            status: response.status,
          });
        }

        // Forward the response with proper content-type
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const body = await response.arrayBuffer();

        return new Response(body, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch (error) {
        console.error("Failed to proxy GitHub asset:", error);
        return new Response("Failed to fetch asset", { status: 500 });
      }
    },
  },

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
      const startLineRaw = url.searchParams.get("startLine");
      const endLineRaw = url.searchParams.get("endLine");

      if (!sessionId || !file) {
        return Response.json({ error: "Missing sessionId or file" }, { status: 400 });
      }

      const startLine = parseOptionalPositiveInt(startLineRaw);
      const endLine = parseOptionalPositiveInt(endLineRaw);
      if (startLineRaw !== null && startLine === undefined) {
        return Response.json({ error: "Invalid startLine" }, { status: 400 });
      }
      if (endLineRaw !== null && endLine === undefined) {
        return Response.json({ error: "Invalid endLine" }, { status: 400 });
      }
      if (
        startLine !== undefined &&
        endLine !== undefined &&
        Number.isFinite(startLine) &&
        Number.isFinite(endLine) &&
        startLine > endLine
      ) {
        return Response.json({ error: "startLine must be <= endLine" }, { status: 400 });
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
        if (startLine !== undefined || endLine !== undefined) {
          diffOutput = filterDiffByLineRange(diffOutput, startLine, endLine);
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
  const prListCache = yield* PrListCacheService;

  // Start the PR list background refresh loop (fetches every 15 min)
  yield* prListCache.backgroundLoop.pipe(
    Effect.catchAll((e) => Effect.log(`[pr-list-cache] Background loop exited: ${e}`)),
    Effect.forkScoped,
  );

  const routes = createRoutes({ gh, diffCache, prContext });

  const server = Bun.serve({
    // Local-first: avoid exposing an API that can shell out to `gh` on the LAN by default.
    hostname: process.env.API_HOST ?? "127.0.0.1",
    port: Number(process.env.API_PORT ?? 3001),
    routes,
    idleTimeout: 255,
    // Fallback for static files in production
    fetch: isProduction ? (req) => serveStatic(new URL(req.url).pathname) : undefined,
  });

  const host = process.env.API_HOST ?? "127.0.0.1";
  yield* Effect.log(`API server running at http://${host}:${server.port}`);

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
