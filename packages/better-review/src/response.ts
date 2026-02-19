// =============================================================================
// HTTP Response Helpers
// =============================================================================

import { join } from "node:path";

import { SYSTEM_CONTEXT_MARKER } from "@better-review/shared";

// =============================================================================
// Custom Personality
// =============================================================================

/**
 * Path to the custom personality file in the project root.
 * Users can create this file to customize the reviewer's behavior.
 */
const PERSONALITY_FILE = "personality.md";

/**
 * Load custom reviewer personality from personality.md in the project root.
 * Returns the file content or null if the file doesn't exist.
 */
export async function loadPersonality(): Promise<string | null> {
  // Look for personality.md in the monorepo root (3 levels up from src/response.ts)
  const filePath = join(import.meta.dir, "..", "..", "..", PERSONALITY_FILE);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return null;
  }

  const content = (await file.text()).trim();
  return content || null;
}

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

// =============================================================================
// Review Context Builder
// =============================================================================

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
 * Build the initial context message for a PR review session.
 * Automatically loads and includes custom personality from personality.md if present.
 */
export async function buildReviewContext(params: {
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  files: string[];
  reviewMode?: "full" | "commit";
  commitSha?: string;
}): Promise<string> {
  const relevantFiles = params.files.filter(
    (file) => !IGNORE_PATTERNS.some((pattern) => pattern.test(file)),
  );

  const personality = await loadPersonality();
  const personalitySection = personality
    ? `

## Custom Reviewer Instructions

The user has provided the following custom instructions for how you should behave as a reviewer. Follow these instructions in addition to (and with higher priority than) the default instructions above:

${personality}

---
`
    : "";

  return `${SYSTEM_CONTEXT_MARKER}
You are reviewing PR #${params.prNumber} in ${params.repoOwner}/${params.repoName}.

**PR URL:** ${params.prUrl}

**Files changed (${relevantFiles.length} files):**
${relevantFiles.map((f) => `- ${f}`).join("\n")}

**Review mode:** ${params.reviewMode === "commit" ? "Commit" : "Full PR"}${
    params.reviewMode === "commit" && params.commitSha ? ` (${params.commitSha.slice(0, 7)})` : ""
  }

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
- Answer questions about the code

When review mode is **Commit**, \`pr_metadata\` and \`pr_diff\` are commit-scoped. Do not assume full PR context unless user asks.
${personalitySection}`;
}
