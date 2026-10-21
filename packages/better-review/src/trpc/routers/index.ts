import { router } from "../index";
import { githubOutboxRouter } from "./github-outbox";
import { modelsRouter } from "./models";
import { prRouter } from "./pr";
import { prDetailRouter } from "./pr-detail";
import { prReviewRouter } from "./pr-review";
import { projectsRouter } from "./projects";
import { prsRouter } from "./prs";
import { reviewSessionsRouter } from "./review-sessions";
import { sessionsRouter } from "./sessions";
import { userRouter } from "./user";

export const appRouter = router({
  githubOutbox: githubOutboxRouter,
  pr: prRouter,
  prDetail: prDetailRouter,
  prs: prsRouter,
  projects: projectsRouter,
  user: userRouter,
  sessions: sessionsRouter,
  reviewSessions: reviewSessionsRouter,
  models: modelsRouter,
  prReview: prReviewRouter,
});

// Export type for frontend client
export type AppRouter = typeof appRouter;
