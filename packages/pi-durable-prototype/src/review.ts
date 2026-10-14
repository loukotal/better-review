// THROWAWAY: evaluate Pi Durable's revision and restart semantics before migrating Flue.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Models } from "@earendil-works/pi-ai";
import {
  Harness,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type Revision = {
  owner: string;
  repo: string;
  number: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  worktreePath: string;
  files: string[];
  diffRange: string;
};

export const ReviewState = defineDoc<{
  current: Revision | null;
  history: Revision[];
  pendingPrompt: string | null;
  requestId: string | null;
}>({
  kind: "prototype.review",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ current: null, history: [], pendingPrompt: null, requestId: null }),
});

export type ReviewSandbox = {
  exec(
    command: string,
    options: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  beginSubmission(): Promise<void>;
  endSubmission(): Promise<void>;
};

export async function openReview(options: {
  database: string;
  models: Models;
  model: ModelRef;
  sandbox: (revision: Revision, conversationId: string) => Promise<ReviewSandbox>;
}) {
  let activeSandbox: { path: string; value: Promise<ReviewSandbox> } | undefined;
  const sandbox = async (revision: Revision, conversationId: string) => {
    if (!activeSandbox || activeSandbox.path !== revision.worktreePath) {
      if (activeSandbox) await (await activeSandbox.value).endSubmission();
      activeSandbox = {
        path: revision.worktreePath,
        value: options.sandbox(revision, conversationId).then(async (value) => {
          await value.beginSubmission();
          return value;
        }),
      };
    }
    return activeSandbox.value;
  };
  const registry = createRegistry();
  const releaseSandbox = async () => {
    const current = activeSandbox;
    activeSandbox = undefined;
    if (current) await (await current.value).endSubmission();
  };
  registry.install(
    defineExtension({
      name: "prototype-review",
      sections: [
        section("review", async ({ read, conversationId }) => {
          const state = await read.snapshot(ReviewState, conversationId, context);
          if (!state?.current) return "Wait for a review revision to be selected.";
          const revision = state.current;
          return [
            "You are a code reviewer in a network-disabled, read-only repository sandbox.",
            `PR: ${revision.prUrl}; HEAD: ${revision.headSha}; base: ${revision.baseSha}.`,
            `Review git diff ${revision.diffRange}. Use read and bash to inspect the repository.`,
            `Previous reviewed heads: ${state.history.map((item) => item.headSha).join(", ") || "none"}.`,
            "Keep conversation history as context, but re-read current code. Old tool output and line numbers may be stale. History can be force-pushed.",
            "Report concrete findings with file paths and line numbers. Distinguish resolved, outstanding, and new findings.",
          ].join("\n");
        }),
      ],
      tools: [
        defineTool({
          name: "read",
          description: "Read a UTF-8 file from the reviewed checkout.",
          parameters: Type.Object({ path: Type.String() }),
          replay: "safe",
          execute: async ({ path }, api, ctx) => {
            const state = await api.snapshot(ReviewState, api.conversationId, ctx);
            if (!state?.current) throw new Error("No revision selected");
            const vm = await sandbox(state.current, String(api.conversationId));
            api.output(await vm.readFile(path));
            return {};
          },
        }),
        defineTool({
          name: "bash",
          description:
            "Inspect the reviewed checkout using git, grep, find, and shell commands. Repository is read-only; network is disabled.",
          parameters: Type.Object({ command: Type.String() }),
          // Shell commands can affect scratch state: never silently replay an interrupted command.
          replay: "unsafe",
          execute: async ({ command }, api, ctx) => {
            const state = await api.snapshot(ReviewState, api.conversationId, ctx);
            if (!state?.current) throw new Error("No revision selected");
            const vm = await sandbox(state.current, String(api.conversationId));
            const result = await vm.exec(command, { signal: ctx.abortSignal });
            api.output(result.stdout + result.stderr);
            return { isError: result.exitCode !== 0 };
          },
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(options.database),
    {
      models: options.models,
      registry,
    },
    context,
  );
  const conversation = await harness.root(context, { agent: { model: options.model } });

  const state = () => harness.snapshot(ReviewState, conversation.id, context);
  const assertIdle = async () => {
    const inspection = await harness.inspect(context);
    if (inspection.tasks.length || inspection.submissions.length) {
      throw new Error("Review is busy; resume or abort it before changing revisions.");
    }
  };

  return {
    harness,
    conversation,
    state,
    releaseSandbox,
    async selectRevision(revision: Revision) {
      await assertIdle();
      const previous = await state();
      if (previous?.pendingPrompt)
        throw new Error("Continue the pending revision before pulling again.");
      if (previous?.current?.prUrl && previous.current.prUrl !== revision.prUrl)
        throw new Error("This database belongs to a different PR");
      if (
        previous?.current?.headSha === revision.headSha &&
        previous.current.baseSha === revision.baseSha &&
        previous.current.diffRange === revision.diffRange
      )
        return false;
      // Atomic revision + transcript event + durable continuation intent. A crash between
      // this commit and submit is repaired by continueRevision() on the next launch.
      await conversation.commit(async (tx) => {
        const document = await tx.doc(ReviewState, conversation.id);
        const old = document.current;
        if (old) document.history.push(old);
        document.current = revision;
        document.pendingPrompt = old
          ? `Continue our PR review after pulling from ${old.headSha} to ${revision.headSha}. Revalidate earlier findings against the new full diff.`
          : `Review PR ${revision.prUrl} at ${revision.headSha}.`;
        const entry = await tx.appendEntry(conversation.id, {
          kind: "prototype.revision",
          data: {
            previous: old?.headSha ?? null,
            current: revision.headSha,
            base: revision.baseSha,
          },
        });
        document.requestId = `revision:${entry.id}`;
        await configure(tx, conversation.id, { cwd: revision.worktreePath });
      }, context);
      return true;
    },
    async continueRevision() {
      const pending = await state();
      if (!pending?.pendingPrompt || !pending.requestId) return;
      const submission = await conversation.submit(
        {
          type: "input",
          content: pending.pendingPrompt,
          requestId: pending.requestId,
          whenBusy: "reject",
        },
        context,
      );
      const result = await submission.wait(context);
      await releaseSandbox();
      // Retain failed submissions for inspection; an explicit new message can retry review.
      await conversation.commit(async (tx) => {
        const document = await tx.doc(ReviewState, conversation.id);
        document.pendingPrompt = null;
      }, context);
      return result;
    },
    async close() {
      await harness.close(context);
      await releaseSandbox();
    },
  };
}
