import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getSelectedModel,
  searchModels,
  setSelectedModel,
  type ModelSelection,
} from "../../model-selection";
import { router, publicProcedure } from "../index";

export const modelsRouter = router({
  /**
   * Search Flue/pi-ai models by provider, model ID, or display name.
   */
  search: publicProcedure.input(z.object({ q: z.string().optional() })).query(({ input }) => {
    return searchModels(input.q ?? "");
  }),

  /**
   * Get the currently selected model.
   */
  current: publicProcedure.query(() => getSelectedModel()),

  /**
   * Set the current model for new Flue prompts.
   */
  setCurrent: publicProcedure
    .input(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        variant: z.string().nullable().optional(),
      }),
    )
    .mutation(({ input }) => {
      try {
        const model = setSelectedModel(input);
        console.log(
          `[models] Model changed to: ${model.providerId}/${model.modelId}${model.variant ? ` (${model.variant})` : ""}`,
        );
        return { success: true, model };
      } catch (error) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: error instanceof Error ? error.message : "Model not found",
          cause: error,
        });
      }
    }),
});

export function getCurrentModel(): ModelSelection {
  const selected = getSelectedModel();
  return {
    providerId: selected.providerId,
    modelId: selected.modelId,
    variant: selected.variant,
  };
}
