import { router } from "../index";
import { flueReviewRouter } from "./flue-review";
import { modelsRouter } from "./models";
import { prRouter } from "./pr";
import { projectsRouter } from "./projects";
import { prsRouter } from "./prs";
import { reviewSessionsRouter } from "./review-sessions";
import { sessionsRouter } from "./sessions";
import { userRouter } from "./user";

export const appRouter = router({
  pr: prRouter,
  prs: prsRouter,
  projects: projectsRouter,
  user: userRouter,
  sessions: sessionsRouter,
  reviewSessions: reviewSessionsRouter,
  models: modelsRouter,
  flueReview: flueReviewRouter,
});

// Export type for frontend client
export type AppRouter = typeof appRouter;
