import { spawn } from "node:child_process";

import { tool, type Plugin } from "@opencode-ai/plugin";

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

function formatToolResult(result: ReviewResult): string {
  const agentMessage = result.agentMessage?.trim();
  return [
    agentMessage || formatResult(result),
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
 */
export const BetterReviewPlugin: Plugin = async () => {
  return {
    tool: {
      submit_plan: tool({
        description:
          "Send a markdown plan to better-review and wait for human approval or feedback.",
        args: {
          markdown: tool.schema.string(),
          title: tool.schema.string().optional(),
        },
        async execute(args) {
          const result = await runBetterReview("plan", args.markdown, args.title);
          return formatToolResult(result);
        },
      }),

      review_last_message: tool({
        description:
          "Send the latest assistant message to better-review and wait for human feedback.",
        args: {
          content: tool.schema.string(),
          title: tool.schema.string().optional(),
        },
        async execute(args) {
          const result = await runBetterReview("last", args.content, args.title);
          return formatToolResult(result);
        },
      }),

      review_working_diff: tool({
        description:
          "Open better-review for the current repo and let the reviewer choose the diff scope (unstaged, staged, latest commit, branch comparison).",
        args: {
          title: tool.schema.string().optional(),
        },
        async execute(args) {
          const result = await runBetterReview("review", undefined, args.title);
          return formatToolResult(result);
        },
      }),
    },
  };
};
