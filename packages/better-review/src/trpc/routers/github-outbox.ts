import { TRPCError } from "@trpc/server";

import {
  isGithubOutboxAdmissionInput,
  isGithubOutboxBatchControl,
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
  pending: publicProcedure.query(() => getGithubOutboxRuntime().outbox.listPending()),
  batchControl: publicProcedure
    .input(validate(isGithubOutboxBatchControl))
    .mutation(({ input }) => getGithubOutboxRuntime().outbox.batchControl(input)),
  enqueue: publicProcedure
    .input(validate(isGithubOutboxAdmissionInput))
    .mutation(({ input }) =>
      "command" in input
        ? getGithubOutboxRuntime().outbox.enqueue(input.command, input.cycle)
        : getGithubOutboxRuntime().outbox.enqueue(input),
    ),
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
