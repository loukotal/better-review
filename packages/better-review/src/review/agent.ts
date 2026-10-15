import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

import { reviewBaseRef } from "../pr-checkout";
import type { PrReviewSession } from "../pr-review-sessions";
import type { SubmissionSandbox } from "./microsandbox";
import { StructuredReviewTools } from "./structured-tools";
import { createToolObservability, type ToolObservation } from "./tool-observability";

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
    "Prefer review_diff for the canonical saved review scope, search for literal/extended-regex code navigation, and read_files for batched file ranges. These tools read immutable Git objects, not scratch files. Use bash only as an escape hatch for commands the structured tools cannot express.",
    "Structured results have explicit truncation and opaque continuation tokens. Repeat the identical arguments with continuation to retrieve the next page. Long lines can span fragments: row identifies the stream record, byte is its byte offset, and totalBytes is its full length. Never treat truncated output or a tool error as absence of code. Search context lines are included without claiming that each line matches.",
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
  const structured = new StructuredReviewTools(getSession, getSandbox);
  const observations = createToolObservability();
  let observedRevision = "";
  const observe = async <T>(
    name: string,
    args: unknown,
    execute: (observation: ToolObservation) => Promise<T>,
  ) => {
    const session = await getSession();
    const revision = `${session.owner}/${session.repo}:${session.headSha}:${session.baseSha}:${session.reviewMode}:${session.commitSha}`;
    if (revision !== observedRevision) {
      observations.reset();
      observedRevision = revision;
    }
    return observations.observe(name, args, execute);
  };
  const continuation = Type.Optional(Type.String());
  const paths = Type.Optional(Type.Array(Type.String(), { maxItems: 32 }));
  const contextLines = Type.Optional(Type.Integer({ minimum: 0, maximum: 10 }));
  const search = defineTool({
    name: "search",
    description:
      "Search immutable reviewed files using literal text (default) or extended regex. Optional literal file/directory paths, bounded context, explicit no_match/errors, and revision-bound pagination.",
    parameters: Type.Object({
      pattern: Type.String({ maxLength: 2000 }),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex")])),
      paths,
      context: contextLines,
      continuation,
    }),
    replay: "safe",
    outputLimits: { maxBytes: 192000, maxLines: 2000 },
    execute: async (args, api, context) =>
      observe("search", args, async (observation) => {
        const result = await structured.search(args, context.abortSignal, observation);
        const text = JSON.stringify(result);
        observation.output(text, {
          truncated: result.truncated,
          isError: result.status === "error",
        });
        api.output(text);
        return { isError: result.status === "error" };
      }),
  });
  const readFiles = defineTool({
    name: "read_files",
    description:
      "Read batched 1-based inclusive file line ranges from the immutable reviewed revision. Overlaps merge; all files share a bounded page budget. Each file has independent errors. Continue with identical ranges and the returned token.",
    parameters: Type.Object({
      ranges: Type.Array(
        Type.Object({
          path: Type.String(),
          start: Type.Optional(Type.Integer({ minimum: 1 })),
          end: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        { minItems: 1, maxItems: 32 },
      ),
      continuation,
    }),
    replay: "safe",
    outputLimits: { maxBytes: 192000, maxLines: 2000 },
    execute: async (args, api, context) =>
      observe("read_files", args, async (observation) => {
        const result = await structured.read(args, context.abortSignal, observation);
        const text = JSON.stringify(result);
        observation.output(text, {
          truncated: result.truncated,
          isError: result.files.some((file) => file.error !== undefined),
        });
        api.output(text);
        return { isError: result.files.some((file) => file.error !== undefined) };
      }),
  });
  const reviewDiff = defineTool({
    name: "review_diff",
    description:
      "Canonical diff using the saved full-PR base/head or saved commit/parent, never mutable branch names. Includes renames, old/new hunk line numbers, optional literal paths and context, and bounded pagination.",
    parameters: Type.Object({ paths, context: contextLines, continuation }),
    replay: "safe",
    outputLimits: { maxBytes: 192000, maxLines: 2000 },
    execute: async (args, api, context) =>
      observe("review_diff", args, async (observation) => {
        const result = await structured.diff(args, context.abortSignal, observation);
        const text = JSON.stringify(result);
        observation.output(text, {
          truncated: result.truncated,
          isError: result.status === "error",
        });
        api.output(text);
        return { isError: result.status === "error" };
      }),
  });
  const bash = defineTool({
    name: "bash",
    description:
      "Escape hatch for shell commands in the isolated checkout. Prefer search, read_files and review_diff for repository inspection. Scratch output is disposable and never cached.",
    parameters: Type.Object({
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 120000 })),
    }),
    replay: "unsafe",
    outputLimits: { maxBytes: 48000, maxLines: 1000, retain: "tail" },
    execute: async (args, api, context) =>
      observe("bash", args, async (observation) => {
        const { command, timeoutMs } = args;
        context.abortSignal?.throwIfAborted();
        const result = await (
          await getSandbox()
        ).exec(command, { signal: context.abortSignal, timeoutMs });
        const raw = result.stdout + result.stderr;
        const lines = raw.split("\n");
        const clipped = lines.slice(-999).join("\n");
        const bytes = Buffer.from(clipped);
        let start = Math.max(0, bytes.length - 46000);
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        const truncated =
          lines.length > 999 || start > 0 || /\[\d+ earlier output bytes omitted\]/.test(raw);
        const text = `${truncated ? "[Bash output truncated]\n" : ""}${bytes.subarray(start).toString("utf8")}`;
        observation.output(text, { truncated, isError: result.exitCode !== 0 });
        api.output(text);
        return { isError: result.exitCode !== 0, details: { exitCode: result.exitCode } };
      }),
  });
  const read = defineTool({
    name: "read",
    description:
      "Legacy uncached UTF-8 read with 1-based numbered text, offset and limit. Accepts checkout-relative or allowed absolute checkout/scratch paths. Prefer read_files for immutable, validated reads and structured continuations.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 192000, maxLines: 2000 },
    execute: async (args, api, context) =>
      observe("read", args, async (observation) => {
        const { path, offset = 1, limit = 200 } = args;
        context.abortSignal?.throwIfAborted();
        const text = await (await getSandbox()).readLines(path, offset, limit, context.abortSignal);
        observation.output(text, { truncated: /\[Read output truncated/.test(text) });
        api.output(text);
        return {};
      }),
  });
  const verify = defineTool({
    name: "verify_repo_access",
    description: "Verify the reviewed revision and full repository access inside the sandbox.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (args, api, context) =>
      observe("verify_repo_access", args, async (observation) => {
        const session = await getSession();
        const vm = await getSandbox();
        const result = await vm.execStructured(
          "git -c safe.directory='*' rev-parse HEAD && git -c safe.directory='*' rev-parse --show-toplevel && git -c safe.directory='*' ls-files | wc -l",
          { signal: context.abortSignal },
        );
        if (result.exitCode !== 0 || result.stdout.split("\n")[0] !== session.headSha)
          throw new Error("Review checkout does not match its saved revision");
        api.output(result.stdout);
        observation.output(result.stdout);
        return {};
      }),
  });
  return defineExtension({
    name: "pr-reviewer",
    tools: [search, readFiles, reviewDiff, read, bash, verify],
    sections: [section("review", async () => reviewInstructions(await getSession()))],
  });
}
