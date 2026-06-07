import {
  findEnvKeys,
  getModel,
  getModels,
  getProviders,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";

import { hasPiOAuthProvider } from "./flue/oauth-auth";

export interface ModelEntry {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  variants: string[];
  releaseDate: string;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  variant: string | null;
}

export type SelectedModel = ModelEntry & {
  variant: string | null;
};

const FALLBACK_FLUE_MODEL = "anthropic/claude-sonnet-4-6";
const configuredDefaultModel = process.env.BETTER_REVIEW_FLUE_MODEL?.trim();

const providerAliases = new Map<string, string>([
  ["vercel", "vercel-ai-gateway"],
  ["zai-coding-plan", "zai"],
]);

let currentModel: ModelSelection | undefined;

const getModelById = getModel as (provider: string, modelId: string) => Model<Api> | undefined;
const getModelsByProvider = getModels as (provider: string) => Array<Model<Api>>;

function normalizeProviderId(providerId: string): string {
  return providerAliases.get(providerId) ?? providerId;
}

function parseFlueModel(model: string): ModelSelection | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;

  const providerId = normalizeProviderId(model.slice(0, slash));
  const modelId = model.slice(slash + 1);
  if (!providerId || !modelId) return null;

  return { providerId, modelId, variant: null };
}

function toModelEntry(model: Model<Api>): ModelEntry {
  return {
    providerId: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    variants: [],
    releaseDate: "",
  };
}

export function getModelEntry(providerId: string, modelId: string): ModelEntry | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  const model = getModelById(normalizedProviderId, modelId);
  return model ? toModelEntry(model) : null;
}

function resolveVariant(_model: ModelEntry, input: { variant?: string | null }): string | null {
  // Flue/pi-ai model IDs are selected directly; there is no OpenCode-style variant channel.
  return typeof input.variant === "string" && input.variant.length > 0 ? input.variant : null;
}

function toSelectedModel(model: ModelEntry, variant: string | null): SelectedModel {
  return { ...model, variant };
}

function resolveDefaultModel(): SelectedModel {
  const configured = configuredDefaultModel ? parseFlueModel(configuredDefaultModel) : null;

  if (configured) {
    const model = getModelEntry(configured.providerId, configured.modelId);
    if (model) return toSelectedModel(model, configured.variant);
  }

  // Local dev usually has Pi's ChatGPT/Codex OAuth but no Anthropic token. Prefer
  // the UI-visible OpenAI model; getCurrentFlueModel() will route it to
  // openai-codex when needed.
  if (hasPiOAuthProvider("openai-codex") && !process.env.OPENAI_API_KEY) {
    const openAiModel = getModelEntry("openai", "gpt-5.5");
    if (openAiModel) return toSelectedModel(openAiModel, null);
  }

  const fallback = parseFlueModel(FALLBACK_FLUE_MODEL);
  if (fallback) {
    const model = getModelEntry(fallback.providerId, fallback.modelId);
    if (model) return toSelectedModel(model, fallback.variant);
  }

  const firstProvider = getProviders()[0];
  const firstModel = firstProvider ? getModelsByProvider(firstProvider)[0] : undefined;
  if (!firstModel) {
    throw new Error("No Flue models are available");
  }

  return toSelectedModel(toModelEntry(firstModel), null);
}

export function getSelectedModel(): SelectedModel {
  if (!currentModel) {
    const resolved = resolveDefaultModel();
    currentModel = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      variant: resolved.variant,
    };
    return resolved;
  }

  const model = getModelEntry(currentModel.providerId, currentModel.modelId);
  if (!model) {
    const resolved = resolveDefaultModel();
    currentModel = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      variant: resolved.variant,
    };
    return resolved;
  }

  const variant = resolveVariant(model, { variant: currentModel.variant });
  currentModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant,
  };

  return toSelectedModel(model, variant);
}

export function setSelectedModel(input: {
  providerId: string;
  modelId: string;
  variant?: string | null;
}): SelectedModel {
  const model = getModelEntry(input.providerId, input.modelId);
  if (!model) {
    throw new Error(`Model not found: ${input.providerId}/${input.modelId}`);
  }

  const variant = resolveVariant(model, { variant: input.variant });
  currentModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant,
  };

  return toSelectedModel(model, variant);
}

export function searchModels(query: string): {
  models: ModelEntry[];
  connectedProvidersCount: number;
} {
  const normalizedQuery = query.toLowerCase().trim();
  const configuredProviders = new Set<string>();
  const candidates: ModelEntry[] = [];

  for (const providerId of getProviders()) {
    if (findEnvKeys(providerId)?.length) {
      configuredProviders.add(providerId);
    }

    for (const model of getModelsByProvider(providerId)) {
      candidates.push(toModelEntry(model));
    }
  }

  const models = (
    normalizedQuery
      ? candidates.filter(
          (model) =>
            model.providerId.toLowerCase().includes(normalizedQuery) ||
            model.modelId.toLowerCase().includes(normalizedQuery) ||
            model.name.toLowerCase().includes(normalizedQuery),
        )
      : candidates
  ).slice(0, 50);

  return { models, connectedProvidersCount: configuredProviders.size };
}

export function getCurrentFlueModel(): string {
  const selected = getSelectedModel();

  // `openai/*` is API-key auth. If the user is logged in through Pi's ChatGPT/Codex
  // OAuth, use Flue/pi-ai's `openai-codex/*` provider for the same model ID instead.
  if (
    selected.providerId === "openai" &&
    !process.env.OPENAI_API_KEY &&
    hasPiOAuthProvider("openai-codex") &&
    getModelEntry("openai-codex", selected.modelId)
  ) {
    return `openai-codex/${selected.modelId}`;
  }

  return `${selected.providerId}/${selected.modelId}`;
}
