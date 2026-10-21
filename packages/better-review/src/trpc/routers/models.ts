import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getSelectedModel,
  getModelSelectionState,
  REASONING_EFFORTS,
  searchModels,
  setSelectedModel,
  restoreSelectedModel,
  type ModelSelection,
} from "../../model-selection";
import { router, publicProcedure } from "../index";

const selectionInput = z.object({
  providerId: z.string(),
  modelId: z.string(),
  variant: z.string().nullable().optional(),
  thinkingLevel: z.enum(REASONING_EFFORTS).nullable().optional(),
});

export const modelsRouter = router({
  /**
   * Search Pi models by provider, model ID, or display name.
   */
  search: publicProcedure.input(z.object({ q: z.string().optional() })).query(({ input }) => {
    return searchModels(input.q ?? "");
  }),

  /**
   * Get the currently selected model.
   */
  current: publicProcedure.query(() => getModelSelectionState()),

  // Check again inside the mutation: another tab may have selected a model since current.query().
  restoreCurrent: publicProcedure.input(selectionInput).mutation(({ input }) => {
    try {
      return { model: restoreSelectedModel(input) };
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Cannot restore saved review model",
        cause: error,
      });
    }
  }),

  /**
   * Set the current model for new review prompts.
   */
  setCurrent: publicProcedure.input(selectionInput).mutation(({ input }) => {
    try {
      const model = setSelectedModel(input);
      console.log(
        `[models] Model changed to: ${model.providerId}/${model.modelId}${model.variant ? ` (${model.variant})` : ""}, thinking=${model.thinkingLevel}`,
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
    thinkingLevel: selected.thinkingLevel,
  };
}
