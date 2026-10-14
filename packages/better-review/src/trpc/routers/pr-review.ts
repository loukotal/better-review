import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { z } from "zod";

import {
  buildReviewPrompt,
  STRUCTURED_REVIEW_PROMPT,
  conversationIsRunning,
  reviewConversationStatus,
  type AutomaticReviewStatus,
  type StoredSession,
} from "@better-review/shared";

import { parseFullDiff } from "../../diff";
import { GhService } from "../../gh/gh";
import { preparedWorktreePath, PrCheckoutService } from "../../pr-checkout";
import {
  PrReviewSessionService,
  isPrReviewSession,
  type PrReviewSession,
} from "../../pr-review-sessions";
import {
  ReviewLaunchCoordinator,
  PrSessionLock,
  reviewRevisionLock,
} from "../../review-launch-coordinator";
import { reviewConversations } from "../../review/runtime";
import {
  ensureSessionCheckout,
  getSessionCheckoutStatus,
  prepareSessionCheckoutInBackground,
} from "../../session-checkout";
import { PrContextService, parsePrUrl } from "../../state";
import { router, publicProcedure, runEffect } from "../index";

const inputSchema = z.object({
  prUrl: z.string(),
  prNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  files: z.array(z.string()),
  reviewMode: z.enum(["full", "commit"]).optional(),
  commitSha: z.string().optional(),
});
const sessionLock = new PrSessionLock();
const starts = new ReviewLaunchCoordinator<AutomaticReviewStatus>();
const startErrors = new Map<string, string>();
function canonical(value: string) {
  const pr = parsePrUrl(value);
  if (!pr) throw new Error("Invalid PR URL");
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}
const payload = (
  session: PrReviewSession,
  sessions: StoredSession[],
  headSha = session.headSha,
) => ({
  session: {
    id: session.id,
    title: `PR Review: ${session.owner}/${session.repo}#${session.number}`,
  },
  sessions,
  activeSessionId: session.id,
  existing: true,
  headSha,
  sessionHeadSha: session.headSha,
});
const visibleSessions = (sessions: StoredSession[], store: PrReviewSessionService) =>
  Effect.filter(sessions, (item) => store.get(item.id).pipe(Effect.map(isPrReviewSession)));

export function getOrCreateReviewSession(
  input: z.infer<typeof inputSchema>,
  forceNew = false,
  reusePreviousRevision = false,
) {
  return Effect.gen(function* () {
    const gh = yield* GhService;
    const context = yield* PrContextService;
    const store = yield* PrReviewSessionService;
    const prUrl = canonical(input.prUrl);
    const pr = parsePrUrl(prUrl)!;
    const [headSha, baseSha, headRef, baseRef] = yield* Effect.all(
      [gh.getHeadSha(prUrl), gh.getBaseSha(prUrl), gh.getHeadRef(prUrl), gh.getBaseRef(prUrl)],
      { concurrency: "unbounded" },
    );
    const scope = {
      mode: input.reviewMode ?? "full",
      commitSha: input.reviewMode === "commit" ? (input.commitSha ?? null) : null,
    };
    if (scope.mode === "commit" && !scope.commitSha)
      return yield* Effect.fail(new Error("Commit review requires a commit SHA"));
    yield* context.setCurrent(prUrl, input.files, {
      owner: pr.owner,
      repo: pr.repo,
      number: String(pr.number),
    });
    const listed = yield* context.listSessions(prUrl);
    const sessions = yield* visibleSessions(listed.sessions, store);
    const active =
      sessions.find((item) => item.id === listed.activeSessionId && !item.hidden) ??
      sessions.filter((item) => !item.hidden).sort((a, b) => b.createdAt - a.createdAt)[0];
    const old = active ? yield* store.get(active.id) : null;
    if (old) {
      const history = yield* Effect.tryPromise(() => reviewConversations.history(old.id));
      if (history && conversationIsRunning(history)) return payload(old, sessions, headSha);
      if (
        !forceNew &&
        old.reviewMode === scope.mode &&
        old.commitSha === scope.commitSha &&
        (reusePreviousRevision || (old.headSha === headSha && old.baseSha === baseSha))
      ) {
        yield* context.registerSession(old.id, prUrl);
        yield* context.setSessionScope(old.id, scope);
        prepareSessionCheckoutInBackground(old.id);
        return payload(old, sessions, headSha);
      }
    }
    const session = yield* store.create({
      runtimeVersion: 3,
      id: randomUUID(),
      prUrl,
      ...pr,
      baseSha,
      headSha,
      baseRef,
      headRef,
      reviewMode: scope.mode,
      commitSha: scope.commitSha,
      worktreePath: preparedWorktreePath({ ...pr, headSha }),
      files: input.files,
    });
    const data = yield* context.addSession(prUrl, session.id, headSha);
    yield* context.setSessionScope(session.id, scope);
    prepareSessionCheckoutInBackground(session.id);
    return { ...payload(session, yield* visibleSessions(data.sessions, store)), existing: false };
  });
}

async function latestSession(prUrl: string) {
  return runEffect(
    Effect.gen(function* () {
      const context = yield* PrContextService;
      const store = yield* PrReviewSessionService;
      const current = yield* context.listSessions(prUrl);
      const latest = (yield* visibleSessions(current.sessions, store))
        .filter((item) => !item.hidden)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return latest ? yield* store.get(latest.id) : null;
    }),
  );
}
async function automaticStatus(prUrl: string): Promise<AutomaticReviewStatus> {
  if (starts.has(prUrl)) return { state: "starting" };
  const session = await latestSession(prUrl);
  const history = session ? await reviewConversations.history(session.id) : null;
  const state = reviewConversationStatus(history, session?.automaticReview?.submissionId);
  if (state === "running" || state === "completed") startErrors.delete(prUrl);
  const error = startErrors.get(prUrl);
  return {
    state: error ? "failed" : state,
    sessionId: session?.id,
    headSha: session?.headSha,
    ...(error ? { error } : {}),
  };
}

async function select(prUrl: string, id: string) {
  return runEffect(
    Effect.gen(function* () {
      const context = yield* PrContextService;
      const store = yield* PrReviewSessionService;
      const session = yield* store.get(id);
      const list = yield* context.listSessions(prUrl);
      if (
        !isPrReviewSession(session) ||
        canonical(session.prUrl) !== prUrl ||
        !list.sessions.some((item) => item.id === id)
      )
        return yield* Effect.fail(new Error("Review session not found for PR"));
      yield* context.setActiveSession(prUrl, id);
      yield* context.registerSession(id, prUrl);
      yield* context.setSessionScope(id, {
        mode: session.reviewMode,
        commitSha: session.commitSha,
      });
      return payload(session, yield* visibleSessions(list.sessions, store));
    }),
  );
}

export const prReviewRouter = router({
  getOrCreateSession: publicProcedure
    .input(inputSchema)
    .mutation(({ input }) =>
      sessionLock.run(canonical(input.prUrl), () =>
        runEffect(getOrCreateReviewSession(input, false, true)),
      ),
    ),
  create: publicProcedure
    .input(inputSchema)
    .mutation(({ input }) =>
      sessionLock.run(canonical(input.prUrl), () =>
        runEffect(getOrCreateReviewSession(input, true)),
      ),
    ),
  selectSession: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      sessionLock.run(canonical(input.prUrl), () =>
        select(canonical(input.prUrl), input.sessionId),
      ),
    ),
  switch: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      sessionLock.run(canonical(input.prUrl), () =>
        select(canonical(input.prUrl), input.sessionId),
      ),
    ),
  checkoutStatus: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => getSessionCheckoutStatus(input.sessionId)),
  source: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        ref: z.string().optional(),
        path: z
          .string()
          .min(1)
          .refine(
            (value) =>
              !/[\\:?#]/.test(value) &&
              [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
              value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
            "Invalid repository-relative path",
          ),
      }),
    )
    .query(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const store = yield* PrReviewSessionService;
          const session = yield* store.get(input.sessionId);
          if (!isPrReviewSession(session))
            return yield* Effect.fail(new Error("Review session not found"));
          const current = session.commitSha ?? session.headSha;
          const ref = input.ref ?? current;
          if (
            ref !== current &&
            !(session.revisionHistory ?? []).some(
              (revision) => (revision.commitSha ?? revision.headSha) === ref,
            )
          )
            return yield* Effect.fail(new Error("Revision not found in this review"));
          const gh = yield* GhService;
          const content = yield* gh.getFileContent({
            owner: session.owner,
            repo: session.repo,
            path: input.path.split("/").map(encodeURIComponent).join("/"),
            ref,
          });
          if (content === null)
            return yield* Effect.fail(new Error("Source not found at the reviewed revision"));
          return { path: input.path, ref, content };
        }),
      ),
    ),
  pullLatest: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      sessionLock.run(canonical(input.prUrl), () =>
        reviewRevisionLock.run(input.sessionId, async () => {
          await select(canonical(input.prUrl), input.sessionId);
          const history = await reviewConversations.history(input.sessionId);
          if (history && (conversationIsRunning(history) || history.compacting))
            throw new Error("Wait for the current review to finish before pulling changes");
          await ensureSessionCheckout(input.sessionId);
          const result = await runEffect(
            Effect.gen(function* () {
              const store = yield* PrReviewSessionService;
              const context = yield* PrContextService;
              const gh = yield* GhService;
              const checkout = yield* PrCheckoutService;
              const previous = (yield* store.get(input.sessionId))!;
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
              if (headSha !== (yield* gh.getHeadSha(previous.prUrl)))
                return yield* Effect.fail(new Error("The PR changed while fetching. Pull again."));
              if (
                previous.headSha === headSha &&
                previous.baseSha === baseSha &&
                previous.reviewMode === "full"
              )
                return { session: previous, changed: false };
              const files = [...parseFullDiff(diff).keys()];
              const prepared = yield* checkout.prepare({
                ...previous,
                headSha,
                baseSha,
                headRef,
                baseRef,
                files,
                reviewMode: "full",
                commitSha: null,
              });
              const session: PrReviewSession = {
                ...previous,
                ...prepared,
                runtimeVersion: 3,
                headSha,
                baseSha,
                headRef,
                baseRef,
                files,
                reviewMode: "full",
                commitSha: null,
                revisionHistory: [
                  ...(previous.revisionHistory ?? []),
                  {
                    headSha: previous.headSha,
                    baseSha: previous.baseSha,
                    commitSha: previous.commitSha,
                    pulledAt: Date.now(),
                  },
                ],
                automaticReview: {
                  idempotencyKey: randomUUID(),
                  prompt: `Pulled the latest full PR into this review session. Previous revision: ${previous.commitSha ?? previous.headSha}. Current revision: ${headSha} (base ${baseSha}). Continue using our conversation as historical context. Re-read the current checkout; history may have been rewritten. Revalidate earlier findings and distinguish resolved, outstanding, and new issues.`,
                },
              };
              yield* store.save(session);
              yield* context.updateSessionHead(session.prUrl, session.id, headSha);
              yield* context.setSessionScope(session.id, { mode: "full", commitSha: null });
              return { session, changed: true };
            }),
          );
          // A saved continuation without a receipt is retried with the same durable key if
          // the connection was lost between the metadata write and admission.
          const automatic = result.session.automaticReview;
          if (automatic?.prompt && !automatic.submissionId) {
            const receipt = await reviewConversations.admit(
              result.session.id,
              automatic.prompt,
              automatic.idempotencyKey,
            );
            await runEffect(
              Effect.gen(function* () {
                const store = yield* PrReviewSessionService;
                const current = (yield* store.get(result.session.id))!;
                yield* store.save({
                  ...current,
                  automaticReview: { ...automatic, submissionId: receipt.submissionId },
                });
              }),
            );
          }
          return { changed: result.changed, headSha: result.session.headSha };
        }),
      ),
    ),
  startAutomatic: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        simplifiedEnglish: z.boolean().default(false),
        rerun: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) => {
      const prUrl = canonical(input.prUrl);
      return starts.run(prUrl, () =>
        sessionLock.run(prUrl, async (): Promise<AutomaticReviewStatus> => {
          startErrors.delete(prUrl);
          try {
            const pr = parsePrUrl(prUrl)!;
            const data = await runEffect(
              Effect.gen(function* () {
                const gh = yield* GhService;
                const diff = yield* gh.getDiff(prUrl);
                return yield* getOrCreateReviewSession(
                  {
                    prUrl,
                    prNumber: pr.number,
                    repoOwner: pr.owner,
                    repoName: pr.repo,
                    files: [...parseFullDiff(diff).keys()],
                  },
                  input.rerun,
                );
              }),
            );
            const session = await runEffect(
              Effect.flatMap(PrReviewSessionService, (store) => store.get(data.session.id)),
            );
            if (!session) throw new Error("Review session not found");
            const history = await reviewConversations.history(session.id);
            const state = reviewConversationStatus(history, session.automaticReview?.submissionId);
            if (state === "running" || state === "completed")
              return { state, sessionId: session.id, headSha: session.headSha };
            const key =
              state === "failed"
                ? randomUUID()
                : (session.automaticReview?.idempotencyKey ?? randomUUID());
            const prompt = buildReviewPrompt(STRUCTURED_REVIEW_PROMPT, input.simplifiedEnglish);
            const save = (submissionId?: string) =>
              runEffect(
                Effect.gen(function* () {
                  const store = yield* PrReviewSessionService;
                  const current = (yield* store.get(session.id))!;
                  yield* store.save({
                    ...current,
                    automaticReview: { idempotencyKey: key, prompt, submissionId },
                  });
                }),
              );
            await save();
            const receipt = await reviewConversations.send(session.id, prompt, key);
            await save(receipt.submissionId);
            return { state: "running", sessionId: session.id, headSha: session.headSha };
          } catch (error) {
            startErrors.set(
              prUrl,
              error instanceof Error ? error.message : "Could not start review",
            );
            throw error;
          }
        }),
      );
    }),
  automaticStatuses: publicProcedure
    .input(z.object({ prUrls: z.array(z.string()).max(200) }))
    .query(async ({ input }) => {
      const result: Record<string, AutomaticReviewStatus> = {};
      await Promise.all(
        input.prUrls.map(async (url) => {
          try {
            result[url] = await automaticStatus(canonical(url));
          } catch {
            result[url] = { state: "failed", error: "Could not load review status" };
          }
        }),
      );
      return result;
    }),
  hide: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const context = yield* PrContextService;
          const store = yield* PrReviewSessionService;
          const data = yield* context.hideSession(canonical(input.prUrl), input.sessionId);
          const sessions = (yield* visibleSessions(data.sessions, store)).filter(
            (session) => !session.hidden,
          );
          return {
            success: true,
            sessions,
            activeSessionId: sessions.some((session) => session.id === data.activeSessionId)
              ? data.activeSessionId
              : null,
          };
        }),
      ),
    ),
});
