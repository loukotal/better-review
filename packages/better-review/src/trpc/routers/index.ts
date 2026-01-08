import { router } from "../index";
import { modelsRouter } from "./models";
import { opencodeRouter } from "./opencode";
import { prRouter } from "./pr";
import { prsRouter } from "./prs";
import { sessionsRouter } from "./sessions";
import { userRouter } from "./user";

export const appRouter = router({
  pr: prRouter,
  prs: prsRouter,
  user: userRouter,
  sessions: sessionsRouter,
  models: modelsRouter,
  opencode: opencodeRouter,
});

// Export type for frontend client
export type AppRouter = typeof appRouter;
