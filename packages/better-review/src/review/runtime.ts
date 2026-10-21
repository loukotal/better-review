import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { type Models } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import lockfile from "proper-lockfile";

import type { ReviewSnapshot, ReviewModelIntent } from "@better-review/shared";

import { getCurrentReviewModel, getCurrentReviewThinkingLevel } from "../model-selection";
import {
  readPrReviewSession,
  PrReviewSessionService,
  PR_REVIEW_SESSIONS_NAMESPACE,
  type PrReviewSession,
} from "../pr-review-sessions";
import { reviewRevisionLock } from "../review-launch-coordinator";
import { runtime as appRuntime } from "../runtime";
import { ensureSessionCheckout } from "../session-checkout";
import { STORE_BASE_DIR } from "../store";
import { ReviewAdmissionConflict } from "./admission-intent";
import { openReviewEngine, type ReviewEngine } from "./engine";
import { readLegacyHistory } from "./legacy-history";
import { reviewMetrics } from "./metrics";
import {
  cleanupOrphanedMicrosandboxes,
  createReviewMicrosandbox,
  type SubmissionSandbox,
} from "./microsandbox";
import { reviewModelIntentSchema, resolveReviewModelIntent } from "./model-intent";
import { createReviewModels } from "./providers";
import { reviewStream, encodeReviewFrame, type ReviewFrame } from "./stream";

export const REVIEW_DATABASE_DIR =
  process.env.BETTER_REVIEW_DATABASE_DIR ?? path.join(STORE_BASE_DIR, "pi-reviews");

export function createReviewRuntime(options: {
  directory: string;
  models: Models;
  readSession: (id: string) => Promise<PrReviewSession | null>;
  ensureCheckout: (id: string) => Promise<void>;
  sandbox: (session: PrReviewSession) => Promise<SubmissionSandbox>;
  legacy: (id: string) => ReviewSnapshot;
  model: () => { provider: string; modelId: string };
  resolveModelIntent?: typeof resolveReviewModelIntent;
  admitted?: (id: string, requestId: string, submissionId: string) => Promise<void>;
}) {
  const engines = new Map<string, Promise<ReviewEngine>>();
  const streams = new Map<string, ReturnType<typeof reviewStream>>();
  const streamClosers = new Set<() => void>();
  let ownership: Promise<() => Promise<void>> | undefined;
  let closing = false;
  const claim = () => {
    if (ownership) return ownership;
    const acquiring = (async () => {
      await mkdir(options.directory, { recursive: true });
      return lockfile.lock(options.directory, {
        realpath: false,
        stale: 10000,
        update: 2000,
        retries: { retries: 20, minTimeout: 500, maxTimeout: 1000 },
      });
    })();
    ownership = acquiring;
    acquiring.catch(() => {
      if (ownership === acquiring) ownership = undefined;
    });
    return acquiring;
  };
  async function get(id: string, initial?: ReturnType<typeof resolveReviewModelIntent>) {
    if (closing) throw new Error("Review runtime is shutting down");
    if (!/^[A-Za-z0-9._:-]+$/.test(id) || id.includes(".."))
      throw new Error("Invalid review session ID");
    const existing = engines.get(id);
    if (existing) return existing;
    const promise = (async () => {
      await claim();
      const session = await options.readSession(id);
      if (!session) throw new Error("Review session not found");
      await mkdir(options.directory, { recursive: true });
      const database = path.join(options.directory, `${id}.sqlite`);
      const selected =
        initial ??
        (session.automaticReview?.model
          ? (options.resolveModelIntent ?? resolveReviewModelIntent)(session.automaticReview.model)
          : { model: options.model(), thinkingLevel: getCurrentReviewThinkingLevel() });
      const engine = await openReviewEngine({
        database,
        session,
        models: options.models,
        model: selected.model,
        thinkingLevel: selected.thinkingLevel,
        legacy: existsSync(database) ? undefined : options.legacy(id),
        sandbox: async (saved) => {
          await options.ensureCheckout(saved.id);
          return options.sandbox(saved);
        },
      });
      engine.resume();
      const pending = session.automaticReview;
      if (session.runtimeVersion === 3 && pending?.prompt && !pending.submissionId) {
        const selected = pending.model
          ? (options.resolveModelIntent ?? resolveReviewModelIntent)(pending.model)
          : { model: options.model(), thinkingLevel: getCurrentReviewThinkingLevel() };
        const receipt = await engine.submit(
          pending.prompt,
          pending.idempotencyKey,
          selected.model,
          selected.thinkingLevel,
          session,
        );
        await options.admitted?.(id, pending.idempotencyKey, receipt.submissionId);
      }
      return engine;
    })();
    engines.set(id, promise);
    promise.catch(() => {
      if (engines.get(id) === promise) engines.delete(id);
    });
    return promise;
  }
  async function admit(id: string, body: string, requestId: string, intent?: ReviewModelIntent) {
    // Capture server-authoritative intent before checkout/session IO can yield to a model change.
    const { model, thinkingLevel } = intent
      ? (options.resolveModelIntent ?? resolveReviewModelIntent)(intent)
      : { model: options.model(), thinkingLevel: getCurrentReviewThinkingLevel() };
    const engine = await get(id, { model, thinkingLevel });
    const session = await options.readSession(id);
    if (!session) throw new Error("Review session not found");
    const capturedSession = structuredClone(session);
    await options.ensureCheckout(id);
    return engine.submit(body, requestId, model, thinkingLevel, capturedSession);
  }
  const app = new Hono();
  app.get("/metrics", (c) => c.json(reviewMetrics()));
  app.onError((error, c) => {
    if (error instanceof ReviewAdmissionConflict)
      return c.json({ error: { code: error.code, message: error.message } }, 409);
    return c.json(
      { error: { message: error.message } },
      /not found/.test(error.message) ? 404 : /running|busy/i.test(error.message) ? 409 : 500,
    );
  });
  app.get("/sessions/:id", async (c) => c.json(await (await get(c.req.param("id"))).snapshot()));
  app.post("/sessions/:id", async (c) => {
    const input = await c.req.json();
    if (
      typeof input.body !== "string" ||
      !input.body.trim() ||
      typeof input.requestId !== "string" ||
      !input.requestId
    )
      return c.json({ error: { message: "body and requestId are required" } }, 400);
    const model =
      input.model === undefined ? undefined : reviewModelIntentSchema.safeParse(input.model);
    if (model && !model.success)
      return c.json(
        { error: { message: "Invalid review model intent. Choose a model again." } },
        400,
      );
    return c.json(
      await reviewRevisionLock.run(c.req.param("id"), () =>
        admit(
          c.req.param("id"),
          input.body,
          input.requestId,
          model?.success ? model.data : undefined,
        ),
      ),
    );
  });
  app.post("/sessions/:id/abort", async (c) => {
    await reviewRevisionLock.run(c.req.param("id"), async () =>
      (await get(c.req.param("id"))).abort(),
    );
    return c.json({ success: true });
  });
  app.post("/sessions/:id/compact", async (c) => {
    await reviewRevisionLock.run(c.req.param("id"), async () =>
      (await get(c.req.param("id"))).compact(),
    );
    return c.json({ success: true });
  });
  app.get("/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const engine = await get(id);
    let channel = streams.get(id);
    if (!channel) {
      channel = reviewStream(engine);
      streams.set(id, channel);
    }
    return streamSSE(c, async (stream) => {
      let latest: ReviewFrame | undefined;
      let lastVersion: number | undefined;
      let sending = false;
      let stopped = false;
      let finish!: () => void;
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const send = async () => {
        if (sending || stopped) return;
        sending = true;
        try {
          while (latest && !stopped) {
            const frame = latest;
            latest = undefined;
            if (frame.version === lastVersion) continue;
            await stream.writeSSE(encodeReviewFrame(frame, lastVersion));
            lastVersion = frame.version;
          }
        } catch {
          finish();
        } finally {
          sending = false;
        }
      };
      const unsubscribe = channel.subscribe((frame) => {
        latest = frame;
        void send();
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => undefined);
      }, 15000);
      streamClosers.add(finish);
      stream.onAbort(finish);
      try {
        latest = await channel.current();
        await send();
        await ended;
      } finally {
        stopped = true;
        unsubscribe();
        streamClosers.delete(finish);
        clearInterval(heartbeat);
      }
    });
  });
  return {
    app,
    get,
    admit,
    claim,
    async resume() {
      await mkdir(options.directory, { recursive: true });
      for (const file of await readdir(options.directory)) {
        if (file.endsWith(".sqlite"))
          await get(file.slice(0, -7)).catch((error) =>
            console.error(`[Review] Could not resume ${file}:`, error),
          );
      }
    },
    async close() {
      for (const finish of streamClosers) finish();
      for (const channel of streams.values()) channel.close();
      streams.clear();
      if (closing) return;
      closing = true;
      try {
        await Promise.all([...engines.values()].map(async (engine) => (await engine).close()));
      } finally {
        engines.clear();
        if (ownership) await (await ownership)();
      }
    },
  };
}

let active: ReturnType<typeof createReviewRuntime> | undefined;
function service() {
  if (!active) {
    const models = createReviewModels();
    active = createReviewRuntime({
      directory: REVIEW_DATABASE_DIR,
      models,
      readSession: readPrReviewSession,
      ensureCheckout: ensureSessionCheckout,
      sandbox: (session) => createReviewMicrosandbox(session, session.id),
      legacy: readLegacyHistory,
      model: () => {
        const value = getCurrentReviewModel();
        const slash = value.indexOf("/");
        return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
      },
      admitted: (id, key, submissionId) =>
        appRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* PrReviewSessionService;
            const session = yield* store.get(id);
            if (session?.automaticReview?.idempotencyKey === key)
              yield* store.save({
                ...session,
                automaticReview: { ...session.automaticReview, submissionId },
              });
          }),
        ),
    });
  }
  return active;
}
export async function startReviewRuntime() {
  await service().claim();
  await cleanupOrphanedMicrosandboxes();
  await service().resume();
  // Recover admission intents even when the crash happened before the Pi database existed.
  const directory = path.join(STORE_BASE_DIR, PR_REVIEW_SESSIONS_NAMESPACE);
  for (const file of await readdir(directory).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const session = await readPrReviewSession(file.slice(0, -5));
    if (
      session?.runtimeVersion === 3 &&
      session.automaticReview?.prompt &&
      !session.automaticReview.submissionId
    )
      await service().get(session.id);
  }
}
export async function stopReviewRuntime() {
  const previous = active;
  await previous?.close();
  await cleanupOrphanedMicrosandboxes();
  if (active === previous) active = undefined;
}
export function createReviewApp() {
  return service().app;
}
export async function readReviewConversationHistory(id: string) {
  if (!(await readPrReviewSession(id))) return null;
  return (await service().get(id)).snapshot();
}
/** Caller holds the revision lock when replacing a checkout and admitting its continuation. */
export function admitServerReview(
  id: string,
  body: string,
  requestId: string = randomUUID(),
  model?: ReviewModelIntent,
) {
  return service().admit(id, body, requestId, model);
}
export function sendServerReview(
  id: string,
  body: string,
  requestId: string,
  model?: ReviewModelIntent,
) {
  return reviewRevisionLock.run(id, () => admitServerReview(id, body, requestId, model));
}
export const reviewConversations = {
  history: readReviewConversationHistory,
  send: sendServerReview,
  admit: admitServerReview,
};
