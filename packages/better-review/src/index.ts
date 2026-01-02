import {
  GhService,
  type AddCommentParams,
  type AddReplyParams,
  type EditCommentParams,
  type DeleteCommentParams,
  type ApprovePrParams,
} from "./gh/gh";
import { Effect, Layer, Fiber } from "effect";
import { createOpenCodeStream, streamToSSEResponse } from "./stream";
import { OpencodeService } from "./opencode";
import { GhServiceLive } from "./gh/gh";
import { filterDiffByLineRange } from "./diff";
import { DiffCacheService, PrContextService } from "./state";
import {
  validationError,
  runJson,
  runResponse,
  buildReviewContext,
} from "./response";

// =============================================================================
// Model/Provider Types and State
// =============================================================================

interface ModelEntry {
  providerId: string;
  modelId: string;
}

// Load providers from JSON file
const providerData: ModelEntry[] = await Bun.file("./provider.json").json();
console.log(`[models] Loaded ${providerData.length} model entries`);

// Current model selection (in-memory, no persistence for now)
let currentModel: ModelEntry = {
  providerId: "anthropic",
  modelId: "claude-opus-4-5",
};

// =============================================================================
// Main Application Effect
// =============================================================================

const layers = Layer.mergeAll(
  GhServiceLive,
  OpencodeService.Default,
  DiffCacheService.Default,
  PrContextService.Default,
);

const main = Effect.gen(function* () {
  const gh = yield* GhService;
  const opencode = yield* OpencodeService;
  const diffCache = yield* DiffCacheService;
  const prContext = yield* PrContextService;

  const server = Bun.serve({
    port: Number(process.env.API_PORT ?? 3001),
    routes: {
      // =========================================================================
      // Model Selection Endpoints
      // =========================================================================

      "/api/models/search": {
        GET: async (req) => {
          const url = new URL(req.url);
          const query = (url.searchParams.get("q") || "").toLowerCase().trim();

          let results: ModelEntry[];

          if (!query) {
            // Return first 50 models if no query
            results = providerData.slice(0, 50);
          } else {
            // Case-insensitive substring search on both providerId and modelId
            results = providerData
              .filter(
                (m) =>
                  m.providerId.toLowerCase().includes(query) ||
                  m.modelId.toLowerCase().includes(query),
              )
              .slice(0, 50);
          }

          return Response.json({ models: results });
        },
      },

      "/api/models/current": {
        GET: async () => {
          return Response.json(currentModel);
        },
        POST: async (req) => {
          const body = (await req.json()) as {
            providerId?: string;
            modelId?: string;
          };

          if (!body.providerId || !body.modelId) {
            return validationError("Missing providerId or modelId");
          }

          // Validate that this model exists in our data
          const exists = providerData.some(
            (m) =>
              m.providerId === body.providerId && m.modelId === body.modelId,
          );

          if (!exists) {
            return validationError(
              `Model not found: ${body.providerId}/${body.modelId}`,
            );
          }

          currentModel = {
            providerId: body.providerId,
            modelId: body.modelId,
          };

          console.log(
            `[models] Model changed to: ${currentModel.providerId}/${currentModel.modelId}`,
          );

          return Response.json({ success: true, model: currentModel });
        },
      },

      // =========================================================================
      // PR Endpoints
      // =========================================================================

      "/api/prs": {
        GET: () =>
          runJson(
            gh.searchReviewRequested().pipe(Effect.map((prs) => ({ prs }))),
          ),
      },
      "/api/prs/ci-status": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(
            gh.getPrCiStatus(prUrl).pipe(Effect.map((ciStatus) => ({ ciStatus }))),
          );
        },
      },
      "/api/pr/diff": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(
            gh.getDiff(prUrl).pipe(Effect.map((diff) => ({ diff }))),
          );
        },
      },
      "/api/pr/info": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(gh.getPrInfo(prUrl));
        },
      },
      "/api/pr/comments": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(
            gh
              .listComments(prUrl)
              .pipe(Effect.map((comments) => ({ comments }))),
          );
        },
      },
      "/api/pr/status": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(gh.getPrStatus(prUrl));
        },
      },
      "/api/pr/commits": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");

          if (!prUrl) {
            return validationError("Missing url parameter");
          }

          return runJson(
            gh.listCommits(prUrl).pipe(Effect.map((commits) => ({ commits }))),
          );
        },
      },
      "/api/pr/commit-diff": {
        GET: (req) => {
          const url = new URL(req.url);
          const prUrl = url.searchParams.get("url");
          const sha = url.searchParams.get("sha");

          if (!prUrl || !sha) {
            return validationError("Missing url or sha parameter");
          }

          return runJson(
            Effect.gen(function* () {
              const { owner, repo } = yield* gh.getPrInfo(prUrl);
              const diff = yield* gh.getCommitDiff({ owner, repo, sha });
              return { diff, sha };
            }),
          );
        },
      },
      "/api/pr/comment": {
        POST: async (req) => {
          const body = (await req.json()) as AddCommentParams;

          if (!body.prUrl || !body.filePath || !body.line || !body.body) {
            return validationError(
              "Missing required fields: prUrl, filePath, line, body",
            );
          }

          return runJson(
            gh.addComment(body).pipe(Effect.map((comment) => ({ comment }))),
          );
        },
      },
      "/api/pr/comment/reply": {
        POST: async (req) => {
          const body = (await req.json()) as AddReplyParams;

          if (!body.prUrl || !body.commentId || !body.body) {
            return validationError(
              "Missing required fields: prUrl, commentId, body",
            );
          }

          return runJson(
            gh
              .replyToComment(body)
              .pipe(Effect.map((comment) => ({ comment }))),
          );
        },
      },
      "/api/pr/comment/edit": {
        POST: async (req) => {
          const body = (await req.json()) as EditCommentParams;

          if (!body.prUrl || !body.commentId || !body.body) {
            return validationError(
              "Missing required fields: prUrl, commentId, body",
            );
          }

          return runJson(
            gh.editComment(body).pipe(Effect.map((comment) => ({ comment }))),
          );
        },
      },
      "/api/pr/comment/delete": {
        POST: async (req) => {
          const body = (await req.json()) as DeleteCommentParams;

          if (!body.prUrl || !body.commentId) {
            return validationError("Missing required fields: prUrl, commentId");
          }

          return runJson(
            gh.deleteComment(body).pipe(Effect.map(() => ({ success: true }))),
          );
        },
      },
      "/api/user": {
        GET: () =>
          runJson(gh.getCurrentUser().pipe(Effect.map((login) => ({ login })))),
      },

      "/api/pr/approve": {
        POST: async (req) => {
          const body = (await req.json()) as ApprovePrParams;

          if (!body.prUrl) {
            return validationError("Missing required field: prUrl");
          }

          return runJson(
            gh.approvePr(body).pipe(Effect.map(() => ({ success: true }))),
          );
        },
      },

      // File diff endpoint for the pr_diff tool
      "/api/pr/file-diff": {
        GET: async (req) => {
          const url = new URL(req.url);
          const file = url.searchParams.get("file");
          const startLineParam = url.searchParams.get("startLine");
          const endLineParam = url.searchParams.get("endLine");

          const startLine = startLineParam
            ? parseInt(startLineParam, 10)
            : undefined;
          const endLine = endLineParam ? parseInt(endLineParam, 10) : undefined;

          if (!file) {
            return Response.json(
              { error: "Missing file parameter" },
              { status: 400 },
            );
          }

          return runJson(
            Effect.gen(function* () {
              const ctx = yield* prContext.getCurrent;

              yield* Effect.log(
                `[file-diff] Request for file: ${file}, startLine: ${startLine}, endLine: ${endLine}`,
              );
              yield* Effect.log(`[file-diff] Current PR: ${ctx.prUrl}`);
              yield* Effect.log(
                `[file-diff] Available files: ${ctx.files.length}`,
              );

              if (!ctx.prUrl) {
                return yield* Effect.fail(
                  new Error("No PR context. Load a PR first."),
                );
              }

              // Check if file is in the list of changed files
              if (!ctx.files.includes(file)) {
                return yield* Effect.fail(
                  new Error(
                    `File "${file}" is not in the list of changed files`,
                  ),
                );
              }

              // Get from cache
              const prDiffs = yield* diffCache.get(ctx.prUrl);
              if (!prDiffs) {
                return yield* Effect.fail(
                  new Error("Diffs not cached. This shouldn't happen."),
                );
              }

              const fileMeta = prDiffs.get(file);
              if (!fileMeta) {
                return yield* Effect.fail(
                  new Error(`No diff found for file: ${file}`),
                );
              }

              // Filter by line range if specified
              let diffOutput = fileMeta.diff;
              if (startLine !== undefined || endLine !== undefined) {
                diffOutput = filterDiffByLineRange(
                  diffOutput,
                  startLine,
                  endLine,
                );
              }

              yield* Effect.log(
                `[file-diff] Returning diff for ${file} (${diffOutput.length} chars)`,
              );
              return { diff: diffOutput };
            }),
          );
        },
      },

      // PR metadata endpoint for the pr_metadata tool
      "/api/pr/metadata": {
        GET: async () => {
          return runJson(
            Effect.gen(function* () {
              const ctx = yield* prContext.getCurrent;

              if (!ctx.prUrl || !ctx.info) {
                return yield* Effect.fail(
                  new Error("No PR context. Load a PR first."),
                );
              }

              // Get PR status (includes description)
              const prStatus = yield* gh.getPrStatus(ctx.prUrl);

              // Get cached diffs and compute line counts
              const prDiffs = yield* diffCache.get(ctx.prUrl);
              const fileStats: string[] = [];

              if (prDiffs) {
                for (const file of ctx.files) {
                  const fileMeta = prDiffs.get(file);
                  if (fileMeta) {
                    const { totalAdded, totalRemoved, hunks } = fileMeta;
                    // Show hunk ranges for large files (>1k lines changed)
                    if (totalAdded + totalRemoved > 1000 && hunks.length > 0) {
                      const ranges = hunks
                        .map(
                          (h) => `${h.newStart}-${h.newStart + h.newCount - 1}`,
                        )
                        .join(", ");
                      fileStats.push(
                        `${file} +${totalAdded} -${totalRemoved} [hunks: ${ranges}]`,
                      );
                    } else {
                      fileStats.push(`${file} +${totalAdded} -${totalRemoved}`);
                    }
                  } else {
                    fileStats.push(`${file} (no diff)`);
                  }
                }
              }

              // Build compact text output
              const description = prStatus.body
                ? prStatus.body.length > 500
                  ? prStatus.body.slice(0, 500) + "..."
                  : prStatus.body
                : "(no description)";

              const metadata = `PR: ${ctx.info.owner}/${ctx.info.repo}#${ctx.info.number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}

Description:
${description}

Files (${ctx.files.length} changed):
${fileStats.join("\n")}`;

              console.log({ metadata });
              return { metadata };
            }),
          );
        },
      },

      // OpenCode API routes
      "/api/opencode/health": {
        GET: () =>
          runJson(
            Effect.tryPromise(() => opencode.client.global.health()).pipe(
              Effect.map(() => ({ healthy: true })),
              Effect.catchAll((e) =>
                Effect.succeed({ healthy: false, error: String(e) }),
              ),
            ),
          ),
      },

      "/api/opencode/session": {
        POST: async (req) => {
          const body = (await req.json()) as {
            prUrl: string;
            prNumber: number;
            repoOwner: string;
            repoName: string;
            files: string[];
          };

          if (!body.prUrl) {
            return validationError("Missing prUrl");
          }

          return runJson(
            Effect.gen(function* () {
              yield* Effect.log("[API] Request body:", {
                ...body,
                files: `[${body.files?.length || 0} files]`,
              });

              // Check if we already have a session for this PR
              const existingSessionId = yield* prContext.getSession(body.prUrl);
              yield* Effect.log(
                "[API] Existing session ID:",
                existingSessionId,
              );

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

              if (existingSessionId) {
                yield* Effect.log("[API] Fetching existing session...");
                const existingSession = yield* Effect.tryPromise(() =>
                  opencode.client.session.get({
                    sessionID: existingSessionId,
                  }),
                );
                yield* Effect.log(
                  "[API] Existing session result:",
                  existingSession.data?.id,
                );
                if (existingSession.data) {
                  return { session: existingSession.data, existing: true };
                }
              }

              // Create a new session
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

              // Store the session mapping
              yield* prContext.setSession(body.prUrl, session.data.id);

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

              return { session: session.data, existing: false };
            }),
          );
        },
      },

      "/api/opencode/prompt": {
        POST: async (req) => {
          const body = (await req.json()) as {
            sessionId: string;
            message: string;
            agent?: string;
          };

          if (!body.sessionId || !body.message) {
            return validationError("Missing sessionId or message");
          }

          return runJson(
            Effect.gen(function* () {
              // Use the currently selected model
              const result = yield* Effect.tryPromise(() =>
                opencode.client.session.prompt({
                  sessionID: body.sessionId,
                  model: {
                    providerID: currentModel.providerId,
                    modelID: currentModel.modelId,
                  },
                  agent: body.agent,
                  parts: [{ type: "text", text: body.message }],
                  // Disable tools for read-only mode
                  tools: {
                    bash: false,
                    edit: false,
                    write: false,
                    glob: false,
                    grep: false,
                    read: false,
                    todoread: true,
                    todowrite: true,
                    webfetch: true,
                  },
                }),
              );

              return { result: result.data };
            }),
          );
        },
      },

      "/api/opencode/messages": {
        GET: (req) => {
          const url = new URL(req.url);
          const sessionId = url.searchParams.get("sessionId");

          if (!sessionId) {
            return validationError("Missing sessionId");
          }

          return runJson(
            Effect.gen(function* () {
              const messages = yield* Effect.tryPromise(() =>
                opencode.client.session.messages({ sessionID: sessionId }),
              );

              return { messages: messages.data };
            }),
          );
        },
      },

      "/api/opencode/abort": {
        POST: async (req) => {
          const body = (await req.json()) as { sessionId: string };

          if (!body.sessionId) {
            return validationError("Missing sessionId");
          }

          return runJson(
            Effect.gen(function* () {
              yield* Effect.tryPromise(() =>
                opencode.client.session.abort({ sessionID: body.sessionId }),
              );

              return { success: true };
            }),
          );
        },
      },

      // SSE endpoint for streaming events
      "/api/opencode/events": {
        GET: (req) => {
          const url = new URL(req.url);
          const sessionId = url.searchParams.get("sessionId");

          if (!sessionId) {
            return validationError("Missing sessionId");
          }

          return runResponse(
            Effect.gen(function* () {
              yield* Effect.log(
                `[SSE] Starting event stream for session: ${sessionId}`,
              );

              // Create Effect Stream from OpenCode SSE and convert to Response
              const stream = createOpenCodeStream(opencode.baseUrl, sessionId);
              return streamToSSEResponse(stream);
            }),
          );
        },
      },

      // Async prompt endpoint (fire-and-forget, use with SSE)
      "/api/opencode/prompt-start": {
        POST: async (req) => {
          const body = (await req.json()) as {
            sessionId: string;
            message: string;
            agent?: string;
          };

          if (!body.sessionId || !body.message) {
            return validationError("Missing sessionId or message");
          }

          return runJson(
            Effect.gen(function* () {
              // Use the async endpoint (prompt_async) - fire and forget
              const response = yield* Effect.tryPromise(() =>
                fetch(
                  `${opencode.baseUrl}/session/${body.sessionId}/prompt_async`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      model: {
                        providerID: currentModel.providerId,
                        modelID: currentModel.modelId,
                      },
                      agent: body.agent,
                      parts: [{ type: "text", text: body.message }],
                      // Disable local file tools - they would search the wrong repo
                      // The pr_diff custom tool is enabled by default
                      tools: {
                        bash: false,
                        edit: false,
                        write: false,
                        glob: false,
                        grep: false,
                        read: false,
                        todoread: true,
                        todowrite: true,
                        webfetch: true,
                      },
                    }),
                  },
                ),
              );

              if (!response.ok) {
                const text = yield* Effect.tryPromise(() => response.text());
                return yield* Effect.fail(
                  new Error(`OpenCode error: ${response.status} - ${text}`),
                );
              }

              // Returns 204 No Content on success
              return { success: true };
            }),
          );
        },
      },
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
