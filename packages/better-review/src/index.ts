import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./trpc/routers";
import { createContext, runtime } from "./trpc/context";
import { Effect, Fiber } from "effect";
import { GhService } from "./gh/gh";
import { OpencodeService } from "./opencode";
import { DiffCacheService, PrContextService } from "./state";
import { buildReviewContext, getErrorMessage } from "./response";
import { filterDiffByLineRange } from "./diff";

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
// Main Application Effect
// =============================================================================

const main = Effect.gen(function* () {
  const gh = yield* GhService;
  const opencode = yield* OpencodeService;
  const diffCache = yield* DiffCacheService;
  const prContext = yield* PrContextService;

  const server = Bun.serve({
    port: Number(process.env.API_PORT ?? 3001),

    fetch: async (req) => {
      const url = new URL(req.url);

      // tRPC endpoint - handles all API requests
      if (url.pathname.startsWith("/api/trpc")) {
        return fetchRequestHandler({
          endpoint: "/api/trpc",
          req,
          router: appRouter,
          createContext,
        });
      }

      // REST endpoint: /api/pr/file-diff
      // Used by OpenCode pr_diff tool (can't use tRPC directly)
      if (url.pathname === "/api/pr/file-diff" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        const file = url.searchParams.get("file");
        const startLine = url.searchParams.get("startLine");
        const endLine = url.searchParams.get("endLine");

        if (!sessionId || !file) {
          return Response.json(
            { error: "Missing sessionId or file" },
            { status: 400 }
          );
        }

        return runtime.runPromise(
          Effect.gen(function* () {
            // O(1) lookup of PR URL from session
            const prUrl = yield* prContext.getPrUrlBySessionId(sessionId);

            if (!prUrl) {
              return Response.json(
                { error: "Session not found. Load a PR first." },
                { status: 404 }
              );
            }

            yield* Effect.log(
              `[file-diff] Session ${sessionId} -> PR ${prUrl}, file: ${file}`
            );

            // Get from cache
            const prDiffs = yield* diffCache.get(prUrl);
            if (!prDiffs) {
              return Response.json(
                { error: "Diffs not cached. This shouldn't happen." },
                { status: 500 }
              );
            }

            const fileMeta = prDiffs.get(file);
            if (!fileMeta) {
              return Response.json(
                { error: `No diff found for file: ${file}` },
                { status: 404 }
              );
            }

            // Filter by line range if specified
            let diffOutput = fileMeta.diff;
            if (startLine !== null || endLine !== null) {
              diffOutput = filterDiffByLineRange(
                diffOutput,
                startLine ? parseInt(startLine, 10) : undefined,
                endLine ? parseInt(endLine, 10) : undefined
              );
            }

            yield* Effect.log(
              `[file-diff] Returning diff for ${file} (${diffOutput.length} chars)`
            );
            return Response.json({ diff: diffOutput });
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(
                Response.json(
                  { error: getErrorMessage(error) },
                  { status: 500 }
                )
              )
            )
          )
        );
      }

      // REST endpoint: /api/pr/metadata
      // Used by OpenCode pr_metadata tool (can't use tRPC directly)
      if (url.pathname === "/api/pr/metadata" && req.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        return runtime.runPromise(
          Effect.gen(function* () {
            // O(1) lookup of PR URL from session
            const prUrl = yield* prContext.getPrUrlBySessionId(sessionId);

            if (!prUrl) {
              return Response.json(
                { error: "Session not found. Load a PR first." },
                { status: 404 }
              );
            }

            yield* Effect.log(`[metadata] Session ${sessionId} -> PR ${prUrl}`);

            // Get PR status (includes description)
            const prStatus = yield* gh.getPrStatus(prUrl);

            // Get cached diffs and compute line counts
            const prDiffs = yield* diffCache.get(prUrl);
            const fileStats: string[] = [];
            const files: string[] = [];

            if (prDiffs) {
              for (const [file, fileMeta] of prDiffs) {
                files.push(file);
                const { totalAdded, totalRemoved, hunks } = fileMeta;
                // Show hunk ranges for large files (>1k lines changed)
                if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
                  const ranges = hunks
                    .map((h) => `${h.newStart}-${h.newStart + h.newCount - 1}`)
                    .join(", ");
                  fileStats.push(
                    `${file} +${totalAdded} -${totalRemoved} [hunks: ${ranges}]`
                  );
                } else {
                  fileStats.push(`${file} +${totalAdded} -${totalRemoved}`);
                }
              }
            }

            // Parse owner/repo/number from PR URL
            const match = prUrl.match(
              /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
            );
            const owner = match?.[1] ?? "unknown";
            const repo = match?.[2] ?? "unknown";
            const number = match?.[3] ?? "?";

            // Build compact text output
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
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(
                Response.json(
                  { error: getErrorMessage(error) },
                  { status: 500 }
                )
              )
            )
          )
        );
      }

      // Legacy endpoint: /api/opencode/session
      // This is a complex endpoint that combines session management with context injection
      // Keeping it as REST for now due to its complexity
      if (url.pathname === "/api/opencode/session" && req.method === "POST") {
        const body = (await req.json()) as {
          prUrl: string;
          prNumber: number;
          repoOwner: string;
          repoName: string;
          files: string[];
        };

        if (!body.prUrl) {
          return Response.json({ error: "Missing prUrl" }, { status: 400 });
        }

        return runtime.runPromise(
          Effect.gen(function* () {
            yield* Effect.log("[API] Request body:", {
              ...body,
              files: `[${body.files?.length || 0} files]`,
            });

            // Fetch current head SHA from GitHub
            const currentHeadSha = yield* gh.getHeadSha(body.prUrl);
            yield* Effect.log("[API] Current head SHA:", currentHeadSha);

            // Set current PR context
            yield* prContext.setCurrent(body.prUrl, body.files, {
              owner: body.repoOwner,
              repo: body.repoName,
              number: String(body.prNumber),
            });

            // Pre-cache all diffs for this PR
            yield* Effect.log("[API] Pre-caching diffs...");
            yield* diffCache.getOrFetch(body.prUrl);

            // Write PR context file for custom tools
            yield* Effect.log("[API] Writing PR context file...");
            yield* Effect.tryPromise(() =>
              Bun.write(
                ".opencode/.current-pr.json",
                JSON.stringify({
                  url: body.prUrl,
                  owner: body.repoOwner,
                  repo: body.repoName,
                  number: body.prNumber,
                  files: body.files,
                }),
              ),
            );

            // Check persistent storage for existing sessions
            const { sessions, activeSessionId } =
              yield* prContext.listSessions(body.prUrl);
            yield* Effect.log(
              `[API] Found ${sessions.length} existing sessions, active: ${activeSessionId}`,
            );

            // If we have an active session, try to reuse it
            if (activeSessionId) {
              const activeSession = sessions.find(
                (s) => s.id === activeSessionId,
              );
              if (activeSession) {
                // Check for force-push (HEAD SHA changed since session was created)
                if (activeSession.headSha !== currentHeadSha) {
                  yield* Effect.log(
                    `[API] Force-push detected! Session SHA: ${activeSession.headSha}, Current: ${currentHeadSha}`,
                  );
                  yield* Effect.log("[API] Clearing cached diff...");
                  yield* diffCache.clear(body.prUrl);
                }

                yield* Effect.log("[API] Fetching existing session...");
                const existingSessionData = yield* Effect.tryPromise(() =>
                  opencode.client.session.get({
                    sessionID: activeSessionId,
                  }),
                );

                if (existingSessionData.data) {
                  // Register session → PR mapping for O(1) lookup by tools
                  yield* prContext.registerSession(activeSessionId, body.prUrl);

                  yield* Effect.log(
                    "[API] Reusing session:",
                    activeSessionId,
                  );
                  return Response.json({
                    session: existingSessionData.data,
                    sessions,
                    activeSessionId,
                    existing: true,
                    headSha: currentHeadSha,
                    sessionHeadSha: activeSession.headSha,
                  });
                }
              }
            }

            // No active session or it doesn't exist in OpenCode - create new one
            yield* Effect.log("[API] Creating new session...");
            const session = yield* Effect.tryPromise(() =>
              opencode.client.session.create({
                title: `PR Review: ${body.repoOwner}/${body.repoName}#${body.prNumber}`,
              }),
            );
            yield* Effect.log("[API] Session created:", session.data?.id);

            if (!session.data) {
              return yield* Effect.fail(
                new Error("Failed to create session"),
              );
            }

            // Persist to storage
            const prData = yield* prContext.addSession(
              body.prUrl,
              session.data.id,
              currentHeadSha,
            );

            // Inject initial context (without expecting a reply)
            yield* Effect.log("[API] Injecting context...");
            const contextMessage = buildReviewContext(body);
            yield* Effect.tryPromise(() =>
              opencode.client.session.prompt({
                sessionID: session.data.id,
                parts: [{ type: "text", text: contextMessage }],
                noReply: true,
              }),
            );
            yield* Effect.log("[API] Context injected successfully");

            return Response.json({
              session: session.data,
              sessions: prData.sessions,
              activeSessionId: prData.activeSessionId,
              existing: false,
              headSha: currentHeadSha,
              sessionHeadSha: currentHeadSha,
            });
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(
                Response.json(
                  { error: error instanceof Error ? error.message : String(error) },
                  { status: 500 },
                ),
              ),
            ),
          ),
        );
      }

      // Static file serving for production mode
      if (isProduction) {
        return serveStatic(url.pathname);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  yield* Effect.log(`API server running at http://localhost:${server.port}`);

  // Add finalizer to stop server on cleanup
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      console.log("[Shutdown] Stopping server...");
      server.stop();
    }),
  );

  // Keep the effect alive until interrupted
  yield* Effect.never;
});

// =============================================================================
// Run the application
// =============================================================================

// Import layers from context (reuses the same runtime)
import { Layer } from "effect";
import { GhServiceLive } from "./gh/gh";

const layers = Layer.mergeAll(
  GhServiceLive,
  OpencodeService.Default,
  DiffCacheService.Default,
  PrContextService.Default,
);

const runnable = main.pipe(Effect.scoped, Effect.provide(layers));

// Store fiber and shutdown handler globally for HMR
declare global {
  var __appFiber: Fiber.RuntimeFiber<void, unknown> | undefined;
  var __shutdownHandler: (() => void) | undefined;
}

// If there's an existing fiber from a previous HMR cycle, interrupt it first
if (globalThis.__appFiber) {
  console.log("[HMR] Stopping previous instance...");
  await Effect.runPromise(Fiber.interrupt(globalThis.__appFiber)).catch(
    () => {},
  );
}

// Remove old signal handlers to avoid duplicates
if (globalThis.__shutdownHandler) {
  process.off("SIGINT", globalThis.__shutdownHandler);
  process.off("SIGTERM", globalThis.__shutdownHandler);
}

// Run in a fiber so we can interrupt it
const fiber = Effect.runFork(runnable);
globalThis.__appFiber = fiber;

// Handle shutdown signals by interrupting the fiber
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

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    console.log("[HMR] Disposing...");
    await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
    globalThis.__appFiber = undefined;
  });
}
