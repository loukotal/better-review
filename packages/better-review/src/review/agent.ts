import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

import { reviewBaseRef } from "../pr-checkout";
import type { PrReviewSession } from "../pr-review-sessions";
import type { SubmissionSandbox } from "./microsandbox";

export function reviewInstructions(session: PrReviewSession): string {
  const range =
    session.reviewMode === "commit" && session.commitSha
      ? `${session.commitSha}^..${session.commitSha}`
      : `${reviewBaseRef(session)}...HEAD`;
  return [
    "You are Better Review's PR reviewer. Inspect code and surrounding implementation before reporting concrete defects.",
    `PR: ${session.prUrl}. Reviewed head: ${session.headSha}. Base: ${session.baseSha}.`,
    `Canonical review diff: git diff ${range}. Do not substitute mutable branch refs.`,
    "Tools run in a network-disabled microVM with a read-only checkout. Scratch files are disposable. Do not modify the repository.",
    "Earlier conversation entries can describe older revisions. Re-read current code and revalidate earlier findings. History can be force-pushed; do not assume ancestry.",
    `Earlier heads: ${(session.revisionHistory ?? []).map((revision) => revision.commitSha ?? revision.headSha).join(", ") || "none"}.`,
    `Changed files:\n${session.files.join("\n")}`,
    'Use <<ANNOTATION file="path/to/file" line="123" severity="warning">>message<</ANNOTATION>> for actionable findings.',
    'Use <<REVIEW_ORDER>>["path/to/file"]<</REVIEW_ORDER>> for suggested reading order.',
    "Separate resolved, outstanding and new findings when continuing after a revision update. Keep file and line references tied to the currently reviewed revision.",
  ].join("\n\n");
}

export function reviewerExtension(
  getSession: () => Promise<PrReviewSession>,
  getSandbox: () => Promise<SubmissionSandbox>,
) {
  const bash = defineTool({
    name: "bash",
    description: "Run git, grep, find or shell commands in the isolated review checkout.",
    parameters: Type.Object({
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 120000 })),
    }),
    replay: "unsafe",
    outputLimits: { maxBytes: 48000, maxLines: 1000, retain: "tail" },
    execute: async ({ command, timeoutMs }, api, context) => {
      context.abortSignal?.throwIfAborted();
      const result = await (
        await getSandbox()
      ).exec(command, { signal: context.abortSignal, timeoutMs });
      api.output(result.stdout + result.stderr);
      return { isError: result.exitCode !== 0, details: { exitCode: result.exitCode } };
    },
  });
  const read = defineTool({
    name: "read",
    description:
      "Read a UTF-8 file with 1-based line numbers. Use offset and limit for large files.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 48000, maxLines: 2000 },
    execute: async ({ path, offset = 1, limit = 200 }, api, context) => {
      context.abortSignal?.throwIfAborted();
      api.output(await (await getSandbox()).readLines(path, offset, limit, context.abortSignal));
      return {};
    },
  });
  const verify = defineTool({
    name: "verify_repo_access",
    description: "Verify the reviewed revision and full repository access inside the sandbox.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const session = await getSession();
      const vm = await getSandbox();
      const result = await vm.exec(
        "git rev-parse HEAD && git rev-parse --show-toplevel && git ls-files | wc -l",
        { signal: context.abortSignal },
      );
      if (result.exitCode !== 0 || result.stdout.split("\n")[0] !== session.headSha)
        throw new Error("Review checkout does not match its saved revision");
      api.output(result.stdout);
      return {};
    },
  });
  return defineExtension({
    name: "pr-reviewer",
    tools: [read, bash, verify],
    sections: [section("review", async () => reviewInstructions(await getSession()))],
  });
}
