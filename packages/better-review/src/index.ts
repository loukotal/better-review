import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve, type ServerType } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Effect } from "effect";
import { Hono, type Context } from "hono";

import type { ReviewSessionAnnotation } from "@better-review/shared";
import { isGitHubAssetId } from "@better-review/shared/github-asset";

import { ReviewSessionService } from "./agent-sessions";
import { runCommand } from "./command";
import { filterDiffByLineRange, type FileDiffMeta, type HunkInfo } from "./diff";
import { createFlueReviewApp } from "./flue/runtime";
import { GhService, type PrStatus } from "./gh/gh";
import { PrCheckoutService } from "./pr-checkout";
import { getErrorMessage } from "./response";
import { runtime } from "./runtime";
import { DiffCacheService, PrContextService, PrListCacheService } from "./state";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";

// =============================================================================
// Static File Serving (Production)
// =============================================================================

const isProduction = process.env.NODE_ENV === "production";
const currentDir = fileURLToPath(new URL(".", import.meta.url));
const staticDir = process.env.BETTER_REVIEW_STATIC_DIR
  ? path.resolve(process.env.BETTER_REVIEW_STATIC_DIR)
  : path.resolve(currentDir, "../../web/dist");
const repoRoot = path.resolve(currentDir, "../../..");
const devTokenFile = path.join(repoRoot, ".better-review-api-token");
const webPort = process.env.WEB_PORT ?? "3000";
const allowedDevOrigins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]);

function readDevTokenFile(): string | null {
  if (!existsSync(devTokenFile)) return null;
  const token = readFileSync(devTokenFile, "utf8").trim();
  return token.length > 0 ? token : null;
}

const apiToken = process.env.BETTER_REVIEW_API_TOKEN?.trim() || readDevTokenFile();
const apiAuthDisabled = process.env.BETTER_REVIEW_DISABLE_API_AUTH === "1";
const apiTokenCookieName = "better_review_api_token";

if (!apiToken && !apiAuthDisabled) {
  throw new Error(
    "BETTER_REVIEW_API_TOKEN is required. Run `pnpm dev` to create a dev token file, or set BETTER_REVIEW_DISABLE_API_AUTH=1 only for temporary local development.",
  );
}

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function getContentType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".wasm":
      return "application/wasm";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return undefined;
  }
}

async function fileResponse(filePath: string, headers: HeadersInit = {}): Promise<Response> {
  const responseHeaders = new Headers(headers);
  const contentType = getContentType(filePath);
  if (contentType && !responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", contentType);
  }

  return new Response(await readFile(filePath), { headers: responseHeaders });
}

function getStaticHtmlHeaders(): Record<string, string> {
  if (!apiToken || apiAuthDisabled) return {};
  return {
    "Set-Cookie": `${apiTokenCookieName}=${encodeURIComponent(apiToken)}; Path=/api; SameSite=Strict`,
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }

  const resolved = resolveStaticFilePath(pathname);
  if (resolved) {
    if (await fileExists(resolved)) {
      const headers =
        path.extname(resolved).toLowerCase() === ".html" ? getStaticHtmlHeaders() : {};
      return fileResponse(resolved, headers);
    }
  }

  return fileResponse(path.join(staticDir, "index.html"), {
    "Content-Type": "text/html",
    ...getStaticHtmlHeaders(),
  });
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !allowedDevOrigins.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, trpc-accept, x-trpc-source",
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

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function getRequestToken(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  const connectionParamsToken = getConnectionParamsToken(req);
  if (connectionParamsToken) return connectionParamsToken;

  return getCookie(req, apiTokenCookieName);
}

function getConnectionParamsToken(req: Request): string | null {
  const rawParams = new URL(req.url).searchParams.get("connectionParams");
  if (!rawParams) return null;

  try {
    const params = JSON.parse(rawParams) as { authorization?: unknown };
    const value = typeof params.authorization === "string" ? params.authorization : "";
    return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : null;
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function isPublicApiRequest(req: Request): boolean {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return true;
  if (url.pathname === "/api/sessions/healthcheck") return true;
  if (req.method === "GET" && url.pathname.startsWith("/api/github-asset/")) return true;
  if (
    req.method === "GET" &&
    (url.pathname === "/api/pr/metadata" || url.pathname === "/api/pr/file-diff")
  ) {
    return true;
  }
  return false;
}

function requireApiAuth(req: Request): Response | null {
  if (apiAuthDisabled || !apiToken || isPublicApiRequest(req)) return null;

  const requestToken = getRequestToken(req);
  if (!requestToken || !constantTimeEqual(requestToken, apiToken)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

// =============================================================================
// Request Logging
// =============================================================================

const activeRequests = new Map<string, { method: string; path: string; start: number }>();
let requestCounter = 0;

function formatRequestPath(url: URL): string {
  const redacted = new URL(url);
  if (redacted.searchParams.has("connectionParams")) {
    redacted.searchParams.set("connectionParams", "[redacted]");
  }
  return redacted.pathname + redacted.search;
}

function loggedHandler<T extends (req: Request) => Response | Promise<Response>>(handler: T): T {
  return ((req: Request) => {
    const id = String(++requestCounter);
    const url = new URL(req.url);
    const method = req.method;
    const path = formatRequestPath(url);
    const start = Date.now();
    const quietPendingResultPoll =
      method === "GET" && /^\/api\/sessions\/[^/]+\/result(?:\?|$)/.test(path);

    if (!quietPendingResultPoll) {
      activeRequests.set(id, { method, path, start });
      console.log(`[req] --> ${method} ${path} (id=${id})`);
    }

    const cleanup = (status: number) => {
      activeRequests.delete(id);
      if (quietPendingResultPoll && status === 204) return;
      const duration = Date.now() - start;
      console.log(`[req] <-- ${method} ${path} ${status} ${duration}ms (id=${id})`);
    };

    try {
      const authError = requireApiAuth(req);
      if (authError) {
        cleanup(authError.status);
        return authError;
      }

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

type FetchHandler = (req: Request) => Response | Promise<Response>;

function runHandler(handler: FetchHandler) {
  return (c: Context) => handler(c.req.raw);
}

function registerRoutes(app: Hono, routes: Record<string, unknown>): void {
  for (const [pattern, route] of Object.entries(routes)) {
    if (typeof route === "function") {
      app.all(pattern, runHandler(route as FetchHandler));
      continue;
    }

    if (route && typeof route === "object") {
      for (const [method, fn] of Object.entries(route as Record<string, unknown>)) {
        if (typeof fn === "function") {
          app.on(method, pattern, runHandler(fn as FetchHandler));
        }
      }
      app.all(pattern, () => new Response("Method Not Allowed", { status: 405 }));
    }
  }
}

function createApp(routes: Record<string, unknown>): Hono {
  const app = new Hono();

  registerRoutes(app, routes);
  app.route("/flue", createFlueReviewApp());

  app.notFound((c) => {
    if (isProduction) {
      return serveStatic(new URL(c.req.raw.url).pathname);
    }

    return new Response("Not Found", { status: 404 });
  });

  app.onError((error) => {
    console.error("[server] Request failed:", error);
    return new Response("Internal Server Error", { status: 500 });
  });

  return app;
}

async function startServer(app: Hono, hostname: string, port: number): Promise<ServerType> {
  const server = await new Promise<ServerType>((resolve, reject) => {
    let didListen = false;
    let server: ServerType;

    const onError = (error: Error) => {
      if (didListen) {
        console.error("[server] Server error:", error);
        return;
      }

      reject(error);
    };

    server = serve(
      {
        fetch: app.fetch,
        hostname,
        port,
      },
      () => {
        didListen = true;
        server.off("error", onError);
        resolve(server);
      },
    );

    server.once("error", onError);
  });

  if ("keepAliveTimeout" in server) {
    server.keepAliveTimeout = 255_000;
  }
  if ("requestTimeout" in server) {
    server.requestTimeout = 255_000;
  }

  return server;
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

async function gitShowFile(
  repoRoot: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  if (!isSafeRepoRelativePath(filePath)) return null;
  const { stdout, exitCode } = await runCommand("git", [
    "-C",
    repoRoot,
    "show",
    `${ref}:${filePath}`,
  ]);
  return exitCode === 0 ? stdout : null;
}

async function gitShowIndexFile(repoRoot: string, filePath: string): Promise<string | null> {
  if (!isSafeRepoRelativePath(filePath)) return null;
  const { stdout, exitCode } = await runCommand("git", ["-C", repoRoot, "show", `:${filePath}`]);
  return exitCode === 0 ? stdout : null;
}

function parseCommitRangeVariantId(
  variantId: string | undefined,
): { baseSha: string; headSha: string } | null {
  if (!variantId?.startsWith("commit-range:")) return null;
  const [, baseSha, headSha] = variantId.split(":");
  if (!baseSha || !headSha) return null;
  if (!/^[0-9a-fA-F]{7,40}$/.test(baseSha) || !/^[0-9a-fA-F]{7,40}$/.test(headSha)) return null;
  return { baseSha, headSha };
}

async function readWorkingTreeFile(repoRoot: string, filePath: string): Promise<string | null> {
  const resolved = resolveRepoFilePath(repoRoot, filePath);
  if (!resolved) return null;
  try {
    return await readFile(resolved, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isSafeRepoRelativePath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return false;
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return false;
  return true;
}

function resolveRepoFilePath(repoRoot: string, filePath: string): string | null {
  if (!isSafeRepoRelativePath(filePath)) return null;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, filePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

type RouteServices = {
  gh: GhService;
  diffCache: DiffCacheService;
  prContext: PrContextService;
  reviewSessions: ReviewSessionService;
};

const createRoutes = ({ gh, diffCache, prContext, reviewSessions }: RouteServices) => ({
  // Proxy for GitHub assets (images/videos in PR descriptions)
  // This bypasses CORS/ORB issues by fetching through the server with auth
  "/api/github-asset/*": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      // Extract the asset ID from the path: /api/github-asset/{asset-id}
      const assetId = url.pathname.replace("/api/github-asset/", "");

      if (!assetId || !isGitHubAssetId(assetId)) {
        return new Response("Invalid asset ID", { status: 400 });
      }

      const githubUrl = `https://github.com/user-attachments/assets/${assetId}`;

      try {
        // Get GitHub token using gh CLI
        const tokenResult = await runCommand("gh", ["auth", "token"]);
        if (tokenResult.exitCode !== 0) {
          throw new Error(tokenResult.stderr.trim() || "gh auth token failed");
        }
        const token = tokenResult.stdout.trim();

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
            "Cache-Control": "private, max-age=31536000, immutable",
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

  "/api/sessions/healthcheck": {
    GET: () => Response.json({ ok: true }),
  },

  "/api/sessions": {
    POST: async (req: Request) => {
      try {
        const body = (await req.json()) as {
          mode?: "plan" | "message" | "diff";
          origin?: string;
          title?: string;
          cwd?: string;
          repoRoot?: string;
          payload?:
            | { kind: "markdown"; content: string }
            | { kind: "message"; content: string }
            | {
                kind: "diff";
                rawPatch: string;
                label?: string;
                selectedVariantId?: string;
                variants?: Array<{
                  id: string;
                  label: string;
                  description?: string;
                  rawPatch: string;
                }>;
              };
          returnChannel?: { type: "stdout" | "http"; endpoint?: string };
        };

        if (!body.mode || !body.title || !body.payload) {
          return Response.json({ error: "Missing mode, title, or payload" }, { status: 400 });
        }

        const session = await runtime.runPromise(
          reviewSessions.createSession({
            mode: body.mode,
            origin: body.origin ?? "manual",
            title: body.title,
            cwd: body.cwd,
            repoRoot: body.repoRoot,
            payload: body.payload,
            returnChannel: body.returnChannel,
          }),
        );

        return Response.json(session, { status: 201 });
      } catch (error) {
        return Response.json({ error: getErrorMessage(error) }, { status: 500 });
      }
    },
  },

  "/api/sessions/*": {
    GET: async (req: Request) => {
      try {
        const url = new URL(req.url);
        const parts = url.pathname.split("/").filter(Boolean);
        const sessionId = parts[2];
        const resource = parts[3];

        if (!sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        if (resource === "result") {
          const result = await runtime.runPromise(reviewSessions.getResult(sessionId));
          if (!result) {
            return new Response(null, { status: 204 });
          }
          return Response.json(result);
        }

        if (resource === "commits") {
          const session = await runtime.runPromise(reviewSessions.getSession(sessionId));
          if (!session) {
            return Response.json({ error: "Session not found" }, { status: 404 });
          }

          const repoRoot = session.repoRoot ?? session.cwd;
          if (!repoRoot) {
            return Response.json({ error: "Session has no repoRoot/cwd" }, { status: 400 });
          }

          const { stdout, stderr, exitCode } = await runCommand("git", [
            "-C",
            repoRoot,
            "log",
            "--max-count=100",
            "--pretty=format:%H%x00%h%x00%s",
          ]);
          if (exitCode !== 0) {
            return Response.json({ error: stderr || "Failed to list commits" }, { status: 500 });
          }

          return Response.json({
            commits: stdout
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [sha, shortSha, subject] = line.split("\0");
                return { sha, shortSha, subject };
              }),
          });
        }

        if (resource === "diff") {
          const baseSha = url.searchParams.get("baseSha");
          const session = await runtime.runPromise(reviewSessions.getSession(sessionId));
          if (!session) {
            return Response.json({ error: "Session not found" }, { status: 404 });
          }

          const repoRoot = session.repoRoot ?? session.cwd;
          if (!repoRoot || !baseSha || !/^[0-9a-fA-F]{7,40}$/.test(baseSha)) {
            return Response.json({ error: "Missing or invalid baseSha" }, { status: 400 });
          }

          const head = await runCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
          if (head.exitCode !== 0) {
            return Response.json(
              { error: head.stderr || "Failed to resolve HEAD" },
              { status: 500 },
            );
          }
          const headSha = head.stdout.trim();

          const diff = await runCommand("git", ["-C", repoRoot, "diff", baseSha, headSha]);
          if (diff.exitCode !== 0) {
            return Response.json({ error: diff.stderr || "Failed to build diff" }, { status: 500 });
          }

          return Response.json({ rawPatch: diff.stdout, headSha });
        }

        if (resource === "file-content") {
          const filePath = url.searchParams.get("path");
          const prevPath = url.searchParams.get("prevPath") ?? undefined;
          const variantId = url.searchParams.get("variantId") ?? undefined;

          if (!filePath) {
            return Response.json({ error: "Missing path" }, { status: 400 });
          }

          const session = await runtime.runPromise(reviewSessions.getSession(sessionId));
          if (!session) {
            return Response.json({ error: "Session not found" }, { status: 404 });
          }

          const prUrl = await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId));
          const repoRoot = session.repoRoot ?? session.cwd;
          const sessionScope = await runtime.runPromise(prContext.getSessionScope(sessionId));

          const selectedVariant =
            session.payload.kind === "diff"
              ? (session.payload.variants ?? []).find((variant) => variant.id === variantId)
              : undefined;
          const rangeVariant = parseCommitRangeVariantId(variantId);
          const contentSource =
            selectedVariant?.contentSource ??
            (rangeVariant ? { kind: "git-refs" as const, ...rangeVariant } : undefined);

          if (repoRoot && contentSource) {
            if (contentSource.kind === "unstaged") {
              const [oldContent, newContent] = await Promise.all([
                gitShowIndexFile(repoRoot, prevPath ?? filePath),
                readWorkingTreeFile(repoRoot, filePath),
              ]);
              if (oldContent !== null || newContent !== null) {
                return Response.json({ oldContent, newContent, source: "local-unstaged" });
              }
            }

            if (contentSource.kind === "staged") {
              const headSha = contentSource.headSha;
              const [oldContent, newContent] = await Promise.all([
                headSha
                  ? gitShowFile(repoRoot, headSha, prevPath ?? filePath)
                  : Promise.resolve(null),
                gitShowIndexFile(repoRoot, filePath),
              ]);
              if (oldContent !== null || newContent !== null) {
                return Response.json({ oldContent, newContent, source: "local-staged" });
              }
            }

            if (contentSource.kind === "commit" || contentSource.kind === "git-refs") {
              const [oldContent, newContent] = await Promise.all([
                gitShowFile(repoRoot, contentSource.baseSha, prevPath ?? filePath),
                gitShowFile(repoRoot, contentSource.headSha, filePath),
              ]);
              if (oldContent !== null || newContent !== null) {
                return Response.json({ oldContent, newContent, source: "local-git" });
              }
            }
          }

          let oldRef: string | null = null;
          let newRef: string | null = null;

          if (
            contentSource &&
            (contentSource.kind === "commit" || contentSource.kind === "git-refs")
          ) {
            oldRef = contentSource.baseSha;
            newRef = contentSource.headSha;
          } else if (sessionScope.mode === "commit" && sessionScope.commitSha) {
            oldRef = `${sessionScope.commitSha}^`;
            newRef = sessionScope.commitSha;
          } else if (prUrl) {
            [oldRef, newRef] = await runtime.runPromise(
              Effect.all([gh.getBaseSha(prUrl), gh.getHeadSha(prUrl)], { concurrency: 2 }),
            );
          }

          if (repoRoot && oldRef && newRef) {
            const [oldContent, newContent] = await Promise.all([
              gitShowFile(repoRoot, oldRef, prevPath ?? filePath),
              gitShowFile(repoRoot, newRef, filePath),
            ]);

            if (oldContent !== null || newContent !== null) {
              return Response.json({ oldContent, newContent, source: "local" });
            }
          }

          if (prUrl && oldRef && newRef) {
            const { owner, repo } = await runtime.runPromise(gh.getPrInfo(prUrl));
            const oldPath = prevPath ?? filePath;

            const [oldContent, newContent] = await runtime.runPromise(
              Effect.all(
                [
                  gh
                    .getFileContent({ owner, repo, path: oldPath, ref: oldRef })
                    .pipe(Effect.catchAll(() => Effect.succeed(null))),
                  gh
                    .getFileContent({ owner, repo, path: filePath, ref: newRef })
                    .pipe(Effect.catchAll(() => Effect.succeed(null))),
                ],
                { concurrency: 2 },
              ),
            );

            return Response.json({ oldContent, newContent, source: "github" });
          }

          return Response.json(
            { error: "Unable to resolve file contents for this session" },
            { status: 404 },
          );
        }

        if (resource) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        const session = await runtime.runPromise(reviewSessions.getSession(sessionId));
        if (!session) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const prUrl = await runtime.runPromise(prContext.getPrUrlBySessionId(sessionId));

        return Response.json({
          ...session,
          prUrl,
        });
      } catch (error) {
        return Response.json({ error: getErrorMessage(error) }, { status: 500 });
      }
    },

    POST: async (req: Request) => {
      try {
        const url = new URL(req.url);
        const parts = url.pathname.split("/").filter(Boolean);
        const sessionId = parts[2];
        const resource = parts[3];

        if (!sessionId || resource !== "result") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        const session = await runtime.runPromise(reviewSessions.getSession(sessionId));
        if (!session) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const body = (await req.json()) as {
          approved?: boolean;
          feedback?: string;
          annotations?: ReviewSessionAnnotation[];
        };

        if (typeof body.approved !== "boolean") {
          return Response.json({ error: "Missing approved boolean" }, { status: 400 });
        }

        const result = await runtime.runPromise(
          reviewSessions.submitResult(sessionId, {
            mode: session.mode,
            approved: body.approved,
            feedback: body.feedback ?? "",
            annotations: body.annotations ?? [],
          }),
        );

        return Response.json(result, { status: 201 });
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
  const reviewSessions = yield* ReviewSessionService;
  const checkout = yield* PrCheckoutService;

  // Start the PR list background refresh loop (fetches every 15 min)
  yield* prListCache.backgroundLoop.pipe(
    Effect.catchAll((e) => Effect.log(`[pr-list-cache] Background loop exited: ${e}`)),
    Effect.forkScoped,
  );
  yield* checkout.backgroundCleanupLoop.pipe(
    Effect.catchAll((e) => Effect.log(`[worktree-cleanup] Background loop exited: ${e}`)),
    Effect.forkScoped,
  );

  const app = createApp(logRoutes(createRoutes({ gh, diffCache, prContext, reviewSessions })));

  // Local-first: avoid exposing an API that can shell out to `gh` on the LAN by default.
  const host = process.env.API_HOST ?? "127.0.0.1";
  const server = yield* Effect.tryPromise(() =>
    startServer(app, host, Number(process.env.API_PORT ?? 3001)),
  );
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : (process.env.API_PORT ?? 3001);
  yield* Effect.log(`API server running at http://${host}:${actualPort}`);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      console.log("[Shutdown] Stopping server...");
      clearInterval(stallChecker);
      server.close();
    }),
  );

  yield* Effect.never;
});

await runtime.runPromise(Effect.scoped(main));
