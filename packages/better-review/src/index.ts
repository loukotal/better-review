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
// Session and Cache State
// =============================================================================

// Session storage: prUrl -> sessionId
const prSessions = new Map<string, string>();

// Diff cache: prUrl -> { fileName -> diff }
const diffCache = new Map<string, Map<string, string>>();

// Current PR context (for the tool to access)
let currentPrUrl: string | null = null;
let currentPrFiles: string[] = [];
let currentPrInfo: { owner: string; repo: string; number: string } | null =
  null;

// Parse line counts from a unified diff
function getLineChanges(diff: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

// Filter a unified diff to only include hunks that overlap with the specified line range
// Line numbers refer to the NEW file (right side of diff)
function filterDiffByLineRange(
  diff: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  let inHeader = true;
  let currentHunk: string[] = [];
  let hunkNewStart = 0;
  let hunkNewCount = 0;

  for (const line of lines) {
    // Keep diff header lines (diff --git, index, ---, +++)
    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
      } else {
        result.push(line);
        continue;
      }
    }

    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // Save previous hunk if it overlaps with our range
      if (currentHunk.length > 0) {
        const hunkNewEnd = hunkNewStart + hunkNewCount - 1;
        const overlaps =
          (startLine === undefined || hunkNewEnd >= startLine) &&
          (endLine === undefined || hunkNewStart <= endLine);
        if (overlaps) {
          result.push(...currentHunk);
        }
      }

      // Start new hunk
      currentHunk = [line];
      hunkNewStart = parseInt(hunkMatch[1], 10);
      hunkNewCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
    } else {
      currentHunk.push(line);
    }
  }

  // Don't forget the last hunk
  if (currentHunk.length > 0) {
    const hunkNewEnd = hunkNewStart + hunkNewCount - 1;
    const overlaps =
      (startLine === undefined || hunkNewEnd >= startLine) &&
      (endLine === undefined || hunkNewStart <= endLine);
    if (overlaps) {
      result.push(...currentHunk);
    }
  }

  return result.join("\n");
}

// Fetch and cache all diffs for a PR
async function cachePrDiffs(prUrl: string): Promise<Map<string, string>> {
  // Check if already cached
  const existing = diffCache.get(prUrl);
  if (existing) {
    console.log(
      `[cache] Using cached diffs for ${prUrl} (${existing.size} files)`,
    );
    return existing;
  }

  console.log(`[cache] Fetching full diff for ${prUrl}...`);

  try {
    const fullDiff = await Bun.$`gh pr diff ${prUrl}`.text();
    console.log(`[cache] Full diff fetched (${fullDiff.length} chars)`);

    // Parse the unified diff into per-file diffs
    const fileDiffs = new Map<string, string>();
    const lines = fullDiff.split("\n");
    let currentFile: string | null = null;
    let currentDiff: string[] = [];

    for (const line of lines) {
      // Check for diff header: "diff --git a/path/to/file b/path/to/file"
      if (line.startsWith("diff --git ")) {
        // Save previous file's diff
        if (currentFile && currentDiff.length > 0) {
          fileDiffs.set(currentFile, currentDiff.join("\n"));
        }

        // Extract new file path
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (match) {
          currentFile = match[2]; // Use the "b" path (new file name)
          currentDiff = [line];
        }
      } else if (currentFile) {
        currentDiff.push(line);
      }
    }

    // Don't forget the last file
    if (currentFile && currentDiff.length > 0) {
      fileDiffs.set(currentFile, currentDiff.join("\n"));
    }

    console.log(`[cache] Cached ${fileDiffs.size} file diffs`);
    diffCache.set(prUrl, fileDiffs);
    return fileDiffs;
  } catch (error) {
    console.error(`[cache] Failed to fetch diff:`, error);
    throw error;
  }
}

// =============================================================================
// Helper functions
// =============================================================================

const validationError = (message: string): Response =>
  Response.json({ error: message }, { status: 400 });

const getErrorMessage = (error: unknown): string => {
  let current = error;

  // Unwrap Effect Cause (Fail has .error, Die has .defect)
  if (current && typeof current === "object") {
    const obj = current as Record<string, unknown>;
    if (obj._tag === "Fail" && obj.error) current = obj.error;
    else if (obj._tag === "Die" && obj.defect) current = obj.defect;
  }

  // Unwrap nested .cause (GhError, etc)
  while (current && typeof current === "object" && "cause" in current) {
    const cause = (current as { cause: unknown }).cause;
    if (typeof cause === "string") return cause;
    current = cause;
  }

  // Check stderr first (shell errors)
  if (current && typeof current === "object" && "stderr" in current) {
    const stderr = String((current as { stderr: unknown }).stderr || "").trim();
    if (stderr.includes("HTTP 404")) return "PR not found";
    if (stderr) return stderr;
  }

  // For Error objects, use message
  if (current instanceof Error) return current.message;

  return String(current);
};

/** Run an effect and return JSON response */
const runJson = <A>(
  effect: Effect.Effect<A, unknown, never>,
): Promise<Response> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((data) => Response.json(data)),
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          Response.json({ error: getErrorMessage(cause) }, { status: 500 }),
        ),
      ),
    ),
  );

/** Run an effect that returns a Response directly */
const runResponse = (
  effect: Effect.Effect<Response, unknown, never>,
): Promise<Response> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          Response.json({ error: getErrorMessage(cause) }, { status: 500 }),
        ),
      ),
    ),
  );

// =============================================================================
// Build context message for PR review
// =============================================================================

function buildReviewContext(params: {
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  files: string[];
}): string {
  // Filter out common noise files
  const ignorePatterns = [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /bun\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.lock$/,
    /node_modules\//,
    /\.min\.js$/,
    /\.min\.css$/,
    /dist\//,
    /build\//,
    /\.map$/,
  ];

  const relevantFiles = params.files.filter(
    (file) => !ignorePatterns.some((pattern) => pattern.test(file)),
  );

  return `You are reviewing PR #${params.prNumber} in ${params.repoOwner}/${params.repoName}.

**PR URL:** ${params.prUrl}

**Files changed (${relevantFiles.length} files):**
${relevantFiles.map((f) => `- ${f}`).join("\n")}

---

## CRITICAL INSTRUCTIONS

You are reviewing a **REMOTE** pull request. The local filesystem contains a DIFFERENT codebase.

**Your ONLY tool is \`pr_diff\`**. Call it with a file path to see that file's diff:
- Example: \`pr_diff(file="src/index.ts")\`

**DO NOT** use glob, grep, read, bash, or any filesystem tools. They will search the WRONG codebase and confuse you.

---

**Your role:**
- Call \`pr_diff\` for files you need to review
- Explain what the changes do
- Identify potential issues or bugs
- Suggest improvements
- Answer questions about the code`;
}

// =============================================================================
// Main Application Effect
// =============================================================================

const layers = Layer.mergeAll(GhServiceLive, OpencodeService.Default);

const main = Effect.gen(function* () {
  const gh = yield* GhService;
  const opencode = yield* OpencodeService;

  const server = Bun.serve({
    port: 3001,
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

          console.log(
            `[file-diff] Request for file: ${file}, startLine: ${startLine}, endLine: ${endLine}`,
          );
          console.log(`[file-diff] Current PR: ${currentPrUrl}`);
          console.log(`[file-diff] Available files: ${currentPrFiles.length}`);

          if (!file) {
            return Response.json(
              { error: "Missing file parameter" },
              { status: 400 },
            );
          }

          if (!currentPrUrl) {
            return Response.json(
              { error: "No PR context. Load a PR first." },
              { status: 400 },
            );
          }

          // Check if file is in the list of changed files
          if (!currentPrFiles.includes(file)) {
            return Response.json(
              {
                error: `File "${file}" is not in the list of changed files`,
                availableFiles: currentPrFiles,
              },
              { status: 400 },
            );
          }

          // Get from cache
          const prDiffs = diffCache.get(currentPrUrl);
          if (!prDiffs) {
            return Response.json(
              { error: "Diffs not cached. This shouldn't happen." },
              { status: 500 },
            );
          }

          let fileDiff = prDiffs.get(file);
          if (!fileDiff) {
            return Response.json(
              { error: `No diff found for file: ${file}` },
              { status: 404 },
            );
          }

          // Filter by line range if specified
          if (startLine !== undefined || endLine !== undefined) {
            fileDiff = filterDiffByLineRange(fileDiff, startLine, endLine);
          }

          console.log(
            `[file-diff] Returning diff for ${file} (${fileDiff!.length} chars)`,
          );
          return Response.json({ diff: fileDiff });
        },
      },

      // PR metadata endpoint for the pr_metadata tool
      "/api/pr/metadata": {
        GET: async () => {
          if (!currentPrUrl || !currentPrInfo) {
            return Response.json(
              { error: "No PR context. Load a PR first." },
              { status: 400 },
            );
          }

          return runJson(
            Effect.gen(function* () {
              // Get PR status (includes description)
              const prStatus = yield* gh.getPrStatus(currentPrUrl!);

              // Get cached diffs and compute line counts
              const prDiffs = diffCache.get(currentPrUrl!);
              const fileStats: string[] = [];

              if (prDiffs) {
                for (const file of currentPrFiles) {
                  const diff = prDiffs.get(file);
                  if (diff) {
                    const { added, removed } = getLineChanges(diff);
                    fileStats.push(`${file} +${added} -${removed}`);
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

              const metadata = `PR: ${currentPrInfo!.owner}/${currentPrInfo!.repo}#${currentPrInfo!.number}
Title: ${prStatus.title}
Author: ${prStatus.author}
State: ${prStatus.state}${prStatus.draft ? " (draft)" : ""}

Description:
${description}

Files (${currentPrFiles.length} changed):
${fileStats.join("\n")}`;

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
              const existingSessionId = prSessions.get(body.prUrl);
              yield* Effect.log(
                "[API] Existing session ID:",
                existingSessionId,
              );

              // Set current PR context for the file-diff endpoint
              currentPrUrl = body.prUrl;
              currentPrFiles = body.files;
              currentPrInfo = {
                owner: body.repoOwner,
                repo: body.repoName,
                number: String(body.prNumber),
              };

              // Pre-cache all diffs for this PR
              yield* Effect.log("[API] Pre-caching diffs...");
              yield* Effect.tryPromise(() => cachePrDiffs(body.prUrl));

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
              prSessions.set(body.prUrl, session.data.id);

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

  console.log(`API server running at http://localhost:${server.port}`);

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
