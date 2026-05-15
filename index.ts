#!/usr/bin/env tsx

export {};

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  exportReviewFeedback,
  formatReviewFeedbackForAgent,
  type ReviewSession,
  type ReviewSessionDiffVariant,
  type ReviewSessionMode as ReviewMode,
  type ReviewSessionPayload,
  type ReviewSessionResult,
} from "@better-review/shared";

interface CliOptions {
  file?: string;
  title?: string;
  origin: string;
  cwd?: string;
  repoRoot?: string;
  label?: string;
  apiUrl: string;
  webUrl: string;
  openBrowser: boolean;
  printUrlOnly: boolean;
  timeoutMs: number;
  pollMs: number;
}

interface CliReviewOutput extends ReviewSessionResult {
  feedbackMarkdown: string;
  agentMessage: string;
}

function printUsage(): void {
  console.log(`better-review

Usage:
  better-review plan [options]
  better-review last [options]
  better-review review [options]
  better-review open-session <session-id> [options]

Options:
  --file <path>          Read input from a file instead of stdin
  --title <text>         Override the session title
  --origin <name>        Set session origin (default: manual)
  --cwd <path>           Override cwd metadata
  --repo-root <path>     Override repo root metadata
  --label <text>         Label for diff payloads
  --api-url <url>        API base URL (default: http://127.0.0.1:3001)
  --web-url <url>        Web base URL (default: http://127.0.0.1:3000)
  --open                 Open the browser after creating the session
  --no-open              Do not open the browser
  --print-url            Print the review URL and exit immediately
  --timeout-ms <ms>      Wait timeout (default: 3600000)
  --poll-ms <ms>         Poll interval (default: 1000)
  --help                 Show this help

Examples:
  better-review plan < AGENT_REVIEW_PLAN.md
  better-review last --file message.md
  better-review review
  better-review open-session 1234-5678 --web-url http://127.0.0.1:3001`);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readableToText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readStdin(): Promise<string> {
  return await readableToText(process.stdin);
}

async function readInput(file?: string): Promise<string> {
  if (file) {
    return await readFile(file, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error("No input provided. Use stdin or --file.");
  }

  return await readStdin();
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitCodePromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readableToText(child.stdout),
    readableToText(child.stderr),
    exitCodePromise,
  ]);

  return { stdout, stderr, exitCode };
}

async function getGitDiff(cwd: string, args: string[] = []): Promise<string> {
  const { stdout, stderr, exitCode } = await runGit(cwd, [
    "diff",
    "--no-ext-diff",
    "--binary",
    ...args,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git diff failed");
  }

  return stdout;
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const { exitCode } = await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return exitCode === 0;
}

async function hasHeadCommit(cwd: string): Promise<boolean> {
  return await gitRefExists(cwd, "HEAD");
}

async function hasParentCommit(cwd: string): Promise<boolean> {
  const { exitCode } = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
  return exitCode === 0;
}

async function getEmptyTreeSha(cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runGit(cwd, [
    "hash-object",
    "-t",
    "tree",
    "/dev/null",
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git hash-object failed");
  }
  return stdout.trim();
}

async function resolvePreferredBaseRef(
  cwd: string,
  refs: readonly string[],
): Promise<string | undefined> {
  for (const ref of refs) {
    if (await gitRefExists(cwd, ref)) return ref;
  }
  return undefined;
}

async function resolveCommitSha(cwd: string, ref: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runGit(cwd, ["rev-parse", ref]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git rev-parse ${ref} failed`);
  }
  return stdout.trim();
}

async function resolveMergeBaseSha(cwd: string, left: string, right: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runGit(cwd, ["merge-base", left, right]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git merge-base ${left} ${right} failed`);
  }
  return stdout.trim();
}

async function buildDiffVariants(cwd: string): Promise<ReviewSessionDiffVariant[]> {
  const headExists = await hasHeadCommit(cwd);
  const headSha = headExists ? await resolveCommitSha(cwd, "HEAD") : null;

  const variants: ReviewSessionDiffVariant[] = [
    {
      id: "unstaged",
      label: "Unstaged changes",
      description: "git diff",
      rawPatch: await getGitDiff(cwd),
      contentSource: { kind: "unstaged", headSha },
    },
    {
      id: "staged",
      label: "Staged changes",
      description: "git diff --cached",
      rawPatch: await getGitDiff(cwd, ["--cached"]),
      contentSource: { kind: "staged", headSha },
    },
  ];

  if (headExists && headSha) {
    const hasParent = await hasParentCommit(cwd);
    const baseSha = hasParent ? await resolveCommitSha(cwd, "HEAD^") : await getEmptyTreeSha(cwd);
    const lastCommitRawPatch = hasParent
      ? await getGitDiff(cwd, ["HEAD^..HEAD"])
      : await getGitDiff(cwd, [`${baseSha}..HEAD`]);

    variants.push({
      id: "last-commit",
      label: "Latest commit",
      description: hasParent ? "git diff HEAD^..HEAD" : "git diff <empty-tree>..HEAD",
      rawPatch: lastCommitRawPatch,
      contentSource: { kind: "commit", baseSha, headSha },
    });

    for (const [baseName, candidates] of [
      ["main", ["main", "origin/main"]],
      ["develop", ["develop", "origin/develop"]],
    ] as const) {
      const baseRef = await resolvePreferredBaseRef(cwd, candidates);
      if (!baseRef) continue;
      const mergeBaseSha = await resolveMergeBaseSha(cwd, baseRef, "HEAD");
      variants.push({
        id: `branch-${baseName}`,
        label: `Branch vs ${baseName}`,
        description: `git diff ${baseRef}...HEAD`,
        rawPatch: await getGitDiff(cwd, [`${baseRef}...HEAD`]),
        contentSource: { kind: "git-refs", baseSha: mergeBaseSha, headSha },
      });
    }
  }

  return variants;
}

async function tryGitRepoRoot(cwd: string): Promise<string | undefined> {
  const { stdout, exitCode } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (exitCode !== 0) return undefined;
  const value = stdout.trim();
  return value.length > 0 ? value : undefined;
}

function buildDefaultTitle(mode: ReviewMode, cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : "workspace";
  if (mode === "plan") return `Plan Review: ${name}`;
  if (mode === "message") return `Last Message Review: ${name}`;
  return `Diff Review: ${name}`;
}

function buildPayload(
  mode: ReviewMode,
  content: string,
  label?: string,
  diffVariants?: ReviewSessionDiffVariant[],
): ReviewSessionPayload {
  if (mode === "plan") {
    return { kind: "markdown", content };
  }
  if (mode === "message") {
    return { kind: "message", content };
  }

  const selectedVariant = diffVariants?.find((variant) => variant.rawPatch === content);

  return {
    kind: "diff",
    rawPatch: content,
    label: selectedVariant?.label ?? label,
    selectedVariantId: selectedVariant?.id,
    variants: diffVariants,
  };
}

async function ensureApiAvailable(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/sessions/healthcheck`, {
    method: "GET",
  }).catch(() => null);

  if (response?.ok || response?.status === 404) {
    return;
  }

  throw new Error(
    `Could not reach better-review API at ${apiUrl}. Start the app with 'pnpm dev' or 'pnpm start', or pass --api-url.`,
  );
}

async function createSession(
  apiUrl: string,
  input: Omit<ReviewSession, "id" | "createdAt" | "status">,
): Promise<ReviewSession> {
  const response = await fetch(`${apiUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${await response.text()}`);
  }

  return (await response.json()) as ReviewSession;
}

async function getResult(apiUrl: string, sessionId: string): Promise<ReviewSessionResult | null> {
  const response = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/result`);
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch result: ${await response.text()}`);
  }
  return (await response.json()) as ReviewSessionResult;
}

function buildSessionUrl(webUrl: string, sessionId: string): string {
  return `${normalizeBaseUrl(webUrl)}/agent-review/${encodeURIComponent(sessionId)}`;
}

async function openUrl(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const [executable, ...args] = command;
  if (!executable) {
    throw new Error(`Failed to open browser for ${url}`);
  }

  const child = spawn(executable, args, {
    stdio: "ignore",
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Failed to open browser for ${url}`);
  }
}

function parseArgs(argv: string[]): {
  command: string | null;
  positionals: string[];
  options: CliOptions;
} {
  const options: CliOptions = {
    origin: "manual",
    apiUrl: normalizeBaseUrl(process.env.BETTER_REVIEW_API_URL ?? "http://127.0.0.1:3001"),
    webUrl: normalizeBaseUrl(
      process.env.BETTER_REVIEW_WEB_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? "3000"}`,
    ),
    openBrowser: true,
    printUrlOnly: false,
    timeoutMs: 60 * 60 * 1000,
    pollMs: 1000,
  };

  if (argv.length === 0) {
    return { command: null, positionals: [], options };
  }

  const command = argv[0] ?? null;
  const rest = argv.slice(1);
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (!arg) continue;

    switch (arg) {
      case "--file":
        options.file = next;
        i += 1;
        break;
      case "--title":
        options.title = next;
        i += 1;
        break;
      case "--origin":
        options.origin = next ?? options.origin;
        i += 1;
        break;
      case "--cwd":
        options.cwd = next;
        i += 1;
        break;
      case "--repo-root":
        options.repoRoot = next;
        i += 1;
        break;
      case "--label":
        options.label = next;
        i += 1;
        break;
      case "--api-url":
        options.apiUrl = normalizeBaseUrl(next ?? options.apiUrl);
        i += 1;
        break;
      case "--web-url":
        options.webUrl = normalizeBaseUrl(next ?? options.webUrl);
        i += 1;
        break;
      case "--open":
        options.openBrowser = true;
        break;
      case "--no-open":
        options.openBrowser = false;
        break;
      case "--print-url":
        options.printUrlOnly = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--poll-ms":
        options.pollMs = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        positionals.push(arg);
        break;
    }
  }

  return { command, positionals, options };
}

async function waitForResult(
  apiUrl: string,
  sessionId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ReviewSessionResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await getResult(apiUrl, sessionId);
    if (result) return result;
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for review result after ${timeoutMs}ms`);
}

function toCliOutput(session: ReviewSession, result: ReviewSessionResult): CliReviewOutput {
  return {
    ...result,
    feedbackMarkdown: exportReviewFeedback(result),
    agentMessage: formatReviewFeedbackForAgent(session, result),
  };
}

async function handleCreateCommand(mode: ReviewMode, options: CliOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = options.repoRoot ?? (await tryGitRepoRoot(cwd));

  let content: string;
  let diffVariants: ReviewSessionDiffVariant[] | undefined;

  if (mode === "diff") {
    if (options.file) {
      content = await readInput(options.file);
    } else {
      diffVariants = await buildDiffVariants(cwd);
      const selectedVariant = diffVariants.find((variant) => variant.rawPatch.trim().length > 0);
      if (!selectedVariant) {
        throw new Error(
          "No diff content found for unstaged, staged, latest commit, or branch comparisons",
        );
      }
      content = selectedVariant.rawPatch;
      options.label = selectedVariant.label;
    }
  } else {
    content = await readInput(options.file);
  }

  if (content.trim().length === 0) {
    throw new Error(mode === "diff" ? "No diff content found" : "Input content was empty");
  }

  await ensureApiAvailable(options.apiUrl);

  const session = await createSession(options.apiUrl, {
    mode,
    origin: options.origin,
    title: options.title ?? buildDefaultTitle(mode, cwd),
    cwd,
    repoRoot,
    payload: buildPayload(mode, content, options.label, diffVariants),
    returnChannel: {
      type: "stdout",
    },
  });

  const sessionUrl = buildSessionUrl(options.webUrl, session.id);

  if (options.printUrlOnly) {
    console.log(sessionUrl);
    return;
  }

  console.error(`Session created: ${session.id}`);
  console.error(`Open review: ${sessionUrl}`);

  if (options.openBrowser) {
    await openUrl(sessionUrl).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  }

  const result = await waitForResult(options.apiUrl, session.id, options.timeoutMs, options.pollMs);
  console.log(JSON.stringify(toCliOutput(session, result), null, 2));
}

async function handleOpenSession(sessionId: string, options: CliOptions): Promise<void> {
  const sessionUrl = buildSessionUrl(options.webUrl, sessionId);
  console.log(sessionUrl);

  if (options.openBrowser) {
    await openUrl(sessionUrl).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  }
}

async function main(): Promise<void> {
  const { command, positionals, options } = parseArgs(process.argv.slice(2));

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "plan") {
    await handleCreateCommand("plan", options);
    return;
  }

  if (command === "last") {
    await handleCreateCommand("message", options);
    return;
  }

  if (command === "review") {
    await handleCreateCommand("diff", options);
    return;
  }

  if (command === "open-session") {
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error("Missing session id for open-session");
    }
    await handleOpenSession(sessionId, options);
    return;
  }

  if (command === "--help" || command === "help") {
    printUsage();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
