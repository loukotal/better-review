// THROWAWAY CLI; owns one scratch SQLite database. Never opens Flue's database.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { watchEvents } from "@earendil-works/pi-durable";
import { Effect } from "effect";

import { parseFullDiff } from "../../better-review/src/diff";
import { readFlueReviewSession } from "../../better-review/src/flue-review-sessions";
import {
  createReviewMicrosandbox,
  cleanupOrphanedMicrosandboxes,
} from "../../better-review/src/flue/microsandbox";
import { getFlueProviders } from "../../better-review/src/flue/oauth-auth";
import { GhService } from "../../better-review/src/gh/gh";
import { PrCheckoutService, reviewBaseRef } from "../../better-review/src/pr-checkout";
import { runtime } from "../../better-review/src/runtime";
import { STORE_BASE_DIR } from "../../better-review/src/store";
import { runDemo, demoPhase } from "./demo";
import { openReview, type Revision } from "./review";

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    demo: { type: "boolean" },
    "demo-phase": { type: "string" },
    session: { type: "string" },
    db: { type: "string" },
    model: { type: "string", default: "anthropic/claude-sonnet-4-6" },
    "sandbox-smoke": { type: "boolean" },
  },
});

async function main() {
  if (values.help || (!values.demo && !values["demo-phase"] && !values.session && !values.db)) {
    console.log(`Pi Durable review prototype (pinned 1.0.3)

pnpm prototype:pi --demo
  Deterministic SIGKILL + restart + revision-change walkthrough; no credentials or VM.
pnpm prototype:pi --session <saved-review-id> --model <provider/model>
  Copy a saved revision into a separate durable conversation; use existing credentials.
pnpm prototype:pi --db <PROTOTYPE.sqlite>
  Reopen that conversation, resuming interrupted work.
pnpm prototype:pi --session <saved-review-id> --sandbox-smoke
  Verify the real Microsandbox checkout, read-only mount and disabled network.

Interactive commands: /pull, /status, /history, /exit. Other input continues the review.
Use only one process per database. Ctrl-C closes while preserving pending work.
The active application and its Flue conversation are not modified.`);
    return;
  }
  if (values.demo) return runDemo();
  if (values["demo-phase"]) {
    if (!values.db) throw new Error("--db is required");
    return demoPhase(path.resolve(values.db), values["demo-phase"]);
  }
  const directory = path.join(STORE_BASE_DIR, "pi-durable-PROTOTYPE");
  await mkdir(directory, { recursive: true });
  const session = values.session ? await readFlueReviewSession(values.session) : null;
  if (values.session && !session) throw new Error("Saved review session not found");
  const database = values.db
    ? path.resolve(values.db)
    : path.join(directory, `${session!.id}${values["sandbox-smoke"] ? ".smoke" : ""}.sqlite`);
  const owner = `pi-prototype-${createHash("sha256").update(database).digest("hex").slice(0, 16)}`;
  let sandboxUsed = false;
  const makeSandbox = async (revision: Revision, id: string) => {
    if (!sandboxUsed) {
      // Separate labels/names: only reclaim this prototype database's orphaned VMs.
      await cleanupOrphanedMicrosandboxes(owner);
      sandboxUsed = true;
    }
    return createReviewMicrosandbox(revision, `${owner}:${id}`, owner);
  };
  const slash = values.model!.indexOf("/");
  if (slash < 1) throw new Error("Use --model provider/model-id");
  const models = createModels();
  for (const provider of getFlueProviders()) models.setProvider(provider);
  const review = await openReview({
    database,
    models,
    model: { provider: values.model!.slice(0, slash), modelId: values.model!.slice(slash + 1) },
    sandbox: makeSandbox,
  });
  const watch = await watchEvents(review.harness, review.conversation.id, context);
  watch.start(async (events) => {
    for (const event of events) {
      if (event.type === "message_update") {
        for (const change of event.changes)
          if (change.type === "text_delta") process.stdout.write(change.delta);
      } else if (event.type === "tool_execution_start") {
        console.log(`\n[${event.toolName}] ${JSON.stringify(event.args)}`);
      } else if (event.type === "run_end") console.log("\n[review settled]");
    }
  });
  const status = async () =>
    console.log(
      JSON.stringify(
        {
          database,
          conversationId: review.conversation.id,
          review: await review.state(),
          work: await review.harness.inspect(context),
        },
        null,
        2,
      ),
    );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await watch.stop();
    await review.close();
    if (sandboxUsed) await cleanupOrphanedMicrosandboxes(owner);
    await runtime.dispose();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  try {
    if (!(await review.state())?.current) {
      if (!session) throw new Error("A new database needs --session <saved-review-id>");
      const prepared = await runtime.runPromise(
        Effect.flatMap(PrCheckoutService, (checkout) =>
          checkout.prepare({
            ...session,
            baseRef: session.baseRef ?? "",
            headRef: session.headRef ?? "",
          }),
        ),
      );
      await review.selectRevision({
        owner: session.owner,
        repo: session.repo,
        number: session.number,
        prUrl: session.prUrl,
        headSha: session.headSha,
        baseSha: session.baseSha,
        baseRef: session.baseRef ?? "",
        headRef: session.headRef ?? "",
        files: session.files,
        worktreePath: prepared.worktreePath,
        diffRange:
          session.reviewMode === "commit" && session.commitSha
            ? `${session.commitSha}^..${session.commitSha}`
            : `${reviewBaseRef(session)}...HEAD`,
      });
    }
    await status();
    if (values["sandbox-smoke"]) {
      const current = (await review.state())!.current!;
      const vm = await makeSandbox(current, String(review.conversation.id));
      await vm.beginSubmission();
      const head = await vm.exec("git rev-parse HEAD");
      const failed = await vm.exec("exit 37");
      const mount = await vm.exec("touch .pi-prototype-write-probe");
      const network = await vm.exec("wget -T 3 -q -O /dev/null https://example.com");
      console.log(
        JSON.stringify(
          { head, exitStatusProbe: failed, writeProbe: mount, networkProbe: network },
          null,
          2,
        ),
      );
      await vm.endSubmission();
      if (
        head.exitCode !== 0 ||
        head.stdout.trim() !== current.headSha ||
        failed.exitCode !== 37 ||
        mount.exitCode === 0 ||
        network.exitCode === 0
      )
        throw new Error("Sandbox smoke check failed");
      // Exercise the entire Pi tool path against the real VM without spending model tokens.
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "git rev-parse HEAD" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Sandbox tool finished."),
      ]);
      models.setProvider(faux.provider);
      const model = faux.getModel();
      await review.conversation.configure(
        { model: { provider: model.provider, modelId: model.id } },
        context,
      );
      const receipt = await review.conversation.submit(
        { type: "input", content: "Read the sandbox HEAD." },
        context,
      );
      const result = await receipt.wait(context);
      const transcript = await review.conversation.context(context);
      const tool = transcript.messages.filter((message) => message.role === "toolResult").at(-1);
      if (
        result.status !== "done" ||
        !tool ||
        tool.isError ||
        !JSON.stringify(tool.content).includes(current.headSha)
      )
        throw new Error("Pi-to-Microsandbox tool integration failed");
      console.log(
        "PASS: Pi Durable → real VM → persisted tool result; expected checkout, exit status 37, repository writes rejected, outbound request failed.",
      );
      return;
    }
    review.harness.resume();
    console.log("Resuming saved work…");
    const resumed = await review.continueRevision();
    if (resumed?.status === "unanswered") console.error("Review did not complete:", resumed);
    await review.conversation.waitForIdle(context);
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n/pull · /status · /history · /abort · /exit · or enter a review follow-up");
    for await (const line of lines) {
      try {
        if (line === "/exit") break;
        if (line === "/status") {
          await status();
          continue;
        }
        if (line === "/history") {
          console.log(
            JSON.stringify((await review.conversation.context(context)).messages, null, 2),
          );
          continue;
        }
        if (line === "/abort") {
          await review.conversation.abort(context);
          continue;
        }
        if (line === "/pull") {
          const previous = (await review.state())!.current!;
          const next = await runtime.runPromise(
            Effect.gen(function* () {
              const gh = yield* GhService;
              const checkout = yield* PrCheckoutService;
              const [headSha, baseSha, headRef, baseRef, diff] = yield* Effect.all(
                [
                  gh.getHeadSha(previous.prUrl),
                  gh.getBaseSha(previous.prUrl),
                  gh.getHeadRef(previous.prUrl),
                  gh.getBaseRef(previous.prUrl),
                  gh.getDiff(previous.prUrl),
                ],
                { concurrency: "unbounded" },
              );
              const metadata = {
                ...previous,
                headSha,
                baseSha,
                headRef,
                baseRef,
                files: [...parseFullDiff(diff).keys()],
                reviewMode: "full" as const,
                commitSha: null,
              };
              const prepared = yield* checkout.prepare(metadata);
              return {
                ...metadata,
                worktreePath: prepared.worktreePath,
                diffRange: `${reviewBaseRef(metadata)}...HEAD`,
              };
            }),
          );
          console.log(
            (await review.selectRevision(next)) ? "Pulled latest revision." : "Already current.",
          );
          const result = await review.continueRevision();
          if (result?.status === "unanswered") console.error("Review did not complete:", result);
          await status();
        } else if (line.trim()) {
          const receipt = await review.conversation.submit(
            { type: "input", content: line, whenBusy: "reject" },
            context,
          );
          console.log(await receipt.wait(context));
          await review.releaseSandbox();
        }
      } catch (error) {
        console.error(error);
      }
    }
    lines.close();
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
