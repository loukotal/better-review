import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { z } from "zod";

import { FlueReviewSessionService, type FlueReviewSession } from "../../flue-review-sessions";
import { flueInternalSessionId, readFlueAgentSession } from "../../flue/session-store";
import { GhService } from "../../gh/gh";
import { PrCheckoutService } from "../../pr-checkout";
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

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "thinking" && typeof part.thinking === "string") return "";
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function stringifyReasoning(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasoning = value
    .map((part) =>
      isRecord(part) && part.type === "thinking" && typeof part.thinking === "string"
        ? part.thinking
        : "",
    )
    .filter(Boolean)
    .join("");
  return reasoning || undefined;
}

function sessionDataToChatMessages(
  data: Awaited<ReturnType<typeof readFlueAgentSession>>,
): ChatMessage[] {
  if (!data) return [];

  const messages: ChatMessage[] = [];
  const toolCalls = new Map<string, ChatMessage["toolCalls"][number]>();

  for (const entry of data.entries) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;

    const role = entry.message.role;
    const timestamp = Date.parse(entry.timestamp) || Date.now();

    if (role === "user") {
      messages.push({
        id: entry.id,
        role: "user",
        content: stringifyContent(entry.message.content),
        toolCalls: [],
        isStreaming: false,
        timestamp,
      });
      continue;
    }

    if (role === "assistant") {
      const content = entry.message.content;
      const assistantToolCalls: ChatMessage["toolCalls"] = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
          const tool = {
            id: part.id,
            callId: part.id,
            tool: typeof part.name === "string" ? part.name : "tool",
            status: "completed" as const,
            input: isRecord(part.arguments) ? part.arguments : {},
            title: typeof part.name === "string" ? part.name : "tool",
          };
          toolCalls.set(part.id, tool);
          assistantToolCalls.push(tool);
        }
      }

      messages.push({
        id: entry.id,
        role: "assistant",
        content: stringifyContent(content),
        reasoning: stringifyReasoning(content),
        toolCalls: assistantToolCalls,
        isStreaming: false,
        timestamp,
      });
      continue;
    }

    if (role === "toolResult" && typeof entry.message.toolCallId === "string") {
      const tool = toolCalls.get(entry.message.toolCallId);
      if (tool) {
        const content = stringifyContent(entry.message.content);
        if (entry.message.isError === true) {
          tool.status = "error";
          tool.error = content;
        } else {
          tool.output = content;
        }
      }
    }
  }

  return messages;
}

export const flueReviewRouter = router({
  getOrCreateSession: publicProcedure.input(sessionInput).mutation(({ input }) =>
    runEffect(
      Effect.gen(function* () {
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
        if (current.activeSessionId) {
          const active = current.sessions.find((session) => session.id === current.activeSessionId);
          const flueSession = yield* flueSessions.get(current.activeSessionId);
          if (active && active.headSha === headSha && flueSession) {
            yield* prContext.registerSession(flueSession.id, input.prUrl);
            yield* prContext.setSessionScope(flueSession.id, reviewScope);
            return sessionPayload(flueSession, current.sessions, current.activeSessionId, true);
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
          files: input.files,
        });

        const prData = yield* prContext.addSession(input.prUrl, session.id, headSha);
        yield* prContext.setSessionScope(session.id, reviewScope);

        return sessionPayload(session, prData.sessions, prData.activeSessionId, false);
      }),
    ),
  ),

  create: publicProcedure.input(sessionInput).mutation(({ input }) =>
    runEffect(
      Effect.gen(function* () {
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
          ],
          { concurrency: 4 },
        );

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
          files: input.files,
        });

        const prData = yield* prContext.addSession(input.prUrl, session.id, headSha);
        yield* prContext.setSessionScope(session.id, reviewScope);

        return sessionPayload(session, prData.sessions, prData.activeSessionId, false);
      }),
    ),
  ),

  switch: publicProcedure
    .input(z.object({ prUrl: z.string(), sessionId: z.string() }))
    .mutation(({ input }) =>
      runEffect(
        Effect.gen(function* () {
          const prContext = yield* PrContextService;
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
          const prData = yield* prContext.hideSession(input.prUrl, input.sessionId);
          return {
            success: true,
            sessions: prData.sessions.filter((session) => !session.hidden),
            activeSessionId: prData.activeSessionId,
          };
        }),
      ),
    ),

  messages: publicProcedure.input(z.object({ sessionId: z.string() })).query(async ({ input }) => ({
    messages: sessionDataToChatMessages(
      await readFlueAgentSession(flueInternalSessionId(input.sessionId)),
    ),
  })),
});
