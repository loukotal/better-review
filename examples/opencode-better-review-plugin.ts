import { spawn } from "node:child_process";

import { tool, type Plugin } from "@opencode-ai/plugin";

type PluginClient = Parameters<Plugin>[0]["client"];

type ReviewResult = {
  approved: boolean;
  feedback: string;
  annotations: Array<{
    id: string;
    quote: string;
    comment: string;
    createdAt: number;
  }>;
  mode: "plan" | "message" | "diff";
  sessionId: string;
  submittedAt: number;
  feedbackMarkdown?: string;
  agentMessage?: string;
};

async function runBetterReview(
  command: "plan" | "last" | "review",
  inputText?: string,
  title?: string,
): Promise<ReviewResult> {
  const args = [command];

  if (title?.trim()) {
    args.push("--title", title.trim());
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("better-review", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BETTER_REVIEW_WEB_URL: process.env.BETTER_REVIEW_WEB_URL ?? "http://localhost:3000",
        BETTER_REVIEW_API_URL: process.env.BETTER_REVIEW_API_URL ?? "http://127.0.0.1:3001",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `better-review failed with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as ReviewResult);
      } catch (error) {
        reject(
          new Error(
            `Failed to parse better-review JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`,
          ),
        );
      }
    });

    if (inputText) {
      child.stdin.write(inputText);
    }
    child.stdin.end();
  });
}

function formatResult(result: ReviewResult): string {
  const lines = [
    result.approved ? "Human review approved this." : "Human review requested changes.",
  ];

  if (result.feedback.trim()) {
    lines.push("", "Overall feedback:", result.feedback.trim());
  }

  if (result.annotations.length > 0) {
    lines.push("", "Annotations:");
    for (const annotation of result.annotations) {
      lines.push(`- ${annotation.quote}`);
      lines.push(`  ${annotation.comment}`);
    }
  }

  return lines.join("\n");
}

function getReviewUserMessage(result: ReviewResult): string {
  return result.agentMessage?.trim() || formatResult(result);
}

async function submitReviewAsUserMessage(
  client: PluginClient,
  sessionID: string,
  agent: string,
  result: ReviewResult,
): Promise<string | undefined> {
  const text = getReviewUserMessage(result).trim();
  if (!text) return undefined;

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent,
        parts: [{ type: "text", text }],
      },
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function formatToolResult(result: ReviewResult, submitError?: string): string {
  if (!submitError) {
    return [
      "Human review completed and was submitted back into the chat as a user message.",
      `Status: ${result.approved ? "approved" : "changes requested"}`,
      `Session: ${result.sessionId}`,
    ].join("\n");
  }

  return [
    `Human review completed, but submitting it back into the chat failed: ${submitError}`,
    "",
    getReviewUserMessage(result),
    "",
    "Raw result:",
    "```json",
    JSON.stringify(
      {
        approved: result.approved,
        feedback: result.feedback,
        annotations: result.annotations,
        mode: result.mode,
        sessionId: result.sessionId,
        submittedAt: result.submittedAt,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/**
 * Copy this file into:
 *   .opencode/plugins/better-review.ts
 *
 * Also add:
 *   .opencode/package.json
 *
 * With:
 * {
 *   "dependencies": {
 *     "@opencode-ai/plugin": "latest"
 *   }
 * }
 *
 * Review output is posted back into the active session as a user message so
 * OpenCode can react to it in the next turn.
 */
export const BetterReviewPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      submit_plan: tool({
        description:
          "Send a markdown plan to better-review, then post the reviewed result back into the chat as a user message.",
        args: {
          markdown: tool.schema.string(),
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const result = await runBetterReview("plan", args.markdown, args.title);
          const submitError = await submitReviewAsUserMessage(
            client,
            context.sessionID,
            context.agent,
            result,
          );
          return formatToolResult(result, submitError);
        },
      }),

      review_last_message: tool({
        description:
          "Send the latest assistant message to better-review, then post the reviewed result back into the chat as a user message.",
        args: {
          content: tool.schema.string(),
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const result = await runBetterReview("last", args.content, args.title);
          const submitError = await submitReviewAsUserMessage(
            client,
            context.sessionID,
            context.agent,
            result,
          );
          return formatToolResult(result, submitError);
        },
      }),

      review_working_diff: tool({
        description:
          "Open better-review for the current repo, let the reviewer choose the diff scope, then post the reviewed result back into the chat as a user message.",
        args: {
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const result = await runBetterReview("review", undefined, args.title);
          const submitError = await submitReviewAsUserMessage(
            client,
            context.sessionID,
            context.agent,
            result,
          );
          return formatToolResult(result, submitError);
        },
      }),
    },
  };
};
