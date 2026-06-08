import { createAgent, defineTool } from "@flue/runtime";
import { local } from "@flue/runtime/node";

import { readFlueReviewSession } from "../flue-review-sessions";
import { getCurrentFlueModel, getCurrentFlueThinkingLevel } from "../model-selection";
import { verifyWorktreeAccess, type PreparePrCheckoutInput } from "../pr-checkout";

type FlueReviewSession = NonNullable<Awaited<ReturnType<typeof readFlueReviewSession>>>;

function sessionToCheckoutInput(session: FlueReviewSession): PreparePrCheckoutInput {
  return {
    owner: session.owner,
    repo: session.repo,
    number: session.number,
    prUrl: session.prUrl,
    baseSha: session.baseSha,
    headSha: session.headSha,
    baseRef: session.baseRef ?? "develop",
    headRef: session.headRef ?? "HEAD",
    reviewMode: session.reviewMode,
    commitSha: session.commitSha,
    files: session.files,
  };
}

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

  const repoAccess = session.repoAccess
    ? [
        "Repository access check passed before session start:",
        `- Tracked files visible: ${session.repoAccess.trackedFileCount}`,
        `- Sparse checkout: ${session.repoAccess.sparseCheckout ? "enabled" : "disabled"}`,
        `- Readable file samples: ${session.repoAccess.sampledFiles.join(", ")}`,
      ].join("\n")
    : "Repository access check was not recorded for this session. If asked, call verify_repo_access.";

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
    `Do not fall back to arbitrary raw SHA ranges like ${session.baseSha}..HEAD. If the canonical range cannot be diffed, report that the prepared checkout is invalid and ask the user to reload the PR session.`,
    "Use git and code-search tools to inspect surrounding implementation, not just a patch.",
    "Do not modify files unless the user explicitly asks you to implement a change.",
    "Prefer concrete findings with file and line references. Call out uncertainty when context is insufficient.",
    "If the user asks whether you can access the whole repo, call the verify_repo_access tool and report its result.",
    "",
    repoAccess,
    "",
    "Changed files from the app:",
    files,
    "",
    "When returning structured review feedback, use these app tokens when appropriate:",
    '<<ANNOTATION file="path/to/file" line="123" severity="warning">>message<</ANNOTATION>>',
    '<<REVIEW_ORDER>>["path/to/file"]<</REVIEW_ORDER>>',
  ].join("\n");
}

function makeVerifyRepoAccessTool(session: FlueReviewSession) {
  return defineTool({
    name: "verify_repo_access",
    description:
      "Verify that the reviewer worktree exposes the full repository: correct git root, tracked file enumeration, sparse checkout disabled, and readable sample files.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      const repoAccess = await verifyWorktreeAccess(
        session.worktreePath,
        sessionToCheckoutInput(session),
      );

      return JSON.stringify(
        {
          status: "passed",
          worktreePath: session.worktreePath,
          ...repoAccess,
        },
        null,
        2,
      );
    },
  });
}

export const prReviewerAgent = createAgent(async ({ id }) => {
  const session = await readFlueReviewSession(id);
  if (!session) {
    throw new Error(`Flue review session not found: ${id}`);
  }

  const model = getCurrentFlueModel();
  const thinkingLevel = getCurrentFlueThinkingLevel();
  console.log(
    `[Flue] Starting PR reviewer session ${id} with model ${model}, thinking=${thinkingLevel}`,
  );

  return {
    model,
    thinkingLevel,
    cwd: session.worktreePath,
    sandbox: local({
      cwd: session.worktreePath,
      env: {
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      },
    }),
    instructions: buildInstructions(session),
    tools: [makeVerifyRepoAccessTool(session)],
  };
});
