import {
  GhService,
  type AddCommentParams,
  type AddReplyParams,
  type EditCommentParams,
  type DeleteCommentParams,
  type ApprovePrParams,
} from "./gh/gh";
import { Effect } from "effect";
import {
  createOpenCodeStream,
  streamToSSEResponse,
} from "./stream";
import { OpencodeService } from "./opencode";
import {
  handleEffect,
  handleEffectResponse,
  validationError,
} from "./handler";
import { runtime } from "./runtime";

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

// Cleanup function to stop opencode server on shutdown
async function cleanup() {
  console.log("\n[Shutdown] Cleaning up...");

  await runtime.dispose().then(() => process.exit(0));
}

// Register cleanup handlers
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

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
                m.modelId.toLowerCase().includes(query)
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
        const body = (await req.json()) as { providerId?: string; modelId?: string };
        
        if (!body.providerId || !body.modelId) {
          return validationError("Missing providerId or modelId");
        }
        
        // Validate that this model exists in our data
        const exists = providerData.some(
          (m) => m.providerId === body.providerId && m.modelId === body.modelId
        );
        
        if (!exists) {
          return validationError(`Model not found: ${body.providerId}/${body.modelId}`);
        }
        
        currentModel = {
          providerId: body.providerId,
          modelId: body.modelId,
        };
        
        console.log(`[models] Model changed to: ${currentModel.providerId}/${currentModel.modelId}`);
        
        return Response.json({ success: true, model: currentModel });
      },
    },
    
    // =========================================================================
    // PR Endpoints
    // =========================================================================
    
    "/api/prs": {
      GET: async () => {
        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const prs = yield* gh.searchReviewRequested();
            return { prs };
          }),
        );
      },
    },
    "/api/pr/diff": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return validationError("Missing url parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const diff = yield* gh.getDiff(prUrl);
            return { diff };
          }),
        );
      },
    },
    "/api/pr/info": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return validationError("Missing url parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            return yield* gh.getPrInfo(prUrl);
          }),
        );
      },
    },
    "/api/pr/comments": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return validationError("Missing url parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const comments = yield* gh.listComments(prUrl);
            return { comments };
          }),
        );
      },
    },
    "/api/pr/status": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return validationError("Missing url parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            return yield* gh.getPrStatus(prUrl);
          }),
        );
      },
    },
    "/api/pr/commits": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return validationError("Missing url parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const commits = yield* gh.listCommits(prUrl);
            return { commits };
          }),
        );
      },
    },
    "/api/pr/commit-diff": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");
        const sha = url.searchParams.get("sha");

        if (!prUrl || !sha) {
          return validationError("Missing url or sha parameter");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
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

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const comment = yield* gh.addComment(body);
            return { comment };
          }),
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

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const comment = yield* gh.replyToComment(body);
            return { comment };
          }),
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

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const comment = yield* gh.editComment(body);
            return { comment };
          }),
        );
      },
    },
    "/api/pr/comment/delete": {
      POST: async (req) => {
        const body = (await req.json()) as DeleteCommentParams;

        if (!body.prUrl || !body.commentId) {
          return validationError(
            "Missing required fields: prUrl, commentId",
          );
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            yield* gh.deleteComment(body);
            return { success: true };
          }),
        );
      },
    },
    "/api/user": {
      GET: async () => {
        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            const login = yield* gh.getCurrentUser();
            return { login };
          }),
        );
      },
    },

    "/api/pr/approve": {
      POST: async (req) => {
        const body = (await req.json()) as ApprovePrParams;

        if (!body.prUrl) {
          return validationError("Missing required field: prUrl");
        }

        return handleEffect(
          Effect.gen(function* () {
            const gh = yield* GhService;
            yield* gh.approvePr(body);
            return { success: true };
          }),
        );
      },
    },

    // File diff endpoint for the pr_diff tool
    "/api/pr/file-diff": {
      GET: async (req) => {
        const url = new URL(req.url);
        const file = url.searchParams.get("file");

        console.log(`[file-diff] Request for file: ${file}`);
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

        const fileDiff = prDiffs.get(file);
        if (!fileDiff) {
          return Response.json(
            { error: `No diff found for file: ${file}` },
            { status: 404 },
          );
        }

        console.log(
          `[file-diff] Returning diff for ${file} (${fileDiff.length} chars)`,
        );
        return Response.json({ diff: fileDiff });
      },
    },

    // OpenCode API routes
    "/api/opencode/health": {
      GET: async () => {
        return runtime.runPromise(
          Effect.gen(function* () {
            const { client } = yield* OpencodeService;
            yield* Effect.tryPromise(() => client.global.event());
            return Response.json({ healthy: true });
          }).pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                Response.json({ healthy: false, error: String(e) }),
              ),
            ),
          ),
        );
      },
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

        return handleEffect(
          Effect.gen(function* () {
            const { client } = yield* OpencodeService;

            yield* Effect.log("[API] Request body:", {
              ...body,
              files: `[${body.files?.length || 0} files]`,
            });

            // Check if we already have a session for this PR
            const existingSessionId = prSessions.get(body.prUrl);
            yield* Effect.log("[API] Existing session ID:", existingSessionId);

            // Set current PR context for the file-diff endpoint
            currentPrUrl = body.prUrl;
            currentPrFiles = body.files;

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
                client.session.get({ path: { id: existingSessionId } }),
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
              client.session.create({
                body: {
                  title: `PR Review: ${body.repoOwner}/${body.repoName}#${body.prNumber}`,
                },
              }),
            );
            yield* Effect.log("[API] Session created:", session.data?.id);

            if (!session.data) {
              return yield* Effect.fail(new Error("Failed to create session"));
            }

            // Store the session mapping
            prSessions.set(body.prUrl, session.data.id);

            // Inject initial context (without expecting a reply)
            yield* Effect.log("[API] Injecting context...");
            const contextMessage = buildReviewContext(body);
            yield* Effect.tryPromise(() =>
              client.session.prompt({
                path: { id: session.data!.id },
                body: {
                  parts: [{ type: "text", text: contextMessage }],
                  noReply: true,
                },
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

        return handleEffect(
          Effect.gen(function* () {
            const { client } = yield* OpencodeService;

            // Use the currently selected model
            const result = yield* Effect.tryPromise(() =>
              client.session.prompt({
                path: { id: body.sessionId },
                body: {
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
                    glob: true,
                    grep: true,
                    read: true,
                    todoread: false,
                    todowrite: false,
                    webfetch: false,
                  },
                },
              }),
            );

            return { result: result.data };
          }),
        );
      },
    },

    "/api/opencode/messages": {
      GET: async (req) => {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          return validationError("Missing sessionId");
        }

        return handleEffect(
          Effect.gen(function* () {
            const { client } = yield* OpencodeService;

            const messages = yield* Effect.tryPromise(() =>
              client.session.messages({ path: { id: sessionId } }),
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

        return handleEffect(
          Effect.gen(function* () {
            const { client } = yield* OpencodeService;

            yield* Effect.tryPromise(() =>
              client.session.abort({ path: { id: body.sessionId } }),
            );

            return { success: true };
          }),
        );
      },
    },

    // SSE endpoint for streaming events
    "/api/opencode/events": {
      GET: async (req) => {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          return validationError("Missing sessionId");
        }

        return handleEffectResponse(
          Effect.gen(function* () {
            const { baseUrl } = yield* OpencodeService;

            yield* Effect.log(
              `[SSE] Starting event stream for session: ${sessionId}`,
            );

            // Create Effect Stream from OpenCode SSE and convert to Response
            const stream = createOpenCodeStream(baseUrl, sessionId);
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

        return handleEffect(
          Effect.gen(function* () {
            const { baseUrl: opencodeBaseUrl } = yield* OpencodeService;

            // Use the async endpoint (prompt_async) - fire and forget
            const response = yield* Effect.tryPromise(() =>
              fetch(
                `${opencodeBaseUrl}/session/${body.sessionId}/prompt_async`,
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
                      todoread: false,
                      todowrite: false,
                      webfetch: false,
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

// Build context message for PR review
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

console.log(`API server running at http://localhost:${server.port}`);
