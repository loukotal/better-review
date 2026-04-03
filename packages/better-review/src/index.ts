import path from "node:path";

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Effect, Fiber, type ServiceMap } from "effect";

import { filterDiffByLineRange, type FileDiffMeta, type HunkInfo } from "./diff";
import { GhService, type PrStatus } from "./gh/gh";
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
const allowedDevOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

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
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }

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

function getCorsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  if (!origin || !allowedDevOrigins.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, trpc-accept, x-trpc-source",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(req))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
// Request Logging
// =============================================================================

const activeRequests = new Map<string, { method: string; path: string; start: number }>();
let requestCounter = 0;

function loggedHandler<T extends (req: Request) => Response | Promise<Response>>(handler: T): T {
  return ((req: Request) => {
    const id = String(++requestCounter);
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname + url.search;
    const start = Date.now();

    activeRequests.set(id, { method, path, start });
    console.log(`[req] --> ${method} ${path} (id=${id})`);

    const cleanup = (status: number) => {
      activeRequests.delete(id);
      const duration = Date.now() - start;
      console.log(`[req] <-- ${method} ${path} ${status} ${duration}ms (id=${id})`);
    };

    try {
      const result = handler(req);
      if (result instanceof Promise) {
        return result.then(
          (res) => {
            cleanup(res.status);
            return res;
          },
          (err) => {
            cleanup(500);
            throw err;
          },
        );
      }
      cleanup(result.status);
      return result;
    } catch (err) {
      cleanup(500);
      throw err;
    }
  }) as T;
}

/** Wrap all handlers in a routes object with request logging */
function logRoutes<T extends Record<string, unknown>>(routes: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [pattern, handler] of Object.entries(routes)) {
    if (typeof handler === "function") {
      wrapped[pattern] = loggedHandler(handler as (req: Request) => Response | Promise<Response>);
    } else if (typeof handler === "object" && handler !== null) {
      // Route with method handlers: { GET: fn, POST: fn, ... }
      const methods: Record<string, unknown> = {};
      for (const [method, fn] of Object.entries(handler as Record<string, unknown>)) {
        if (typeof fn === "function") {
          methods[method] = loggedHandler(fn as (req: Request) => Response | Promise<Response>);
        } else {
          methods[method] = fn;
        }
      }
      wrapped[pattern] = methods;
    } else {
      wrapped[pattern] = handler;
    }
  }
  return wrapped as T;
}

// Periodically log requests that have been running for too long
const STALL_CHECK_INTERVAL = 10_000; // 10s
const STALL_THRESHOLD = 15_000; // 15s

const stallChecker = setInterval(() => {
  const now = Date.now();
  for (const [id, { method, path, start }] of activeRequests) {
    const elapsed = now - start;
    if (elapsed > STALL_THRESHOLD) {
      console.warn(`[req] STALLED: ${method} ${path} has been running for ${elapsed}ms (id=${id})`);
    }
  }
}, STALL_CHECK_INTERVAL);

// Ensure the interval doesn't prevent process exit
stallChecker.unref();

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
  gh: ServiceMap.Service.Shape<typeof GhService>;
  diffCache: ServiceMap.Service.Shape<typeof DiffCacheService>;
  prContext: ServiceMap.Service.Shape<typeof PrContextService>;
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
  "/api/trpc": (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(req) });
    }

    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext,
    }).then((response) => withCors(req, response));
  },

  // tRPC procedure path endpoint
  "/api/trpc/*": (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(req) });
    }

    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router: appRouter,
      createContext,
    }).then((response) => withCors(req, response));
  },

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
        const prUrl = (await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId))) as
          | string
          | null;

        if (!prUrl) {
          return Response.json({ error: "Session not found. Load a PR first." }, { status: 404 });
        }

        const sessionScope = await runtime.runPromise(prContext.getSessionScope(sessionId));

        const prDiffs = (await runtime.runPromise(
          sessionScope.mode === "commit" && sessionScope.commitSha
            ? diffCache.getOrFetchCommit(prUrl, sessionScope.commitSha)
            : diffCache.get(prUrl),
        )) as Map<string, FileDiffMeta> | null;

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
        const prUrl = (await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId))) as
          | string
          | null;

        if (!prUrl) {
          return Response.json({ error: "Session not found. Load a PR first." }, { status: 404 });
        }

        const sessionScope = await runtime.runPromise(prContext.getSessionScope(sessionId));

        const diffEffect =
          sessionScope.mode === "commit" && sessionScope.commitSha
            ? diffCache.getOrFetchCommit(prUrl, sessionScope.commitSha)
            : diffCache.get(prUrl);

        // Fetch PR status and diffs in parallel
        const [prStatus, prDiffs] = (await runtime.runPromise(
          Effect.all([gh.getPrStatus(prUrl), diffEffect], {
            concurrency: "unbounded",
          }),
        )) as [PrStatus, Map<string, FileDiffMeta> | null];

        const fileStats: string[] = [];
        const files: string[] = [];

        if (prDiffs) {
          for (const [f, fileMeta] of prDiffs) {
            files.push(f);
            const { totalAdded, totalRemoved, hunks } = fileMeta;
            if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
              const ranges = hunks
                .map((h: HunkInfo) => `${h.newStart}-${h.newStart + h.newCount - 1}`)
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

        const scopeLine =
          sessionScope.mode === "commit" && sessionScope.commitSha
            ? `Scope: commit ${sessionScope.commitSha.slice(0, 7)}\n`
            : "Scope: full PR\n";

        const metadata = `PR: ${owner}/${repo}#${number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}
${scopeLine}

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
    Effect.catch((e) => Effect.log(`[pr-list-cache] Background loop exited: ${e}`)),
    Effect.forkScoped,
  );

  const routes = logRoutes(createRoutes({ gh, diffCache, prContext }));

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
      clearInterval(stallChecker);
      server.stop();
    }),
  );

  yield* Effect.never;
});

// =============================================================================
// Run the application using the shared runtime
// =============================================================================

declare global {
  var __appFiber: Fiber.Fiber<void, unknown> | undefined;
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
