import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

import type { PrReviewSession } from "../pr-review-sessions";
import { openReviewEngine } from "./engine";
import type { SubmissionSandbox } from "./microsandbox";

export const fixtureSession: PrReviewSession = {
  runtimeVersion: 3,
  id: "review-test",
  prUrl: "https://github.com/acme/app/pull/1",
  owner: "acme",
  repo: "app",
  number: 1,
  headSha: "A",
  baseSha: "base",
  baseRef: "main",
  headRef: "feature",
  reviewMode: "full",
  commitSha: null,
  worktreePath: "/fixture/A",
  files: ["source.ts"],
  createdAt: 1,
  updatedAt: 1,
};
export function fixtureSandbox(head: string, read?: () => Promise<string>): SubmissionSandbox {
  return {
    cwd: `/fixture/${head}`,
    beginSubmission: async () => {},
    endSubmission: async () => {},
    exec: async (command, options) => {
      if (command === "wait") {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return { stdout: head, stderr: "", exitCode: 0 };
    },
    readFile: read ?? (async () => `revision ${head}`),
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async () => {
      throw new Error("read-only");
    },
    stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 1 }),
    readdir: async () => ["source.ts"],
    exists: async () => true,
    mkdir: async () => {},
    rm: async () => {},
  };
}
export function fixtureModels(responses?: FauxResponseStep[]) {
  const provider = fauxProvider({
    provider: "review-fixture",
    models: [{ id: "review", reasoning: true }],
  });
  const respond: FauxResponseStep = (input) =>
    input.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("Review complete")
      : fauxAssistantMessage(fauxToolCall("read", { path: "source.ts" }), {
          stopReason: "toolUse",
        });
  provider.setResponses(responses ?? Array.from({ length: 40 }, () => respond));
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider, model: { provider: "review-fixture", modelId: "review" } };
}
export async function crashEngine(database: string, pause = false) {
  const { models, model } = fixtureModels();
  return openReviewEngine({
    database,
    session: fixtureSession,
    models,
    model,
    sandbox: async (session) =>
      fixtureSandbox(
        session.headSha,
        pause
          ? async () => {
              process.stdout.write("DURABLE_READ_READY\n");
              await new Promise((resolve) => setTimeout(resolve, 60000));
              return "unreachable";
            }
          : undefined,
      ),
  });
}
if (process.argv[2] === "--crash-worker") {
  const engine = await crashEngine(process.argv[3]!, true);
  await engine.submit("Review A", "initial-request", {
    provider: "review-fixture",
    modelId: "review",
  });
}
