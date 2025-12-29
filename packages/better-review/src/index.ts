import { runtime } from "./runtime";
import { GhService, type AddCommentParams, type AddReplyParams } from "./gh/gh";
import { Effect, Stream } from "effect";
import {
  createOpencodeClient,
  createOpencode,
  type OpencodeClient,
  type Event as OpenCodeEvent,
} from "@opencode-ai/sdk";
import {
  transformEvent,
  formatSSE,
  formatSSEComment,
  type StreamEvent,
} from "./stream";

// OpenCode client instance
let opencodeClient: OpencodeClient | null = null;
let opencodeBaseUrl: string | null = null;
let opencodeServer: { url: string; close(): void } | null = null;

// Session storage: prUrl -> sessionId
const prSessions = new Map<string, string>();

// Diff cache: prUrl -> { fileName -> diff }
const diffCache = new Map<string, Map<string, string>>();

// Current PR context (for the tool to access)
let currentPrUrl: string | null = null;
let currentPrFiles: string[] = [];

// Initialize OpenCode client using SDK
async function initOpencode() {
  console.log("[OpenCode] Starting opencode server...");

  try {
    const { client, server } = await createOpencode({
      port: 4097,
    });
    opencodeBaseUrl = server.url;
    opencodeClient = client;

    console.log(`[OpenCode] Server running at ${opencodeBaseUrl}`);
  } catch (error) {
    console.error(
      "[OpenCode] Failed to start server:",
      error instanceof Error ? error.message : error,
    );
  }
}

// Fetch and cache all diffs for a PR
async function cachePrDiffs(prUrl: string): Promise<Map<string, string>> {
  // Check if already cached
  const existing = diffCache.get(prUrl);
  if (existing) {
    console.log(`[cache] Using cached diffs for ${prUrl} (${existing.size} files)`);
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
function cleanup() {
  console.log("\n[Shutdown] Cleaning up...");

  if (opencodeServer) {
    console.log("[Shutdown] Stopping opencode server...");
    opencodeServer.close();
    console.log("[Shutdown] OpenCode server stopped");
  }

  process.exit(0);
}

// Register cleanup handlers
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Start OpenCode server on init
initOpencode();

const server = Bun.serve({
  port: 3001,
  routes: {
    "/api/pr/diff": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const diff = yield* gh.getDiff(prUrl);
              return { diff };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/info": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const info = yield* gh.getPrInfo(prUrl);
              return info;
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comments": {
      GET: async (req) => {
        const url = new URL(req.url);
        const prUrl = url.searchParams.get("url");

        if (!prUrl) {
          return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comments = yield* gh.listComments(prUrl);
              return { comments };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comment": {
      POST: async (req) => {
        const body = (await req.json()) as AddCommentParams;

        if (!body.prUrl || !body.filePath || !body.line || !body.body) {
          return Response.json(
            { error: "Missing required fields: prUrl, filePath, line, body" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comment = yield* gh.addComment(body);
              return { comment };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
      },
    },
    "/api/pr/comment/reply": {
      POST: async (req) => {
        const body = (await req.json()) as AddReplyParams;

        if (!body.prUrl || !body.commentId || !body.body) {
          return Response.json(
            { error: "Missing required fields: prUrl, commentId, body" },
            { status: 400 },
          );
        }

        const result = await runtime
          .runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const comment = yield* gh.replyToComment(body);
              return { comment };
            }),
          )
          .catch((e) => ({ error: String(e) }));

        return Response.json(result);
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
          return Response.json({ error: "Missing file parameter" }, { status: 400 });
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

        console.log(`[file-diff] Returning diff for ${file} (${fileDiff.length} chars)`);
        return Response.json({ diff: fileDiff });
      },
    },

    // OpenCode API routes
    "/api/opencode/health": {
      GET: async () => {
        if (!opencodeClient) {
          return Response.json(
            { healthy: false, error: "OpenCode not initialized" },
            { status: 503 },
          );
        }
        try {
          await opencodeClient.global.event();
          return Response.json({ healthy: true });
        } catch (error) {
          return Response.json(
            { healthy: false, error: String(error) },
            { status: 503 },
          );
        }
      },
    },

    "/api/opencode/session": {
      POST: async (req) => {
        console.log(
          "[API] POST /api/opencode/session - opencodeClient:",
          !!opencodeClient,
        );

        if (!opencodeClient) {
          console.log("[API] OpenCode client not initialized");
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const body = (await req.json()) as {
          prUrl: string;
          prNumber: number;
          repoOwner: string;
          repoName: string;
          files: string[];
        };
        console.log("[API] Request body:", {
          ...body,
          files: `[${body.files?.length || 0} files]`,
        });

        if (!body.prUrl) {
          console.log("[API] Missing prUrl");
          return Response.json({ error: "Missing prUrl" }, { status: 400 });
        }

        try {
          // Check if we already have a session for this PR
          const existingSessionId = prSessions.get(body.prUrl);
          console.log("[API] Existing session ID:", existingSessionId);

          // Set current PR context for the file-diff endpoint
          currentPrUrl = body.prUrl;
          currentPrFiles = body.files;

          // Pre-cache all diffs for this PR
          console.log("[API] Pre-caching diffs...");
          await cachePrDiffs(body.prUrl);

          // Write PR context file for custom tools (always, even for existing sessions)
          console.log("[API] Writing PR context file...");
          await Bun.write(
            ".opencode/.current-pr.json",
            JSON.stringify({
              url: body.prUrl,
              owner: body.repoOwner,
              repo: body.repoName,
              number: body.prNumber,
              files: body.files,
            }),
          );

          if (existingSessionId) {
            console.log("[API] Fetching existing session...");
            const existingSession = await opencodeClient.session.get({
              path: { id: existingSessionId },
            });
            console.log(
              "[API] Existing session result:",
              existingSession.data?.id,
            );
            if (existingSession.data) {
              return Response.json({
                session: existingSession.data,
                existing: true,
              });
            }
          }

          // Create a new session
          console.log("[API] Creating new session...");
          const session = await opencodeClient.session.create({
            body: {
              title: `PR Review: ${body.repoOwner}/${body.repoName}#${body.prNumber}`,
            },
          });
          console.log("[API] Session created:", session.data?.id);

          if (!session.data) {
            console.log("[API] Failed to create session - no data returned");
            return Response.json(
              { error: "Failed to create session" },
              { status: 500 },
            );
          }

          // Store the session mapping
          prSessions.set(body.prUrl, session.data.id);

          // Inject initial context (without expecting a reply)
          console.log("[API] Injecting context...");
          const contextMessage = buildReviewContext(body);
          await opencodeClient.session.prompt({
            path: { id: session.data.id },
            body: {
              parts: [{ type: "text", text: contextMessage }],
              noReply: true,
            },
          });
          console.log("[API] Context injected successfully");

          return Response.json({ session: session.data, existing: false });
        } catch (error) {
          console.error("[API] Error creating OpenCode session:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/opencode/prompt": {
      POST: async (req) => {
        if (!opencodeClient) {
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const body = (await req.json()) as {
          sessionId: string;
          message: string;
          agent?: string;
        };

        if (!body.sessionId || !body.message) {
          return Response.json(
            { error: "Missing sessionId or message" },
            { status: 400 },
          );
        }

        try {
          // Use a better model when using the review agent
          const modelID =
            body.agent === "review"
              ? "claude-sonnet-4-20250514"
              : "claude-3-5-haiku-latest";

          const result = await opencodeClient.session.prompt({
            path: { id: body.sessionId },
            body: {
              model: {
                providerID: "anthropic",
                modelID,
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
          });

          return Response.json({ result: result.data });
        } catch (error) {
          console.error("Error sending prompt:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/opencode/messages": {
      GET: async (req) => {
        if (!opencodeClient) {
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        try {
          const messages = await opencodeClient.session.messages({
            path: { id: sessionId },
          });

          return Response.json({ messages: messages.data });
        } catch (error) {
          console.error("Error fetching messages:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/opencode/abort": {
      POST: async (req) => {
        if (!opencodeClient) {
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const body = (await req.json()) as { sessionId: string };

        if (!body.sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        try {
          await opencodeClient.session.abort({
            path: { id: body.sessionId },
          });

          return Response.json({ success: true });
        } catch (error) {
          console.error("Error aborting session:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    },

    // SSE endpoint for streaming events
    "/api/opencode/events": {
      GET: async (req) => {
        if (!opencodeClient || !opencodeBaseUrl) {
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          return Response.json({ error: "Missing sessionId" }, { status: 400 });
        }

        console.log(`[SSE] Starting event stream for session: ${sessionId}`);

        const encoder = new TextEncoder();

        // Create a readable stream that proxies OpenCode events
        const readable = new ReadableStream({
          async start(controller) {
            // Send initial comment
            controller.enqueue(encoder.encode(formatSSEComment("connected")));

            // Send connected event
            const connectedEvent: StreamEvent = { type: "connected" };
            controller.enqueue(encoder.encode(formatSSE(connectedEvent)));

            // Connect to OpenCode's event stream
            const eventUrl = `${opencodeBaseUrl}/event`;
            console.log(`[SSE] Connecting to OpenCode: ${eventUrl}`);

            try {
              const response = await fetch(eventUrl, {
                headers: { Accept: "text/event-stream" },
              });

              if (!response.ok || !response.body) {
                throw new Error(`Failed to connect: ${response.status}`);
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";

              while (true) {
                const { done, value } = await reader.read();

                if (done) {
                  console.log("[SSE] OpenCode stream ended");
                  break;
                }

                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE messages
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; // Keep incomplete line in buffer

                for (const line of lines) {
                  if (line.startsWith("data: ")) {
                    try {
                      const data = line.slice(6);
                      const event = JSON.parse(data) as OpenCodeEvent;

                      // Transform and filter for this session
                      const streamEvent = transformEvent(event, sessionId);

                      if (streamEvent) {
                        controller.enqueue(
                          encoder.encode(formatSSE(streamEvent)),
                        );
                      }
                    } catch (e) {
                      // Ignore parse errors for malformed events
                    }
                  }
                }
              }
            } catch (error) {
              console.error("[SSE] Stream error:", error);
              const errorEvent: StreamEvent = {
                type: "error",
                code: "connection_error",
                message:
                  error instanceof Error ? error.message : "Connection failed",
              };
              controller.enqueue(encoder.encode(formatSSE(errorEvent)));
            }

            controller.close();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },

    // Async prompt endpoint (fire-and-forget, use with SSE)
    "/api/opencode/prompt-start": {
      POST: async (req) => {
        if (!opencodeClient || !opencodeBaseUrl) {
          return Response.json(
            { error: "OpenCode not initialized" },
            { status: 503 },
          );
        }

        const body = (await req.json()) as {
          sessionId: string;
          message: string;
          agent?: string;
        };

        if (!body.sessionId || !body.message) {
          return Response.json(
            { error: "Missing sessionId or message" },
            { status: 400 },
          );
        }

        try {
          // Use a better model when using the review agent
          const modelID =
            body.agent === "review"
              ? "claude-sonnet-4-20250514"
              : "claude-3-5-haiku-latest";

          // Use the async endpoint (prompt_async) - fire and forget
          const response = await fetch(
            `${opencodeBaseUrl}/session/${body.sessionId}/prompt_async`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: {
                  providerID: "anthropic",
                  modelID,
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
          );

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`OpenCode error: ${response.status} - ${text}`);
          }

          // Returns 204 No Content on success
          return Response.json({ success: true });
        } catch (error) {
          console.error("Error starting prompt:", error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
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
