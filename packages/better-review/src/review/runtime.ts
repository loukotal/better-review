import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Models } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import lockfile from "proper-lockfile";

import type { ReviewSnapshot } from "@better-review/shared";

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
import { openReviewEngine, type ReviewEngine } from "./engine";
import { readLegacyHistory } from "./legacy-history";
import {
  cleanupOrphanedMicrosandboxes,
  createReviewMicrosandbox,
  type SubmissionSandbox,
} from "./microsandbox";
import { createReviewModels } from "./providers";

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
  admitted?: (id: string, requestId: string, submissionId: string) => Promise<void>;
}) {
  const engines = new Map<string, Promise<ReviewEngine>>();
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
  async function get(id: string) {
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
      const engine = await openReviewEngine({
        database,
        session,
        models: options.models,
        model: options.model(),
        thinkingLevel: getCurrentReviewThinkingLevel(),
        legacy: existsSync(database) ? undefined : options.legacy(id),
        sandbox: async (saved) => {
          await options.ensureCheckout(saved.id);
          return options.sandbox(saved);
        },
      });
      engine.resume();
      const pending = session.automaticReview;
      if (session.runtimeVersion === 3 && pending?.prompt && !pending.submissionId) {
        const receipt = await engine.submit(
          pending.prompt,
          pending.idempotencyKey,
          options.model(),
          getCurrentReviewThinkingLevel(),
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
  async function admit(id: string, body: string, requestId: string) {
    const engine = await get(id);
    const session = await options.readSession(id);
    if (!session) throw new Error("Review session not found");
    await options.ensureCheckout(id);
    return engine.submit(
      body,
      requestId,
      options.model(),
      getCurrentReviewThinkingLevel(),
      session,
    );
  }
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      { error: { message: error.message } },
      /not found/.test(error.message) ? 404 : /running|busy/i.test(error.message) ? 409 : 500,
    ),
  );
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
    return c.json(
      await reviewRevisionLock.run(c.req.param("id"), () =>
        admit(c.req.param("id"), input.body, input.requestId),
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
    const engine = await get(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      const watch = await engine.conversation.watch(context);
      const send = async () =>
        stream.writeSSE({ event: "snapshot", data: JSON.stringify(await engine.snapshot()) });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => undefined);
      }, 15000);
      let finish!: () => void;
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      stream.onAbort(finish);
      try {
        await send();
        watch.start(send);
        await Promise.race([ended, watch.closed]);
      } finally {
        clearInterval(heartbeat);
        await watch.stop();
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
export function admitServerReview(id: string, body: string, requestId: string = randomUUID()) {
  return service().admit(id, body, requestId);
}
export function sendServerReview(id: string, body: string, requestId: string) {
  return reviewRevisionLock.run(id, () => admitServerReview(id, body, requestId));
}
export const reviewConversations = {
  history: readReviewConversationHistory,
  send: sendServerReview,
  admit: admitServerReview,
};
