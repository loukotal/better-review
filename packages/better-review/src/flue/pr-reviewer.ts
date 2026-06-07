import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";

import { readFlueReviewSession } from "../flue-review-sessions";
import { getCurrentFlueModel } from "../model-selection";

function buildInstructions(session: Awaited<ReturnType<typeof readFlueReviewSession>>): string {
  if (!session) {
    throw new Error("Missing Flue review session");
  }

  const baseRef = session.baseRef ?? "develop";
  const headRef = session.headRef ?? "HEAD";
  const isCommitReview = session.reviewMode === "commit" && session.commitSha;
  const canonicalDiff = isCommitReview
    ? `${session.commitSha}^..${session.commitSha}`
    : `origin/${baseRef}...HEAD`;
  const alternateCanonicalDiff = isCommitReview ? canonicalDiff : `${baseRef}...HEAD`;

  const scope = isCommitReview
    ? `Review only commit ${session.commitSha}.`
    : `Review only the PR diff ${canonicalDiff} (equivalent local base: ${alternateCanonicalDiff}).`;

  const files =
    session.files.length > 0
      ? session.files.map((file) => `- ${file}`).join("\n")
      : `- Use git diff --name-only ${canonicalDiff}.`;

  return [
    "You are Better Review's local PR review agent.",
    "",
    `Repository: ${session.owner}/${session.repo}`,
    `PR: #${session.number}`,
    `PR URL: ${session.prUrl}`,
    `Base branch: ${baseRef}`,
    `Head branch: ${headRef}`,
    `Base SHA: ${session.baseSha}`,
    `Head SHA: ${session.headSha}`,
    scope,
    "",
    "You are running inside a local checkout of the PR head branch. Treat this checkout as the source of truth.",
    `Canonical PR diff commands: git diff --stat ${canonicalDiff}; git diff --name-only ${canonicalDiff}; git diff ${canonicalDiff}.`,
    `The local base branch ${baseRef} and remote-tracking base origin/${baseRef} should both resolve. If one fails, try the other canonical range only.`,
    `Do not fall back to arbitrary raw SHA ranges like ${session.baseSha}..HEAD if they show files outside the app-provided changed-file list; ask for help instead.`,
    "Use git and code-search tools to inspect surrounding implementation, not just a patch.",
    "Do not modify files unless the user explicitly asks you to implement a change.",
    "Prefer concrete findings with file and line references. Call out uncertainty when context is insufficient.",
    "",
    "Changed files from the app:",
    files,
    "",
    "When returning structured review feedback, use these app tokens when appropriate:",
    '<<ANNOTATION file="path/to/file" line="123" severity="warning">>message<</ANNOTATION>>',
    '<<REVIEW_ORDER>>["path/to/file"]<</REVIEW_ORDER>>',
  ].join("\n");
}

export const prReviewerAgent = createAgent(async ({ id }) => {
  const session = await readFlueReviewSession(id);
  if (!session) {
    throw new Error(`Flue review session not found: ${id}`);
  }

  const model = getCurrentFlueModel();
  console.log(`[Flue] Starting PR reviewer session ${id} with model ${model}`);

  return {
    model,
    cwd: session.worktreePath,
    sandbox: local({
      cwd: session.worktreePath,
      env: {
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      },
    }),
    instructions: buildInstructions(session),
  };
});
