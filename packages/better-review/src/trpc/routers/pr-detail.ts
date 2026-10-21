import path from "node:path";

import { z } from "zod";

import { createPrDetailClient } from "../../gh/pr-detail";
import { createPrMergeService, prMergeInput } from "../../gh/pr-merge";
import { STORE_BASE_DIR } from "../../store";
import { publicProcedure, router } from "../index";

const detail = createPrDetailClient();
// Lazy SQLite initialization: a journal failure disables writes, never detail reads.
const merge = createPrMergeService({
  databasePath: path.join(STORE_BASE_DIR, "pr-merge", "attempts.sqlite"),
});
const url = z.object({ url: z.string() });
export const prDetailRouter = router({
  get: publicProcedure.input(url).query(({ input }) => detail.get(input.url)),
  refresh: publicProcedure.input(url).mutation(({ input }) => detail.refresh(input.url)),
  merge: publicProcedure.input(prMergeInput).mutation(({ input }) => merge.merge(input)),
  reconcileMerge: publicProcedure
    .input(url.extend({ requestId: z.uuid() }))
    .mutation(({ input }) => merge.reconcileMerge(input)),
});
