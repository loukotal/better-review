import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Models, type ModelThinkingLevel, type Message } from "@earendil-works/pi-ai";
import {
  Harness,
  configure,
  createRegistry,
  defineDoc,
  type Cursor,
  type EntryRecord,
  type SubmissionRecord,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import type {
  ReviewMessage,
  ReviewPart,
  ReviewSnapshot,
  ReviewSettlement,
} from "@better-review/shared";

import type { PrReviewSession } from "../pr-review-sessions";
import { reviewerExtension } from "./agent";
import type { SubmissionSandbox } from "./microsandbox";

const ReviewDoc = defineDoc<{ session: string; legacySettlements: string }>({
  kind: "review.session",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ session: "", legacySettlements: "[]" }),
});

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parts(message: Extract<Message, { role: "assistant" }>): ReviewPart[] {
  return message.content.flatMap((part): ReviewPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "thinking") return [{ type: "reasoning", text: part.thinking }];
    if (part.type === "toolCall")
      return [
        {
          type: "dynamic-tool",
          toolCallId: part.id,
          toolName: part.name,
          input: part.arguments,
          state: "input-available",
        },
      ];
    return [];
  });
}

export async function openReviewEngine(options: {
  database: string;
  session: PrReviewSession;
  models: Models;
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  legacy?: ReviewSnapshot;
  sandbox: (session: PrReviewSession) => Promise<SubmissionSandbox>;
}) {
  let vm: Promise<SubmissionSandbox> | undefined;
  let session = options.session;
  const releaseSandbox = async () => {
    const active = vm;
    vm = undefined;
    if (active) await (await active).endSubmission();
  };
  const getSandbox = () =>
    (vm ??= options.sandbox(session).then(async (sandbox) => {
      await sandbox.beginSubmission();
      return sandbox;
    }));
  const registry = createRegistry();
  registry.install(reviewerExtension(async () => session, getSandbox));
  const storage = await openNodeSqliteStorage(options.database);
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry,
      settings: { compaction: { enabled: true }, toolExecution: "parallel" },
    },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: options.model, thinkingLevel: options.thinkingLevel },
    init: async (tx, id) => {
      const doc = await tx.doc(ReviewDoc, id);
      doc.session = JSON.stringify(options.session);
      doc.legacySettlements = JSON.stringify(options.legacy?.settlements ?? []);
      for (const message of options.legacy?.messages ?? []) {
        // Old provider-specific tool IDs/signatures are not replayable. Keep their complete
        // UI records and import their observations as historical text into model context.
        const content = message.parts
          .map((part) =>
            part.type === "dynamic-tool"
              ? `[Historical tool ${part.toolName} ${JSON.stringify(part.input)}]\n${part.output ?? part.errorText ?? ""}`
              : part.type === "text"
                ? part.text
                : "",
          )
          .filter(Boolean)
          .join("\n");
        const timestamp = Date.parse(message.metadata.timestamp) || options.session.createdAt;
        const model: Message =
          message.role === "user"
            ? { role: "user", content, timestamp }
            : {
                role: "assistant",
                content: [{ type: "text", text: content }],
                api: "import",
                provider: "import",
                model: "import",
                stopReason: "stop",
                timestamp,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              };
        await tx.appendEntry(id, {
          kind: "review.legacy",
          data: JSON.stringify(message),
          model: [model],
        });
      }
      await tx.appendEntry(id, {
        kind: "review.revision",
        data: { ref: options.session.commitSha ?? options.session.headSha },
      });
    },
  });
  const saved = await harness.snapshot(ReviewDoc, conversation.id, context);
  if (saved?.session) session = JSON.parse(saved.session);

  async function allEntries(): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 500, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return entries.reverse();
  }
  async function allSubmissions(): Promise<SubmissionRecord[]> {
    const records: SubmissionRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions(
        { conversationId: conversation.id },
        500,
        cursor,
        context,
      );
      records.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return records;
  }
  async function snapshot(): Promise<ReviewSnapshot> {
    const [entries, submissions, view] = await Promise.all([
      allEntries(),
      allSubmissions(),
      conversation.watch(context),
    ]);
    const live = view.value.docs["pi.live"] as
      | {
          run?: { taskId: number };
          generation?: { message?: Extract<Message, { role: "assistant" }> };
          tools?: Array<{ callId: string; output?: string }>;
          compactions?: unknown[];
        }
      | undefined;
    await view.stop();
    const messages: ReviewMessage[] = [];
    let ref =
      session.revisionHistory?.[0]?.commitSha ??
      session.revisionHistory?.[0]?.headSha ??
      session.commitSha ??
      session.headSha;
    let submissionId: string | undefined;
    for (const entry of entries) {
      if (entry.kind === "review.revision") {
        ref = (entry.data as { ref: string }).ref;
        continue;
      }
      if (entry.kind === "review.legacy") {
        const message: ReviewMessage = JSON.parse(entry.data as string);
        message.metadata.revision ??= ref;
        messages.push(message);
        continue;
      }
      if (
        entry.kind !== "pi.user" &&
        entry.kind !== "pi.assistant" &&
        entry.kind !== "pi.tool-result"
      )
        continue;
      const submission = submissions.find((record) => record.entry === entry.id);
      if (submission?.type === "input") submissionId = String(submission.id);
      for (const model of entry.model ?? []) {
        if (model.role === "user" || model.role === "assistant") {
          messages.push({
            id: `pi:${entry.id}`,
            role: model.role,
            submissionId,
            metadata: { timestamp: new Date(model.timestamp).toISOString(), revision: ref },
            parts:
              model.role === "user"
                ? [{ type: "text", text: textContent(model.content) }]
                : parts(model),
          });
        } else if (model.role === "toolResult") {
          const tool = messages
            .flatMap((message) => message.parts)
            .findLast(
              (part) => part.type === "dynamic-tool" && part.toolCallId === model.toolCallId,
            );
          if (tool?.type === "dynamic-tool") {
            tool.state = model.isError ? "output-error" : "output-available";
            tool.output = textContent(model.content);
            if (model.isError) tool.errorText = tool.output;
          }
        }
      }
    }
    if (live?.generation?.message)
      messages.push({
        id: `live:${live.run?.taskId}`,
        role: "assistant",
        submissionId,
        metadata: {
          timestamp: new Date(live.generation.message.timestamp).toISOString(),
          revision: ref,
        },
        parts: parts(live.generation.message),
      });
    for (const slot of live?.tools ?? []) {
      const tool = messages
        .flatMap((message) => message.parts)
        .findLast((part) => part.type === "dynamic-tool" && part.toolCallId === slot.callId);
      if (tool?.type === "dynamic-tool" && slot.output && tool.state === "input-available")
        tool.output = slot.output;
    }
    const settlements: ReviewSettlement[] = JSON.parse(saved?.legacySettlements ?? "[]");
    for (const record of submissions) {
      if (record.type !== "input" || (record.status !== "done" && record.status !== "unanswered"))
        continue;
      settlements.push({
        submissionId: String(record.id),
        outcome:
          record.status === "done"
            ? "completed"
            : record.reason === "aborted"
              ? "aborted"
              : "failed",
        ...(record.status === "unanswered"
          ? {
              error:
                typeof record.detail === "string"
                  ? record.detail
                  : JSON.stringify(record.detail ?? record.reason),
            }
          : {}),
      });
    }
    const usage = await harness.usage(context);
    const totals = Object.values(usage.models).reduce(
      (sum, value) => ({
        input: sum.input + value.input,
        output: sum.output + value.output,
        cost: sum.cost + value.cost.total,
      }),
      { input: 0, output: 0, cost: 0 },
    );
    return {
      sessionId: session.id,
      messages,
      settlements,
      running: submissions.some(
        (record) => record.status === "queued" || record.status === "placed",
      ),
      compacting: Boolean(live?.compactions?.length),
      revision: session.commitSha ?? session.headSha,
      usage: totals,
    };
  }
  async function syncSession(next: PrReviewSession) {
    const inspection = await harness.inspect(context);
    if (inspection.tasks.length || inspection.submissions.length)
      throw new Error("Review is running");
    const changed =
      session.headSha !== next.headSha ||
      session.baseSha !== next.baseSha ||
      session.commitSha !== next.commitSha;
    if (changed) await releaseSandbox();
    await conversation.commit(async (tx) => {
      (await tx.doc(ReviewDoc, conversation.id)).session = JSON.stringify(next);
      if (changed)
        await tx.appendEntry(conversation.id, {
          kind: "review.revision",
          data: { ref: next.commitSha ?? next.headSha },
        });
      await configure(tx, conversation.id, { cwd: next.worktreePath });
    }, context);
    session = next;
  }
  async function submit(
    body: string,
    requestId: string,
    model: ModelRef,
    thinkingLevel?: ModelThinkingLevel,
    nextSession?: PrReviewSession,
  ) {
    // requestId is persisted before work starts; retrying an admitted HTTP request is safe.
    const existing = await storage.submissionByRequest(conversation.id, requestId, context);
    if (existing) return { submissionId: String(existing.id) };
    if (nextSession) await syncSession(nextSession);
    await conversation.configure({ model, thinkingLevel }, context);
    const receipt = await conversation.submit(
      { type: "input", content: body, requestId, whenBusy: "reject" },
      context,
    );
    void receipt
      .wait(context)
      .then(() => releaseSandbox())
      .catch((error) => console.error("[Review] Submission interrupted:", error));
    return { submissionId: String(receipt.id) };
  }
  return {
    harness,
    conversation,
    snapshot,
    syncSession,
    submit,
    resume() {
      harness.resume();
      void conversation
        .waitForIdle(context)
        .then(releaseSandbox)
        .catch((error) => console.error("[Review] Recovery failed:", error));
    },
    async abort() {
      await conversation.abort(context);
      await releaseSandbox();
    },
    async compact() {
      return conversation.compact(
        "Retain review findings, resolved issues, revision SHAs, and user decisions.",
        context,
      );
    },
    async close() {
      await harness.close(context);
      await releaseSandbox();
    },
  };
}

export type ReviewEngine = Awaited<ReturnType<typeof openReviewEngine>>;
