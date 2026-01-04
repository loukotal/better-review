// =============================================================================
// HTTP Response Helpers
// =============================================================================

import { Effect } from "effect";

/**
 * Create a 400 Bad Request response with an error message
 */
export const validationError = (message: string): Response =>
  Response.json({ error: message }, { status: 400 });

/**
 * Extract a human-readable error message from various error types
 */
export const getErrorMessage = (error: unknown): string => {
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

/**
 * Run an effect and return a JSON response
 * Success: Response.json(data)
 * Failure: Response.json({ error: message }, { status: 500 })
 */
export const runJson = <A>(
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

/**
 * Run an effect that returns a Response directly
 * Catches failures and returns error JSON response
 */
export const runResponse = (
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
// Review Context Builder
// =============================================================================

/**
 * Marker prefix used to identify system-injected context messages.
 * This allows the frontend to reliably filter out these messages from chat history.
 */
export const SYSTEM_CONTEXT_MARKER = "[SYSTEM_CONTEXT]";

// File patterns to ignore when building review context
const IGNORE_PATTERNS = [
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

/**
 * Build the initial context message for a PR review session
 */
export function buildReviewContext(params: {
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  files: string[];
}): string {
  const relevantFiles = params.files.filter(
    (file) => !IGNORE_PATTERNS.some((pattern) => pattern.test(file)),
  );

  return `${SYSTEM_CONTEXT_MARKER}
You are reviewing PR #${params.prNumber} in ${params.repoOwner}/${params.repoName}.

**PR URL:** ${params.prUrl}

**Files changed (${relevantFiles.length} files):**
${relevantFiles.map((f) => `- ${f}`).join("\n")}

---

## CRITICAL INSTRUCTIONS

You are reviewing a **REMOTE** pull request. The local filesystem contains a DIFFERENT codebase.

## Tools

### \`pr_metadata\`
Get PR metadata including title, author, description, and file list with line counts.
- For large files (>1000 lines changed), shows hunk ranges: \`file.json +5000 -200 [hunks: 1-500, 1200-1800]\`
- Use this to understand which line ranges to request for large files

### \`pr_diff\`
Get the diff for a specific file. Supports optional line range filtering.
- \`pr_diff(file="src/index.ts")\` - get full diff
- \`pr_diff(file="src/index.ts", startLine=100, endLine=200)\` - get only lines 100-200 (new file line numbers)

For large files, use the hunk ranges from \`pr_metadata\` to request specific portions.

---

**Your role:**
- Call \`pr_metadata\` to get an overview of the PR
- Call \`pr_diff\` for files you need to review (use line ranges for large files)
- Explain what the changes do
- Identify potential issues or bugs
- Suggest improvements
- Answer questions about the code`;
}
