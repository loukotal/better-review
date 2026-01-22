import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { TRPCError } from "@trpc/server";
import { Effect } from "effect";
import { z } from "zod";

import { OpencodeService } from "../../opencode";
import { runtime } from "../context";
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

// Index models by provider for quick filtering
const modelsByProvider = new Map<string, ModelEntry[]>();
for (const entry of providerData) {
  const list = modelsByProvider.get(entry.providerId);
  if (list) list.push(entry);
  else modelsByProvider.set(entry.providerId, [entry]);
}

// Connected providers cache (in-memory) to avoid calling OpenCode on every keystroke.
const CONNECTED_PROVIDERS_TTL_MS = 60_000;
let connectedProvidersCache:
  | {
      expiresAt: number;
      providers: Set<string>;
    }
  | undefined;

async function fetchConnectedProviders(opencodeClient: OpencodeClient): Promise<Set<string>> {
  try {
    const res = await opencodeClient.provider.list();
    const connected = res.data?.connected ?? [];
    return new Set(connected);
  } catch (err) {
    console.error("[models] Failed to load connected providers from OpenCode:", err);
    return new Set();
  }
}

async function getConnectedProviders(): Promise<Set<string>> {
  const now = Date.now();
  if (connectedProvidersCache && connectedProvidersCache.expiresAt > now) {
    return connectedProvidersCache.providers;
  }

  const providers = await runtime.runPromise(
    Effect.gen(function* () {
      const opencode = yield* OpencodeService;
      return yield* Effect.tryPromise(() => fetchConnectedProviders(opencode.client));
    }),
  );

  connectedProvidersCache = {
    providers,
    expiresAt: now + CONNECTED_PROVIDERS_TTL_MS,
  };

  return providers;
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

    const connectedProviders = await getConnectedProviders();
    if (connectedProviders.size === 0) {
      return { models: [], connectedProvidersCount: 0 };
    }

    // Limit candidates to connected providers only
    const candidates: ModelEntry[] = [];
    for (const providerId of connectedProviders) {
      const list = modelsByProvider.get(providerId);
      if (list) candidates.push(...list);
    }

    let results: ModelEntry[];

    if (!query) {
      // Return first 50 models if no query
      results = candidates.slice(0, 50);
    } else {
      // Case-insensitive substring search on both providerId and modelId
      results = candidates
        .filter(
          (m) =>
            m.providerId.toLowerCase().includes(query) || m.modelId.toLowerCase().includes(query),
        )
        .slice(0, 50);
    }

    return { models: results, connectedProvidersCount: connectedProviders.size };
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
      const connectedProviders = await getConnectedProviders();
      if (!connectedProviders.has(input.providerId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider not connected: ${input.providerId}`,
        });
      }

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
