import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { router, publicProcedure } from "../index";

// =============================================================================
// Model/Provider Types and State
// =============================================================================

interface ModelEntry {
  providerId: string;
  modelId: string;
}

// Load providers from JSON file
const providerData: ModelEntry[] = await Bun.file("./provider.json").json();
console.log(`[models] Loaded ${providerData.length} model entries`);

// Current model selection (in-memory, no persistence for now)
let currentModel: ModelEntry = {
  providerId: "anthropic",
  modelId: "claude-opus-4-5",
};

// =============================================================================
// Models Router
// =============================================================================

export const modelsRouter = router({
  /**
   * Search for models by provider or model ID
   * Returns first 50 models matching the query, or first 50 if no query
   */
  search: publicProcedure.input(z.object({ q: z.string().optional() })).query(({ input }) => {
    const query = (input.q || "").toLowerCase().trim();

    let results: ModelEntry[];

    if (!query) {
      // Return first 50 models if no query
      results = providerData.slice(0, 50);
    } else {
      // Case-insensitive substring search on both providerId and modelId
      results = providerData
        .filter(
          (m) =>
            m.providerId.toLowerCase().includes(query) || m.modelId.toLowerCase().includes(query),
        )
        .slice(0, 50);
    }

    return { models: results };
  }),

  /**
   * Get the currently selected model
   */
  current: publicProcedure.query(() => {
    return currentModel;
  }),

  /**
   * Set the current model
   * Validates that the model exists in the provider data
   */
  setCurrent: publicProcedure
    .input(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      // Validate that this model exists in our data
      const exists = providerData.some(
        (m) => m.providerId === input.providerId && m.modelId === input.modelId,
      );

      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Model not found: ${input.providerId}/${input.modelId}`,
        });
      }

      currentModel = {
        providerId: input.providerId,
        modelId: input.modelId,
      };

      console.log(`[models] Model changed to: ${currentModel.providerId}/${currentModel.modelId}`);

      return { success: true, model: currentModel };
    }),
});

// Export the current model for use by other modules (e.g., opencode router)
export function getCurrentModel(): ModelEntry {
  return currentModel;
}
