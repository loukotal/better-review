import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Models, type ModelThinkingLevel, type Message } from "@earendil-works/pi-ai";
import {
  Harness,
  AgentDoc,
  configure,
  createRegistry,
  defineDoc,
  type Cursor,
  type EntryRecord,
  type SubmissionRecord,
  type ModelRef,
  type CommitPublication,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import type { ReviewMessage, ReviewSnapshot, ReviewSettlement } from "@better-review/shared";

import type { PrReviewSession } from "../pr-review-sessions";
import {
  AdmissionIntentDoc,
  admissionFingerprint,
  ReviewAdmissionConflict,
} from "./admission-intent";
import { reviewerExtension } from "./agent";
import { measure, startMeasurement } from "./metrics";
import type { SubmissionSandbox } from "./microsandbox";
import { assistantParts as parts, TranscriptProjection } from "./projection";

const ReviewDoc = defineDoc<{ session: string; legacySettlements: string }>({
  kind: "review.session",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ session: "", legacySettlements: "[]" }),
});

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
  let cleanup: Promise<void> = Promise.resolve();
  let runGeneration = 0;
  let observingRun = false;
  let lastObservedSubmission = 0;
  let closed = false;
  let admissions: Promise<void> = Promise.resolve();
  let session = options.session;
  const releaseSandbox = async () => {
    const active = vm;
    vm = undefined;
    if (active)
      cleanup = cleanup.then(async () => {
        await (await active).endSubmission();
      });
    await cleanup;
  };
  const getSandbox = () =>
    (vm ??= cleanup
      .then(() => options.sandbox(session))
      .then(async (sandbox) => {
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
  const projection = new TranscriptProjection(
    session.revisionHistory?.[0]?.commitSha ??
      session.revisionHistory?.[0]?.headSha ??
      session.commitSha ??
      session.headSha,
  );
  const submissionCache = new Map<number, SubmissionRecord>();
  let docs: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  const pendingCommits: CommitPublication[] = [];
  let hydrated = false;
  let lastSnapshot: ReviewSnapshot | undefined;
  function adopt(publication: CommitPublication) {
    let changed = false;
    for (const change of publication.changes) {
      if (change.type === "entry" && change.value.conversationId === conversation.id) {
        // Only newly observed commits count. Hydration/reopening and document streaming do not
        // replay usage into process-local metrics. This is not durable provider billing.
        if (hydrated && !projection.hasEntry(change.value.id)) {
          for (const message of change.value.model ?? []) {
            if (change.value.kind === "pi.assistant" && message.role === "assistant") {
              measure("review.model.round_trips", 1);
              measure("review.tokens.input", message.usage.input);
              measure("review.tokens.output", message.usage.output);
              measure("review.tokens.cache_read", message.usage.cacheRead);
              measure("review.tokens.cache_write", message.usage.cacheWrite);
              measure("review.tokens.total", message.usage.totalTokens);
            } else if (change.value.kind === "pi.tool-result" && message.role === "toolResult") {
              measure("review.tool.round_trips", 1);
            }
          }
        }
        projection.addEntry(change.value);
        changed = true;
      } else if (change.type === "submission" && change.value.conversationId === conversation.id) {
        submissionCache.set(change.value.id, change.value);
        projection.addSubmission(change.value);
        changed = true;
      } else if (change.type === "document" && change.conversationId === conversation.id) {
        docs[change.record.kind] = change.value;
        // Commit listeners can request a snapshot before syncSession's await resumes.
        // Adopt the session alongside its revision marker, before notifying them.
        if (change.record.kind === "review.session" && typeof change.value?.session === "string")
          session = JSON.parse(change.value.session);
        changed = true;
      }
    }
    if (changed) {
      lastSnapshot = undefined;
      queueMicrotask(() => {
        for (const notify of listeners) notify();
      });
    }
  }
  const stopCommits = harness.subscribeCommits((publication) => {
    if (!hydrated) pendingCommits.push(publication);
    else adopt(publication);
  });
  const hydrateDone = startMeasurement("snapshot.hydrate");
  const [initialEntries, initialSubmissions, initialView] = await Promise.all([
    allEntries(),
    allSubmissions(),
    conversation.watch(context),
  ]);
  for (const entry of initialEntries) projection.addEntry(entry);
  for (const record of initialSubmissions) {
    submissionCache.set(record.id, record);
    projection.addSubmission(record);
  }
  docs = { ...initialView.value.docs };
  await initialView.stop();
  for (const publication of pendingCommits) adopt(publication);
  pendingCommits.length = 0;
  hydrated = true;
  hydrateDone();
  measure("snapshot.hydrated.entries", projection.entryCount);

  async function snapshot(): Promise<ReviewSnapshot> {
    if (lastSnapshot) return lastSnapshot;
    const done = startMeasurement("snapshot.project");
    const submissions = [...submissionCache.values()].sort((a, b) => a.id - b.id);
    const live = docs["pi.live"] as
      | {
          run?: { taskId: number };
          generation?: { message?: Extract<Message, { role: "assistant" }> };
          tools?: Array<{ callId: string; output?: string }>;
          compactions?: unknown[];
        }
      | undefined;
    const { messages: history, ref, submissionId } = projection.history();
    const messages: ReviewMessage[] = [...history];
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
      const index = messages.findLastIndex((message) =>
        message.parts.some(
          (part) =>
            part.type === "dynamic-tool" &&
            part.toolCallId === slot.callId &&
            part.state === "input-available",
        ),
      );
      if (index >= 0 && slot.output)
        messages[index] = {
          ...messages[index]!,
          parts: messages[index]!.parts.map((part) =>
            part.type === "dynamic-tool" && part.toolCallId === slot.callId
              ? { ...part, output: slot.output }
              : part,
          ),
        };
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
    const usage = (docs["pi.usage"] ?? { models: {} }) as {
      models: Record<string, { input: number; output: number; cost: { total: number } }>;
    };
    const totals = Object.values(usage.models).reduce(
      (sum, value) => ({
        input: sum.input + value.input,
        output: sum.output + value.output,
        cost: sum.cost + value.cost.total,
      }),
      { input: 0, output: 0, cost: 0 },
    );
    lastSnapshot = {
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
    done();
    return lastSnapshot;
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
  async function legacyIntent(record: SubmissionRecord) {
    if (record.type !== "input" || record.entry === undefined) return undefined;
    try {
      const [storedEntry, agent, review] = await Promise.all([
        storage.entry(conversation.id, record.entry, context),
        harness.snapshotAsOf(AgentDoc, conversation.id, record.entry, context),
        harness.snapshotAsOf(ReviewDoc, conversation.id, record.entry, context),
      ]);
      const messages = storedEntry?.entry.model;
      const original = messages?.length === 1 ? messages[0] : undefined;
      if (
        storedEntry?.entry.kind !== "pi.user" ||
        original?.role !== "user" ||
        typeof original.content !== "string" ||
        !agent?.model ||
        !review?.session
      )
        return undefined;
      const saved = JSON.parse(review.session) as PrReviewSession;
      if (
        saved.id !== options.session.id ||
        ![2, 3].includes(saved.runtimeVersion) ||
        typeof saved.headSha !== "string" ||
        typeof saved.baseSha !== "string" ||
        !Array.isArray(saved.files)
      )
        return undefined;
      return {
        id: record.id,
        fingerprint: admissionFingerprint(
          original.content,
          agent.model,
          agent.thinkingLevel ?? "off",
          saved,
        ),
      };
    } catch {
      // Missing/unreadable historical evidence is not permission to guess from current settings.
      return undefined;
    }
  }
  async function submit(
    body: string,
    requestId: string,
    model: ModelRef,
    thinkingLevel?: ModelThinkingLevel,
    nextSession?: PrReviewSession,
  ) {
    // Capture before the first await, including caller-owned objects. Omitted thinking
    // means Pi's default "off", never whatever a previous prompt configured.
    const capturedSession = structuredClone(nextSession ?? session);
    const capturedModel = { provider: model.provider, modelId: model.modelId };
    const capturedThinking = thinkingLevel ?? "off";
    const fingerprint = admissionFingerprint(
      body,
      capturedModel,
      capturedThinking,
      capturedSession,
    );
    const attempt = admissions.then(async () => {
      const earlier = await storage.submissionByRequest(conversation.id, requestId, context);
      const proof =
        earlier &&
        !(await harness.snapshot(AdmissionIntentDoc, conversation.id, requestId, context))
          ?.fingerprint
          ? await legacyIntent(earlier)
          : undefined;
      // Claim the key durably before configuration/admission. A crash between these
      // commits permits only the identical intent to finish admission on retry.
      const existing = await conversation.commit(async (tx) => {
        const previous = await tx.submissionByRequest(conversation.id, requestId);
        const intent = await tx.doc(AdmissionIntentDoc, conversation.id, requestId, null);
        if (intent.fingerprint && intent.fingerprint !== fingerprint)
          throw new ReviewAdmissionConflict("intent_changed");
        // Only the original user entry and historical documents at its commit can
        // verify a legacy claim; current agent/session settings cannot.
        if (previous && !intent.fingerprint) {
          if (!proof || proof.id !== previous.id)
            throw new ReviewAdmissionConflict("legacy_unverifiable");
          if (proof.fingerprint !== fingerprint)
            throw new ReviewAdmissionConflict("intent_changed");
        }
        if (previous && previous.type !== "input")
          throw new ReviewAdmissionConflict("intent_changed");
        intent.fingerprint = fingerprint;
        return previous;
      }, context);
      if (existing) return { submissionId: String(existing.id) };
      await syncSession(capturedSession);
      await releaseSandbox();
      await conversation.configure(
        { model: capturedModel, thinkingLevel: capturedThinking },
        context,
      );
      const durationDone = startMeasurement("review.duration");
      const receipt = await conversation.submit(
        { type: "input", content: body, requestId, whenBusy: "reject" },
        context,
      );
      // The durable layer may return an already-admitted receipt after interrupted
      // admission. Observe that receipt only once too.
      // Submission IDs increase monotonically, so this needs no growing request-ID set.
      if (receipt.id <= lastObservedSubmission) return { submissionId: String(receipt.id) };
      lastObservedSubmission = receipt.id;
      const generation = ++runGeneration;
      observingRun = true;
      void receipt
        .wait(context)
        .then(() => {
          if (!closed) durationDone();
          if (generation === runGeneration) observingRun = false;
          if (generation === runGeneration) return releaseSandbox();
        })
        .catch(() => {
          if (!closed) durationDone();
          if (generation === runGeneration) observingRun = false;
          console.error("[Review] Submission interrupted");
        });
      return { submissionId: String(receipt.id) };
    });
    // Serialize configuration and admission, but never wait for model execution.
    // Rejections do not poison subsequent identical retries or other request IDs.
    admissions = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }
  return {
    harness,
    conversation,
    snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    syncSession,
    submit,
    resume() {
      const generation = ++runGeneration;
      // A resumed interval starts now, not at the persisted submission timestamp. Never
      // report pre-crash elapsed time, idle opens, or duplicate resume calls as new reviews.
      const durationDone =
        !observingRun &&
        [...submissionCache.values()].some(
          (record) =>
            record.type === "input" && (record.status === "queued" || record.status === "placed"),
        )
          ? startMeasurement("review.resume.duration")
          : undefined;
      if (durationDone) observingRun = true;
      harness.resume();
      void conversation
        .waitForIdle(context)
        .then(() => {
          if (!closed) durationDone?.();
          if (generation === runGeneration) observingRun = false;
          if (generation === runGeneration) return releaseSandbox();
        })
        .catch(() => {
          if (!closed) durationDone?.();
          if (generation === runGeneration) observingRun = false;
          console.error("[Review] Recovery failed");
        });
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
      closed = true;
      stopCommits();
      listeners.clear();
      await harness.close(context);
      await releaseSandbox();
    },
  };
}

export type ReviewEngine = Awaited<ReturnType<typeof openReviewEngine>>;
