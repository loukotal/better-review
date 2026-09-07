import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { z } from "zod";

import {
  buildReviewPrompt,
  STRUCTURED_REVIEW_PROMPT,
  reviewConversationStatus,
  conversationIsRunning,
  type AutomaticReviewStatus,
} from "@better-review/shared";

import { parseFullDiff } from "../../diff";
import {
  FlueReviewSessionService,
  isFlueV2ReviewSession,
  readFlueReviewSession,
  type FlueReviewSession,
} from "../../flue-review-sessions";
import { readFlueConversationHistory, sendServerReview } from "../../flue/runtime";
import { GhService } from "../../gh/gh";
import { PrCheckoutService } from "../../pr-checkout";
import { ReviewLaunchCoordinator, PrSessionLock } from "../../review-launch-coordinator";
import { PrContextService, parsePrUrl, type SessionReviewScope } from "../../state";
import { router, publicProcedure, runEffect } from "../index";

const sessionInput = z.object({
  prUrl: z.string(),
  prNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  files: z.array(z.string()),
  reviewMode: z.enum(["full", "commit"]).optional(),
  commitSha: z.string().optional(),
});

function makeReviewScope(input: z.infer<typeof sessionInput>): SessionReviewScope {
  return {
    mode: input.reviewMode === "commit" ? "commit" : "full",
    commitSha: input.reviewMode === "commit" ? (input.commitSha ?? null) : null,
  };
}

function makeSessionTitle(input: z.infer<typeof sessionInput>): string {
  return `PR Review: ${input.repoOwner}/${input.repoName}#${input.prNumber}`;
}

const sessionPayload = (
  session: FlueReviewSession,
  sessions: Array<{ id: string; headSha: string; createdAt: number; hidden: boolean }>,
  activeSessionId: string | null,
  existing: boolean,
) => ({
  session: {
    id: session.id,
    title: makeSessionTitle({
      prUrl: session.prUrl,
      prNumber: session.number,
      repoOwner: session.owner,
      repoName: session.repo,
      files: session.files,
      reviewMode: session.reviewMode,
      commitSha: session.commitSha ?? undefined,
    }),
  },
  sessions,
  activeSessionId,
  existing,
  headSha: session.headSha,
  sessionHeadSha: session.headSha,
  agentName: "pr-reviewer" as const,
});

type SessionListItem = { id: string; headSha: string; createdAt: number; hidden: boolean };

const visibleV2Sessions = (sessions: SessionListItem[], flueSessions: FlueReviewSessionService) =>
  Effect.filter(sessions, (session) =>
    flueSessions.get(session.id).pipe(Effect.map(isFlueV2ReviewSession)),
  );

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls: Array<{
    id: string;
    tool: string;
    callId: string;
    status: "completed" | "error";
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
  }>;
  isStreaming: false;
  timestamp: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function conversationHistoryToChatMessages(data: unknown): ChatMessage[] {
  if (!isRecord(data) || !Array.isArray(data.messages)) return [];

  return data.messages.flatMap((value): ChatMessage[] => {
    if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return [];

    const parts = Array.isArray(value.parts) ? value.parts.filter(isRecord) : [];
    const content = parts
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
    const reasoning = parts
      .map((part) => (part.type === "reasoning" && typeof part.text === "string" ? part.text : ""))
      .join("");
    const toolCalls: ChatMessage["toolCalls"] = parts.flatMap((part) => {
      if (
        part.type !== "dynamic-tool" ||
        typeof part.toolCallId !== "string" ||
        typeof part.toolName !== "string"
      ) {
        return [];
      }

      const isError = part.state === "output-error";
      return [
        {
          id: part.toolCallId,
          callId: part.toolCallId,
          tool: part.toolName,
          status: isError ? ("error" as const) : ("completed" as const),
          input: isRecord(part.input) ? part.input : {},
          title: part.toolName,
          ...(part.state === "output-available" ? { output: stringifyUnknown(part.output) } : {}),
          ...(isError && typeof part.errorText === "string" ? { error: part.errorText } : {}),
        },
      ];
    });
    const metadata = isRecord(value.metadata) ? value.metadata : null;
    const timestampValue =
      metadata && typeof metadata.timestamp === "string"
        ? Date.parse(metadata.timestamp)
        : Number.NaN;

    return [
      {
        id: typeof value.id === "string" ? value.id : randomUUID(),
        role: value.role,
        content,
        reasoning: reasoning || undefined,
        toolCalls,
        isStreaming: false,
        timestamp: Number.isNaN(timestampValue) ? Date.now() : timestampValue,
      },
    ];
  });
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getOrCreateReviewSession(input: z.infer<typeof sessionInput>, forceNew = false) {
  return Effect.gen(function* () {
    const gh = yield* GhService;
    const prContext = yield* PrContextService;
    const flueSessions = yield* FlueReviewSessionService;
    const checkout = yield* PrCheckoutService;

    const pr = parsePrUrl(input.prUrl);
    if (!pr) {
      return yield* Effect.fail(new Error(`Invalid PR URL: ${input.prUrl}`));
    }

    const reviewScope = makeReviewScope(input);

    const [headSha, baseSha, headRef, baseRef] = yield* Effect.all(
      [
        gh.getHeadSha(input.prUrl),
        gh.getBaseSha(input.prUrl),
        gh.getHeadRef(input.prUrl),
        gh.getBaseRef(input.prUrl),
        prContext.setCurrent(input.prUrl, input.files, {
          owner: input.repoOwner,
          repo: input.repoName,
          number: String(input.prNumber),
        }),
      ],
      { concurrency: "unbounded" },
    );

    const current = yield* prContext.listSessions(input.prUrl);
    const latest = (yield* visibleV2Sessions(current.sessions, flueSessions)).sort(
      (a, b) => b.createdAt - a.createdAt,
    )[0];
    if (latest) current.activeSessionId = latest.id;
    if (current.activeSessionId) {
      const active = current.sessions.find((session) => session.id === current.activeSessionId);
      const flueSession = yield* flueSessions.get(current.activeSessionId);
      if (active && isFlueV2ReviewSession(flueSession)) {
        // A viewer joining running work must not reset its checkout or scope.
        const history = yield* Effect.tryPromise(() => readFlueConversationHistory(flueSession.id));
        if (
          (history && conversationIsRunning(history)) ||
          reviewConversationStatus(history, flueSession.automaticReview?.submissionId) === "running"
        ) {
          const sessions = yield* visibleV2Sessions(current.sessions, flueSessions);
          return sessionPayload(flueSession, sessions, flueSession.id, true);
        }
        if (
          !forceNew &&
          flueSession.headSha === headSha &&
          flueSession.baseSha === baseSha &&
          flueSession.reviewMode === reviewScope.mode &&
          flueSession.commitSha === reviewScope.commitSha
        ) {
          const prepared = yield* checkout.prepare({
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            prUrl: input.prUrl,
            baseSha,
            headSha,
            baseRef,
            headRef,
            reviewMode: reviewScope.mode,
            commitSha: reviewScope.commitSha,
            files: input.files,
          });
          const updatedSession: FlueReviewSession = {
            ...flueSession,
            baseSha,
            headSha,
            baseRef,
            headRef,
            reviewMode: reviewScope.mode,
            commitSha: reviewScope.commitSha,
            worktreePath: prepared.worktreePath,
            repoAccess: prepared.repoAccess,
            files: input.files,
          };
          yield* flueSessions.save(updatedSession);
          yield* prContext.registerSession(flueSession.id, input.prUrl);
          yield* prContext.setSessionScope(flueSession.id, reviewScope);
          const sessions = yield* visibleV2Sessions(current.sessions, flueSessions);
          return sessionPayload(updatedSession, sessions, current.activeSessionId, true);
        }
      }
    }

    const prepared = yield* checkout.prepare({
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      prUrl: input.prUrl,
      baseSha,
      headSha,
      baseRef,
      headRef,
      reviewMode: reviewScope.mode,
      commitSha: reviewScope.commitSha,
      files: input.files,
    });

    const session = yield* flueSessions.create({
      runtimeVersion: 2,
      id: randomUUID(),
      prUrl: input.prUrl,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      baseSha,
      headSha,
      baseRef,
      headRef,
      reviewMode: reviewScope.mode,
      commitSha: reviewScope.commitSha,
      worktreePath: prepared.worktreePath,
      repoAccess: prepared.repoAccess,
      files: input.files,
    });

    const prData = yield* prContext.addSession(input.prUrl, session.id, headSha);
    yield* prContext.setSessionScope(session.id, reviewScope);

    const sessions = yield* visibleV2Sessions(prData.sessions, flueSessions);
    return sessionPayload(session, sessions, prData.activeSessionId, false);
  });
}

const startingReviews = new ReviewLaunchCoordinator<AutomaticReviewStatus>();
const sessionLock = new PrSessionLock();
const startErrors = new Map<string, string>();
function canonicalPrUrl(value: string): string {
  const pr = parsePrUrl(value);
  if (!pr) throw new Error("Invalid PR URL");
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}
async function latestReviewSession(prUrl: string) {
  return runEffect(
    Effect.gen(function* () {
      const context = yield* PrContextService;
      const store = yield* FlueReviewSessionService;
      const current = yield* context.listSessions(prUrl);
      const sessions = yield* visibleV2Sessions(current.sessions, store);
      const latest = sessions.sort((a, b) => b.createdAt - a.createdAt)[0];
      return latest ? yield* store.get(latest.id) : null;
    }),
  );
}
async function automaticReviewStatus(prUrl: string): Promise<AutomaticReviewStatus> {
  if (startingReviews.has(prUrl)) return { state: "starting" };
  const session = await latestReviewSession(prUrl);
  const history = session ? await readFlueConversationHistory(session.id) : null;
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
async function startAutomaticReview(
  prUrl: string,
  simplifiedEnglish: boolean,
  rerun: boolean,
): Promise<AutomaticReviewStatus> {
  return startingReviews.run(prUrl, () =>
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
              rerun,
            );
          }),
        );
        const session = await runEffect(
          Effect.flatMap(FlueReviewSessionService, (store) => store.get(data.session.id)),
        );
        if (!session) throw new Error("Review session not found");
        const history = await readFlueConversationHistory(session.id);
        const state = reviewConversationStatus(history, session.automaticReview?.submissionId);
        if (state === "running" || state === "completed")
          return { state, sessionId: session.id, headSha: session.headSha };
        // Persist the key before admission, so an interrupted request can safely retry.
        const idempotencyKey =
          state === "failed"
            ? randomUUID()
            : (session.automaticReview?.idempotencyKey ?? randomUUID());
        const prompt =
          state !== "failed" && session.automaticReview?.prompt
            ? session.automaticReview.prompt
            : buildReviewPrompt(STRUCTURED_REVIEW_PROMPT, simplifiedEnglish);
        session.automaticReview = { idempotencyKey, prompt };
        await runEffect(
          Effect.gen(function* () {
            const store = yield* FlueReviewSessionService;
            yield* store.save(session);
          }),
        );
        const receipt = await sendServerReview(session.id, prompt, idempotencyKey);
        session.automaticReview = { idempotencyKey, prompt, submissionId: receipt.submissionId };
        await runEffect(
          Effect.gen(function* () {
            const store = yield* FlueReviewSessionService;
            yield* store.save(session);
          }),
        );
        return { state: "running", sessionId: session.id, headSha: session.headSha };
      } catch (error) {
        startErrors.set(prUrl, error instanceof Error ? error.message : "Could not start review");
        throw error;
      }
    }),
  );
}

export const flueReviewRouter = router({
  startAutomatic: publicProcedure
    .input(
      z.object({
        prUrl: z.string(),
        simplifiedEnglish: z.boolean().default(false),
        rerun: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) =>
      startAutomaticReview(canonicalPrUrl(input.prUrl), input.simplifiedEnglish, input.rerun),
    ),
  automaticStatuses: publicProcedure
    .input(z.object({ prUrls: z.array(z.string()).max(200) }))
    .query(async ({ input }) => {
      const statuses: Record<string, AutomaticReviewStatus> = {};
      for (const prUrl of input.prUrls) {
        try {
          statuses[prUrl] = await automaticReviewStatus(canonicalPrUrl(prUrl));
        } catch {
          statuses[prUrl] = { state: "failed", error: "Could not load review status" };
        }
      }
      return statuses;
    }),
  getOrCreateSession: publicProcedure
    .input(sessionInput)
    .mutation(({ input }) =>
      sessionLock.run(canonicalPrUrl(input.prUrl), () =>
        runEffect(getOrCreateReviewSession(input)),
      ),
    ),

  selectSession: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) => {
      const prUrl = canonicalPrUrl(input.prUrl);
      return sessionLock.run(prUrl, () =>
        runEffect(
          Effect.gen(function* () {
            const prContext = yield* PrContextService;
            const flueSessions = yield* FlueReviewSessionService;
            const session = yield* flueSessions.get(input.sessionId);
            if (!isFlueV2ReviewSession(session)) {
              return yield* Effect.fail(new Error("Flue V2 review session not found"));
            }
            const current = yield* prContext.listSessions(prUrl);
            if (
              canonicalPrUrl(session.prUrl) !== prUrl ||
              !current.sessions.some((s) => s.id === session.id)
            ) {
              return yield* Effect.fail(new Error("Review session not found for PR"));
            }
            const sessions = yield* visibleV2Sessions(current.sessions, flueSessions);
            yield* prContext.setActiveSession(prUrl, session.id);
            yield* prContext.registerSession(session.id, prUrl);
            yield* prContext.setSessionScope(session.id, {
              mode: session.reviewMode,
              commitSha: session.commitSha,
            });
            return sessionPayload(session, sessions, session.id, true);
          }),
        ),
      );
    }),

  create: publicProcedure.input(sessionInput).mutation(({ input }) =>
    sessionLock.run(canonicalPrUrl(input.prUrl), () =>
      runEffect(
        Effect.gen(function* () {
          const startedAt = Date.now();
          yield* Effect.log(
            `[flueReview.create] START ${input.repoOwner}/${input.repoName}#${input.prNumber}`,
          );

          const gh = yield* GhService;
          const prContext = yield* PrContextService;
          const flueSessions = yield* FlueReviewSessionService;
          const checkout = yield* PrCheckoutService;

          const pr = parsePrUrl(input.prUrl);
          if (!pr) {
            return yield* Effect.fail(new Error(`Invalid PR URL: ${input.prUrl}`));
          }

          const reviewScope = makeReviewScope(input);
          const metadataStartedAt = Date.now();
          const [headSha, baseSha, headRef, baseRef] = yield* Effect.all(
            [
              gh.getHeadSha(input.prUrl),
              gh.getBaseSha(input.prUrl),
              gh.getHeadRef(input.prUrl),
              gh.getBaseRef(input.prUrl),
            ],
            { concurrency: 4 },
          );
          yield* Effect.log(
            `[flueReview.create] github metadata completed in ${Date.now() - metadataStartedAt}ms total=${Date.now() - startedAt}ms`,
          );

          const checkoutStartedAt = Date.now();
          const prepared = yield* checkout.prepare({
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            prUrl: input.prUrl,
            baseSha,
            headSha,
            baseRef,
            headRef,
            reviewMode: reviewScope.mode,
            commitSha: reviewScope.commitSha,
            files: input.files,
          });
          yield* Effect.log(
            `[flueReview.create] checkout.prepare completed in ${Date.now() - checkoutStartedAt}ms total=${Date.now() - startedAt}ms`,
          );

          const storeStartedAt = Date.now();
          const session = yield* flueSessions.create({
            runtimeVersion: 2,
            id: randomUUID(),
            prUrl: input.prUrl,
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            baseSha,
            headSha,
            baseRef,
            headRef,
            reviewMode: reviewScope.mode,
            commitSha: reviewScope.commitSha,
            worktreePath: prepared.worktreePath,
            repoAccess: prepared.repoAccess,
            files: input.files,
          });
          yield* Effect.log(
            `[flueReview.create] session store completed in ${Date.now() - storeStartedAt}ms total=${Date.now() - startedAt}ms`,
          );

          const contextStartedAt = Date.now();
          const prData = yield* prContext.addSession(input.prUrl, session.id, headSha);
          yield* prContext.setSessionScope(session.id, reviewScope);
          yield* Effect.log(
            `[flueReview.create] pr context completed in ${Date.now() - contextStartedAt}ms total=${Date.now() - startedAt}ms`,
          );
          yield* Effect.log(
            `[flueReview.create] DONE ${input.repoOwner}/${input.repoName}#${input.prNumber} session=${session.id} total=${Date.now() - startedAt}ms`,
          );

          const sessions = yield* visibleV2Sessions(prData.sessions, flueSessions);
          return sessionPayload(session, sessions, prData.activeSessionId, false);
        }).pipe(
          Effect.withSpan("flueReview.create", {
            attributes: {
              prUrl: input.prUrl,
              repoOwner: input.repoOwner,
              repoName: input.repoName,
              prNumber: input.prNumber,
              reviewMode: input.reviewMode ?? "full",
            },
          }),
        ),
      ),
    ),
  ),

  switch: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const flueSessions = yield* FlueReviewSessionService;
          const session = yield* flueSessions.get(input.sessionId);
          if (!isFlueV2ReviewSession(session)) {
            return yield* Effect.fail(
              new Error("This review belongs to the retired Flue beta runtime"),
            );
          }
          yield* prContext.setActiveSession(input.prUrl, input.sessionId);
          yield* prContext.registerSession(input.sessionId, input.prUrl);
          return { success: true, activeSessionId: input.sessionId };
        }),
      ),
    ),

  hide: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
          const flueSessions = yield* FlueReviewSessionService;
          const prData = yield* prContext.hideSession(input.prUrl, input.sessionId);
          const sessions = yield* visibleV2Sessions(prData.sessions, flueSessions);
          const visibleSessions = sessions.filter((session) => !session.hidden);
          return {
            success: true,
            sessions: visibleSessions,
            activeSessionId: visibleSessions.some(
              (session) => session.id === prData.activeSessionId,
            )
              ? prData.activeSessionId
              : null,
          };
        }),
      ),
    ),

  messages: publicProcedure.input(z.object({ sessionId: z.string() })).query(async ({ input }) => {
    if (!isFlueV2ReviewSession(await readFlueReviewSession(input.sessionId))) {
      return { messages: [] };
    }
    const history = await readFlueConversationHistory(input.sessionId);
    return { messages: history ? conversationHistoryToChatMessages(history) : [] };
  }),
});
