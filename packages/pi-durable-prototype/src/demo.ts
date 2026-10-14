// Deterministic walkthrough: real SQLite + Pi Durable, scripted model and filesystem.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { openReview, type Revision } from "./review";

const revision = (headSha: string): Revision => ({
  owner: "prototype",
  repo: "fixture",
  number: 1,
  prUrl: "https://github.com/prototype/fixture/pull/1",
  headSha,
  baseSha: "base",
  headRef: "feature",
  baseRef: "main",
  worktreePath: `/prototype/${headSha}`,
  files: ["example.ts"],
  diffRange: "base...HEAD",
});

export async function demoPhase(database: string, phase: string) {
  const models = createModels();
  const faux = fauxProvider();
  // Each generation decides from the persisted transcript, so it also works after SIGKILL.
  const respond: Parameters<typeof faux.setResponses>[0][number] = (input) => {
    const messages = input.messages;
    const latest = messages.at(-1);
    return latest?.role === "toolResult"
      ? fauxAssistantMessage(`Reviewed current fixture: ${JSON.stringify(latest.content)}`)
      : fauxAssistantMessage(fauxToolCall("read", { path: "example.ts" }), {
          stopReason: "toolUse",
        });
  };
  faux.setResponses(Array.from({ length: 12 }, () => respond));
  models.setProvider(faux.provider);
  const selected = faux.getModel();
  const review = await openReview({
    database,
    models,
    model: { provider: selected.provider, modelId: selected.id },
    sandbox: async (current) => ({
      beginSubmission: async () => {},
      endSubmission: async () => {},
      exec: async () => ({ stdout: current.headSha, stderr: "", exitCode: 0 }),
      readFile: async () => {
        if (phase === "crash") {
          console.log("CRASH_POINT: durable read intent committed; kill this process now");
          // Keep the child alive while the parent deliberately sends SIGKILL.
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
        return `// revision ${current.headSha}`;
      },
    }),
  });
  if (phase === "crash") {
    await review.selectRevision(revision("A"));
    await review.continueRevision();
    throw new Error("Crash walkthrough did not terminate its child");
  }
  try {
    const before = await review.harness.inspect(context);
    assert.ok(before.tasks.length > 0, "Interrupted work must survive process death");
    await assert.rejects(review.selectRevision(revision("too-early")), /busy/);
    console.log("Recovered pending tasks:", before.tasks.length);
    const id = review.conversation.id;
    const first = await review.continueRevision();
    assert.equal(first?.status, "done");
    const oldEntries = (await review.conversation.context(context)).entries.map(
      (entry) => entry.id,
    );
    // A deliberately unrelated head models amended / force-pushed history, not ancestry.
    await review.selectRevision(revision("rewritten-B"));
    const second = await review.continueRevision();
    assert.equal(second?.status, "done");
    assert.equal(review.conversation.id, id);
    const state = await review.state();
    assert.equal(state?.history[0]?.headSha, "A");
    assert.equal(state?.current?.headSha, "rewritten-B");
    const after = await review.conversation.context(context);
    assert.ok(oldEntries.every((id) => after.entries.some((entry) => entry.id === id)));
    assert.ok(JSON.stringify(after.messages).includes("revision rewritten-B"));
    assert.equal(
      after.messages.filter((message) => message.role === "user").length,
      2,
      "Restart must not duplicate the initial input",
    );
    assert.equal(await review.selectRevision(revision("rewritten-B")), false);
    console.log(JSON.stringify({ conversationId: id, state, transcript: after.messages }, null, 2));
    console.log(
      "PASS: SIGKILL recovery, safe tool replay, same conversation, rewritten revision, preserved transcript, unchanged revision no-op.",
    );
  } finally {
    await review.close();
  }
}

export async function runDemo() {
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR ?? tmpdir(), "better-review-pi-PROTOTYPE-"),
  );
  const database = path.join(directory, "PROTOTYPE.sqlite");
  console.log(`Scratch database (safe to delete): ${database}`);
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", entry, "--demo-phase", "crash", "--db", database],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    output += chunk.toString();
    if (output.includes("CRASH_POINT")) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) =>
      signal === "SIGKILL" ? resolve() : reject(new Error("Child exited before crash point")),
    );
  });
  await demoPhase(database, "recover");
}
