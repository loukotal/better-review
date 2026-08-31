import { spawn } from "node:child_process";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

type ReviewRun = {
  result: ReviewResult;
  sessionUrl?: string;
};

function formatResult({ result, sessionUrl }: ReviewRun): string {
  const lines = [
    result.approved ? "Human review approved this." : "Human review requested changes.",
    `Session: ${result.sessionId}`,
  ];

  if (sessionUrl) lines.push(`Review URL: ${sessionUrl}`);
  if (result.feedback.trim()) lines.push("", "Overall feedback:", result.feedback.trim());

  if (result.annotations.length > 0) {
    lines.push("", "Annotations:");
    for (const annotation of result.annotations) {
      lines.push(`- ${annotation.quote}`, `  ${annotation.comment}`);
    }
  }

  if (result.agentMessage?.trim()) {
    lines.push("", "Feedback for the agent:", result.agentMessage.trim());
  }

  return lines.join("\n");
}

function findTailscaleUrl(portlessOutput: string): string | undefined {
  const lines = portlessOutput.split("\n");
  let inBetterReviewRoute = false;

  for (const line of lines) {
    if (/^\s*https:\/\/better-review\./.test(line)) {
      inBetterReviewRoute = true;
      continue;
    }
    if (inBetterReviewRoute && /^\s*https:\/\//.test(line)) break;

    const match = inBetterReviewRoute ? line.match(/^\s*tailscale:\s*(https:\/\/\S+)/) : null;
    if (match?.[1]) return match[1];
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  async function resolveWebUrl(signal: AbortSignal | undefined): Promise<string> {
    const configured =
      process.env.BETTER_REVIEW_TAILSCALE_URL?.trim() ?? process.env.BETTER_REVIEW_WEB_URL?.trim();
    if (configured) return configured.replace(/\/$/, "");

    try {
      const routes = await pi.exec("portless", ["list"], { signal, timeout: 5_000 });
      const tailscaleUrl = findTailscaleUrl(routes.stdout);
      if (tailscaleUrl) return tailscaleUrl.replace(/\/$/, "");
    } catch {
      // Portless is optional; use its conventional local URL as the fallback.
    }

    return "https://better-review.localhost";
  }

  async function runBetterReview(
    command: "plan" | "last" | "review",
    inputText: string | undefined,
    title: string | undefined,
    cwd: string,
    signal: AbortSignal | undefined,
    onUpdate:
      | ((result: { content: Array<{ type: "text"; text: string }>; details: object }) => void)
      | undefined,
  ): Promise<ReviewRun> {
    const webUrl = await resolveWebUrl(signal);
    const args = [command, "--origin", "pi", "--cwd", cwd, "--no-open"];
    if (title?.trim()) args.push("--title", title.trim());

    return await new Promise((resolve, reject) => {
      const child = spawn("better-review", args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          BETTER_REVIEW_WEB_URL: webUrl,
          BETTER_REVIEW_API_URL: process.env.BETTER_REVIEW_API_URL ?? "http://127.0.0.1:3001",
        },
      });

      let stdout = "";
      let stderr = "";
      let sessionUrl: string | undefined;
      let settled = false;

      const stop = () => {
        if (!child.pid) return;
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
        } catch {
          // The process may already have exited.
        }
      };
      const abort = () => stop();
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        const match = stderr.match(/Open review:\s*(https?:\/\/\S+)/);
        if (match?.[1] && match[1] !== sessionUrl) {
          sessionUrl = match[1];
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Waiting for human review. Open this session from your tailnet:\n${sessionUrl}`,
              },
            ],
            details: { sessionUrl },
          });
        }
      });

      child.once("error", (error) => {
        settled = true;
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);

        if (signal?.aborted) {
          reject(new Error("Better Review was cancelled"));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `better-review failed with code ${code}`));
          return;
        }

        try {
          resolve({ result: JSON.parse(stdout) as ReviewResult, sessionUrl });
        } catch (error) {
          reject(
            new Error(
              `Failed to parse better-review JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`,
            ),
          );
        }
      });

      if (inputText) child.stdin.write(inputText);
      child.stdin.end();
    });
  }

  const registerReviewTool = (
    name: "submit_plan" | "review_last_message" | "review_working_diff",
    command: "plan" | "last" | "review",
    description: string,
    includeContent: boolean,
  ) => {
    pi.registerTool({
      name,
      label: name
        .split("_")
        .map((word) => word[0]?.toUpperCase() + word.slice(1))
        .join(" "),
      description,
      promptSnippet: description,
      promptGuidelines: [
        `Use ${name} when the user asks for this kind of human review. The tool displays the live Tailscale review URL while it waits for feedback.`,
      ],
      parameters: Type.Object({
        ...(includeContent
          ? { content: Type.String({ description: "Markdown content to review" }) }
          : {}),
        title: Type.Optional(Type.String({ description: "Optional review-session title" })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const input = params as { content?: string; title?: string };
        const run = await runBetterReview(
          command,
          input.content,
          input.title,
          ctx.cwd,
          signal,
          onUpdate,
        );
        return {
          content: [{ type: "text", text: formatResult(run) }],
          details: run,
        };
      },
    });
  };

  registerReviewTool(
    "submit_plan",
    "plan",
    "Send a markdown plan to Better Review and wait for human feedback.",
    true,
  );
  registerReviewTool(
    "review_last_message",
    "last",
    "Send the latest substantive assistant message to Better Review and wait for human feedback.",
    true,
  );
  registerReviewTool(
    "review_working_diff",
    "review",
    "Open Better Review for the current repository and let the human choose the diff scope.",
    false,
  );
}
