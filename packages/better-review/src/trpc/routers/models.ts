import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { TRPCError } from "@trpc/server";
import { Effect } from "effect";
import { z } from "zod";

import { OpencodeService } from "../../opencode";
import { opencodeRuntime } from "../context";
import { router, publicProcedure } from "../index";

// =============================================================================
// Model/Provider Types and State
// =============================================================================

interface ModelEntry {
  providerId: string;
  modelId: string;
}

interface ProviderCatalog {
  providers: Array<{ id: string; models: string[] }>;
  connected: Set<string>;
}

// Provider catalog cache (in-memory) to avoid calling OpenCode on every keystroke.
const PROVIDER_CATALOG_TTL_MS = 60_000;
let providerCatalogCache:
  | {
      expiresAt: number;
      catalog: ProviderCatalog;
    }
  | undefined;

async function fetchProviderCatalog(opencodeClient: OpencodeClient): Promise<ProviderCatalog> {
  try {
    const res = await opencodeClient.provider.list();
    const connected = new Set(res.data?.connected ?? []);
    const providers = (res.data?.all ?? []).map((provider) => ({
      id: provider.id,
      models: Object.keys(provider.models ?? {}),
    }));
    return { providers, connected };
  } catch (err) {
    console.error("[models] Failed to load providers from OpenCode:", err);
    return { providers: [], connected: new Set() };
  }
}

async function getProviderCatalog(): Promise<ProviderCatalog> {
  const now = Date.now();
  if (providerCatalogCache && providerCatalogCache.expiresAt > now) {
    return providerCatalogCache.catalog;
  }

  const catalog = await opencodeRuntime.runPromise(
    Effect.gen(function* () {
      const opencode = yield* OpencodeService;
      return yield* Effect.tryPromise(() => fetchProviderCatalog(opencode.client));
    }),
  );

  providerCatalogCache = {
    catalog,
    expiresAt: now + PROVIDER_CATALOG_TTL_MS,
  };

  return catalog;
}

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
  search: publicProcedure.input(z.object({ q: z.string().optional() })).query(async ({ input }) => {
    const query = (input.q || "").toLowerCase().trim();

    const catalog = await getProviderCatalog();
    if (catalog.connected.size === 0) {
      return { models: [], connectedProvidersCount: 0 };
    }

    const candidates: ModelEntry[] = [];
    for (const provider of catalog.providers) {
      if (!catalog.connected.has(provider.id)) continue;
      for (const modelId of provider.models) {
        candidates.push({ providerId: provider.id, modelId });
      }
    }

    let results: ModelEntry[];

    if (!query) {
      results = candidates.slice(0, 50);
    } else {
      results = candidates
        .filter(
          (m) =>
            m.providerId.toLowerCase().includes(query) || m.modelId.toLowerCase().includes(query),
        )
        .slice(0, 50);
    }

    return { models: results, connectedProvidersCount: catalog.connected.size };
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
    .mutation(async ({ input }) => {
      const catalog = await getProviderCatalog();
      if (!catalog.connected.has(input.providerId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider not connected: ${input.providerId}`,
        });
      }

      const provider = catalog.providers.find((p) => p.id === input.providerId);
      const exists = provider?.models.includes(input.modelId) ?? false;

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
