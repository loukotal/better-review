import type { ReviewSession, ReviewSessionStatus } from "@better-review/shared";

export type AgentReviewStatusFilter = "all" | ReviewSessionStatus;
export type AgentReviewAgeFilter = "24h" | "7d" | "30d" | "all";

const ageInMilliseconds: Record<Exclude<AgentReviewAgeFilter, "all">, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

export function isWithinAge(
  session: ReviewSession,
  age: AgentReviewAgeFilter,
  now = Date.now(),
): boolean {
  return age === "all" || session.createdAt >= now - ageInMilliseconds[age];
}

export function filterAgentReviewSessions(
  sessions: ReviewSession[],
  status: AgentReviewStatusFilter,
  age: AgentReviewAgeFilter,
  now = Date.now(),
): ReviewSession[] {
  return sessions.filter(
    (session) => (status === "all" || session.status === status) && isWithinAge(session, age, now),
  );
}
