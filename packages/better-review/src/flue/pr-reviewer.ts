"use agent";

import {
  defineTool,
  useAgentFinish,
  useAgentStart,
  useModel,
  useSandbox,
  useTool,
  type AgentProps,
} from "@flue/runtime";

import { readFlueReviewSessionSync, type FlueReviewSession } from "../flue-review-sessions";
import { getCurrentFlueModel, getCurrentFlueThinkingLevel } from "../model-selection";
import { reviewBaseRef } from "../pr-checkout";
import {
  beginMicrosandboxSubmission,
  endMicrosandboxSubmission,
  microsandboxFactory,
} from "./microsandbox";

function buildInstructions(session: FlueReviewSession): string {
  const baseRef = session.baseRef ?? "develop";
  const headRef = session.headRef ?? "HEAD";
  const isCommitReview = session.reviewMode === "commit" && session.commitSha;
  const canonicalDiff = isCommitReview
    ? `${session.commitSha}^..${session.commitSha}`
    : `${reviewBaseRef(session)}...HEAD`;

  const scope = isCommitReview
    ? `Review only commit ${session.commitSha}.`
    : `Review only the PR diff ${canonicalDiff}.`;

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
    : "Repository access check was not recorded for this session. Call verify_repo_access.";

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
    "You are running in a network-disabled microVM with a read-only prepared checkout. Treat it as the source of truth.",
    `Canonical PR diff commands: git diff --stat ${canonicalDiff}; git diff --name-only ${canonicalDiff}; git diff ${canonicalDiff}.`,
    `The immutable review base ${reviewBaseRef(session)} must resolve. Do not substitute mutable ${baseRef} or origin/${baseRef} refs.`,
    `If the canonical range cannot be diffed, report that the prepared checkout is invalid and ask the user to reload the PR session.`,
    "Use git and code-search tools to inspect surrounding implementation, not just a patch.",
    "The checkout is intentionally read-only. Do not attempt to modify it.",
    "Prefer concrete findings with file and line references. Call out uncertainty when context is insufficient.",
    "If the user asks whether you can access the whole repo, call verify_repo_access and report its result.",
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
      "Verify inside the isolated review sandbox that the checkout is the expected Git root, is not sparse, and exposes tracked files.",
    harness: true,
    run: async ({ harness }) => {
      const [root, tracked, sparse] = await Promise.all([
        harness.sandbox.exec("git rev-parse --show-toplevel"),
        harness.sandbox.exec("git ls-files -z"),
        harness.sandbox.exec("git config --bool core.sparseCheckout"),
      ]);
      if (root.exitCode !== 0 || tracked.exitCode !== 0) {
        throw new Error(root.stderr || tracked.stderr || "Repository access verification failed");
      }

      const trackedFileCount = tracked.stdout.split("\0").filter(Boolean).length;
      const sparseCheckout = sparse.exitCode === 0 && sparse.stdout.trim() === "true";
      if (root.stdout.trim() !== session.worktreePath || trackedFileCount === 0 || sparseCheckout) {
        throw new Error("The prepared checkout does not expose the expected full repository");
      }

      return JSON.stringify(
        {
          status: "passed",
          worktreePath: session.worktreePath,
          trackedFileCount,
          sparseCheckout,
        },
        null,
        2,
      );
    },
  });
}

export function PrReviewer({ id }: AgentProps) {
  const session = readFlueReviewSessionSync(id);
  if (!session) throw new Error(`Flue 2 review session not found: ${id}`);

  const model = getCurrentFlueModel();
  const thinkingLevel = getCurrentFlueThinkingLevel();
  useModel(model, { thinkingLevel });
  // The adapter already returns the prepared worktree as its cwd. Passing a
  // useSandbox cwd option would make Flue create a portable-methods-only
  // wrapper and hide the adapter lifecycle methods used by the hooks below.
  useSandbox(microsandboxFactory);
  useTool(makeVerifyRepoAccessTool(session));
  useAgentStart(({ harness, signal }) => {
    const cleanup = () =>
      void endMicrosandboxSubmission(harness.sandbox).catch((error) =>
        console.warn(`[Microsandbox] Failed to clean up an aborted submission:`, error),
      );
    signal.addEventListener("abort", cleanup, { once: true });
    return beginMicrosandboxSubmission(harness.sandbox);
  });
  useAgentFinish(({ harness }) => endMicrosandboxSubmission(harness.sandbox));

  return buildInstructions(session);
}
