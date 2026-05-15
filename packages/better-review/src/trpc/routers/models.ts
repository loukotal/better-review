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
  name: string;
  reasoning: boolean;
  variants: string[];
  releaseDate: string;
}

interface ModelSelection {
  providerId: string;
  modelId: string;
  variant: string | null;
}

type SelectedModel = ModelEntry & {
  variant: string | null;
};

interface ProviderModelData {
  name: string;
  reasoning: boolean;
  variants: string[];
  releaseDate: string;
}

interface ProviderCatalog {
  providers: Array<{ id: string; models: Record<string, ProviderModelData> }>;
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
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).map(([modelId, model]) => {
          const modelWithReasoning = model as typeof model & { reasoning?: boolean };
          return [
            modelId,
            {
              name: model.name,
              reasoning: modelWithReasoning.reasoning ?? false,
              variants: Object.keys(model.variants ?? {}),
              releaseDate: model.release_date,
            },
          ];
        }),
      ),
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

const DEPRIORITIZED_GPT_MODEL_PATTERN = /(mini|fast|nano|flash|haiku|instant|lite|economy)/i;
const DEPRIORITIZED_PROVIDER_PATTERN = /(copilot|github)/i;

let currentModel: ModelSelection | undefined;

function getModelEntry(
  catalog: ProviderCatalog,
  providerId: string,
  modelId: string,
): ModelEntry | null {
  const provider = catalog.providers.find((item) => item.id === providerId);
  const model = provider?.models[modelId];
  if (!model) return null;

  return {
    providerId,
    modelId,
    name: model.name,
    reasoning: model.reasoning,
    variants: model.variants,
    releaseDate: model.releaseDate,
  };
}

function resolveVariant(model: ModelEntry, input: { variant?: string | null }): string | null {
  const variants = model.variants;
  if (variants.length === 0) return null;

  if (typeof input.variant === "string") {
    return variants.includes(input.variant) ? input.variant : null;
  }

  if (input.variant === null) return null;

  return null;
}

function toSelectedModel(model: ModelEntry, variant: string | null): SelectedModel {
  return {
    ...model,
    variant,
  };
}

function compareModelRecency(a: ModelEntry, b: ModelEntry): number {
  const dateCompare = b.releaseDate.localeCompare(a.releaseDate);
  if (dateCompare !== 0) return dateCompare;
  return b.modelId.localeCompare(a.modelId);
}

function getGptPreferenceScore(model: ModelEntry): number {
  let score = 0;

  if (!DEPRIORITIZED_PROVIDER_PATTERN.test(model.providerId)) {
    score += 1000;
  }

  if (!DEPRIORITIZED_GPT_MODEL_PATTERN.test(model.modelId)) {
    score += 100;
  }

  if (model.reasoning) {
    score += 10;
  }

  return score;
}

function resolveDefaultModel(catalog: ProviderCatalog): SelectedModel {
  const connectedModels: ModelEntry[] = [];
  for (const provider of catalog.providers) {
    if (!catalog.connected.has(provider.id)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      connectedModels.push({
        providerId: provider.id,
        modelId,
        name: model.name,
        reasoning: model.reasoning,
        variants: model.variants,
        releaseDate: model.releaseDate,
      });
    }
  }

  const preferredModel = connectedModels
    .filter((model) => /^gpt-/i.test(model.modelId))
    .sort((a, b) => {
      const scoreCompare = getGptPreferenceScore(b) - getGptPreferenceScore(a);
      if (scoreCompare !== 0) return scoreCompare;
      return compareModelRecency(a, b);
    })[0];

  const fallbackModel =
    preferredModel ??
    connectedModels.sort((a, b) => {
      const providerCompare =
        Number(DEPRIORITIZED_PROVIDER_PATTERN.test(a.providerId)) -
        Number(DEPRIORITIZED_PROVIDER_PATTERN.test(b.providerId));
      if (providerCompare !== 0) return providerCompare;

      const dateCompare = compareModelRecency(a, b);
      if (dateCompare !== 0) return dateCompare;
      return a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId);
    })[0];

  if (!fallbackModel) {
    return {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      reasoning: true,
      variants: [],
      releaseDate: "",
      variant: null,
    };
  }

  return toSelectedModel(fallbackModel, null);
}

async function getSelectedModel(): Promise<SelectedModel> {
  const catalog = await getProviderCatalog();
  if (!currentModel) {
    const resolved = resolveDefaultModel(catalog);
    currentModel = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      variant: resolved.variant,
    };
    return resolved;
  }

  const model = getModelEntry(catalog, currentModel.providerId, currentModel.modelId);
  if (!model) {
    const resolved = resolveDefaultModel(catalog);
    currentModel = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      variant: resolved.variant,
    };
    return resolved;
  }

  const variant =
    currentModel.variant && model.variants.includes(currentModel.variant)
      ? currentModel.variant
      : null;
  currentModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant,
  };
  return toSelectedModel(model, variant);
}

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
      for (const [modelId, model] of Object.entries(provider.models)) {
        candidates.push({
          providerId: provider.id,
          modelId,
          name: model.name,
          reasoning: model.reasoning,
          variants: model.variants,
          releaseDate: model.releaseDate,
        });
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
  current: publicProcedure.query(async () => getSelectedModel()),

  /**
   * Set the current model
   * Validates that the model exists in the provider data
   */
  setCurrent: publicProcedure
    .input(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        variant: z.string().nullable().optional(),
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

      const model = getModelEntry(catalog, input.providerId, input.modelId);
      const exists = model !== null;

      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Model not found: ${input.providerId}/${input.modelId}`,
        });
      }

      const variant = resolveVariant(model, { variant: input.variant });

      currentModel = {
        providerId: input.providerId,
        modelId: input.modelId,
        variant,
      };

      console.log(
        `[models] Model changed to: ${currentModel.providerId}/${currentModel.modelId}${variant ? ` (${variant})` : ""}`,
      );

      return { success: true, model: toSelectedModel(model, variant) };
    }),
});

// Export the current model for use by other modules (e.g., opencode router)
export async function getCurrentModel(): Promise<ModelSelection> {
  const selected = await getSelectedModel();
  return {
    providerId: selected.providerId,
    modelId: selected.modelId,
    variant: selected.variant,
  };
}
