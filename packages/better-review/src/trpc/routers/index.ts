import { router } from "../index";
import { prRouter } from "./pr";
import { prsRouter } from "./prs";
import { userRouter } from "./user";
import { sessionsRouter } from "./sessions";
import { modelsRouter } from "./models";
import { opencodeRouter } from "./opencode";

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
