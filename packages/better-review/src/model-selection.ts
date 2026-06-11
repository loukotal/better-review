import {
  findEnvKeys,
  getModel,
  getModels,
  getProviders,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

import { hasPiOAuthProvider } from "./flue/oauth-auth";

export interface ModelEntry {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ReasoningEffort[];
  variants: string[];
  releaseDate: string;
}

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelSelection {
  providerId: string;
  modelId: string;
  variant: string | null;
  thinkingLevel: ReasoningEffort;
}

export type SelectedModel = ModelEntry & {
  variant: string | null;
  thinkingLevel: ReasoningEffort;
};

const FALLBACK_FLUE_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
const configuredDefaultModel = process.env.BETTER_REVIEW_FLUE_MODEL?.trim();

const providerAliases = new Map<string, string>([
  ["vercel", "vercel-ai-gateway"],
  ["zai-coding-plan", "zai"],
]);

let currentModel: ModelSelection | undefined;

const getModelById = getModel as (provider: string, modelId: string) => Model<Api> | undefined;
const getModelsByProvider = getModels as (provider: string) => Array<Model<Api>>;

function isReasoningEffort(value: ModelThinkingLevel): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function normalizeProviderId(providerId: string): string {
  return providerAliases.get(providerId) ?? providerId;
}

function parseFlueModel(model: string): ModelSelection | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;

  const providerId = normalizeProviderId(model.slice(0, slash));
  const modelId = model.slice(slash + 1);
  if (!providerId || !modelId) return null;

  return { providerId, modelId, variant: null, thinkingLevel: DEFAULT_REASONING_EFFORT };
}

function toModelEntry(model: Model<Api>): ModelEntry {
  return {
    providerId: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    thinkingLevels: getSupportedThinkingLevels(model).filter(isReasoningEffort),
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

function resolveThinkingLevel(
  model: ModelEntry,
  input: { thinkingLevel?: ReasoningEffort | null },
): ReasoningEffort {
  const requested = input.thinkingLevel ?? currentModel?.thinkingLevel ?? DEFAULT_REASONING_EFFORT;
  if (model.thinkingLevels.includes(requested)) return requested;

  const requestedIndex = REASONING_EFFORTS.indexOf(requested);
  for (let i = requestedIndex; i < REASONING_EFFORTS.length; i++) {
    const candidate = REASONING_EFFORTS[i];
    if (model.thinkingLevels.includes(candidate)) return candidate;
  }

  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = REASONING_EFFORTS[i];
    if (model.thinkingLevels.includes(candidate)) return candidate;
  }

  return "off";
}

function toSelectedModel(
  model: ModelEntry,
  variant: string | null,
  thinkingLevel: ReasoningEffort,
): SelectedModel {
  return { ...model, variant, thinkingLevel: resolveThinkingLevel(model, { thinkingLevel }) };
}

function resolveDefaultModel(): SelectedModel {
  const configured = configuredDefaultModel ? parseFlueModel(configuredDefaultModel) : null;

  if (configured) {
    const model = getModelEntry(configured.providerId, configured.modelId);
    if (model) return toSelectedModel(model, configured.variant, configured.thinkingLevel);
  }

  // Local dev usually has Pi's ChatGPT/Codex OAuth but no Anthropic token. Prefer
  // the UI-visible OpenAI model; getCurrentFlueModel() will route it to
  // openai-codex when needed.
  if (hasPiOAuthProvider("openai-codex") && !process.env.OPENAI_API_KEY) {
    const openAiModel = getModelEntry("openai", "gpt-5.5");
    if (openAiModel) return toSelectedModel(openAiModel, null, DEFAULT_REASONING_EFFORT);
  }

  const fallback = parseFlueModel(FALLBACK_FLUE_MODEL);
  if (fallback) {
    const model = getModelEntry(fallback.providerId, fallback.modelId);
    if (model) return toSelectedModel(model, fallback.variant, fallback.thinkingLevel);
  }

  const firstProvider = getProviders()[0];
  const firstModel = firstProvider ? getModelsByProvider(firstProvider)[0] : undefined;
  if (!firstModel) {
    throw new Error("No Flue models are available");
  }

  return toSelectedModel(toModelEntry(firstModel), null, DEFAULT_REASONING_EFFORT);
}

export function getSelectedModel(): SelectedModel {
  if (!currentModel) {
    const resolved = resolveDefaultModel();
    currentModel = {
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      variant: resolved.variant,
      thinkingLevel: resolved.thinkingLevel,
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
      thinkingLevel: resolved.thinkingLevel,
    };
    return resolved;
  }

  const variant = resolveVariant(model, { variant: currentModel.variant });
  const thinkingLevel = resolveThinkingLevel(model, { thinkingLevel: currentModel.thinkingLevel });
  currentModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant,
    thinkingLevel,
  };

  return toSelectedModel(model, variant, thinkingLevel);
}

export function setSelectedModel(input: {
  providerId: string;
  modelId: string;
  variant?: string | null;
  thinkingLevel?: ReasoningEffort | null;
}): SelectedModel {
  let model = getModelEntry(input.providerId, input.modelId);
  if (!model) {
    throw new Error(`Model not found: ${input.providerId}/${input.modelId}`);
  }

  if (model.providerId === "openai" && !process.env.OPENAI_API_KEY) {
    const codexModel = hasPiOAuthProvider("openai-codex")
      ? getModelEntry("openai-codex", model.modelId)
      : null;
    if (!codexModel) {
      throw new Error(
        `Model ${model.providerId}/${model.modelId} requires OPENAI_API_KEY. Select an openai-codex model or set OPENAI_API_KEY.`,
      );
    }
    model = codexModel;
  }

  const variant = resolveVariant(model, { variant: input.variant });
  const thinkingLevel = resolveThinkingLevel(model, { thinkingLevel: input.thinkingLevel });
  currentModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant,
    thinkingLevel,
  };

  return toSelectedModel(model, variant, thinkingLevel);
}

export function searchModels(query: string): {
  models: ModelEntry[];
  connectedProvidersCount: number;
} {
  const normalizedQuery = query.toLowerCase().trim();
  const configuredProviders = new Set<string>();
  const candidates: ModelEntry[] = [];

  for (const providerId of getProviders()) {
    if (findEnvKeys(providerId)?.length || hasPiOAuthProvider(providerId)) {
      configuredProviders.add(providerId);
    }

    for (const model of getModelsByProvider(providerId)) {
      candidates.push(toModelEntry(model));
    }
  }

  const filtered = normalizedQuery
    ? candidates.filter(
        (model) =>
          model.providerId.toLowerCase().includes(normalizedQuery) ||
          model.modelId.toLowerCase().includes(normalizedQuery) ||
          model.name.toLowerCase().includes(normalizedQuery),
      )
    : candidates;

  const models = filtered
    .toSorted((a, b) => {
      const aConfigured = configuredProviders.has(a.providerId);
      const bConfigured = configuredProviders.has(b.providerId);
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
      return 0;
    })
    .slice(0, 50);

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

export function getCurrentFlueThinkingLevel(): ReasoningEffort {
  return getSelectedModel().thinkingLevel;
}
