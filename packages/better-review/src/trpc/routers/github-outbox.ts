import { TRPCError } from "@trpc/server";

import {
  isGithubOutboxCommand,
  isGithubOutboxControl,
  isGithubOutboxHeartbeat,
  isGithubPrScope,
} from "@better-review/shared";

import { getGithubOutboxRuntime } from "../../github-outbox/runtime";
import { publicProcedure, router } from "../index";

function validate<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): T => {
    if (!guard(value))
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid GitHub outbox input" });
    return value;
  };
}

export const githubOutboxRouter = router({
  capability: publicProcedure.query(() => {
    getGithubOutboxRuntime();
    return { version: 1 as const, durableAdmission: true as const };
  }),
  identity: publicProcedure.query(() => ({ actor: getGithubOutboxRuntime().actor() })),
  enqueue: publicProcedure
    .input(validate(isGithubOutboxCommand))
    .mutation(({ input }) => getGithubOutboxRuntime().outbox.enqueue(input)),
  snapshot: publicProcedure
    .input(validate(isGithubPrScope))
    .query(({ input }) => getGithubOutboxRuntime().outbox.snapshot(input)),
  control: publicProcedure
    .input(validate(isGithubOutboxControl))
    .mutation(({ input }) => getGithubOutboxRuntime().outbox.control(input)),
  heartbeat: publicProcedure
    .input(validate(isGithubOutboxHeartbeat))
    .mutation(async ({ input }) => {
      await getGithubOutboxRuntime().outbox.heartbeat(input);
      return { ok: true as const };
    }),
});
