import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { hasPiOAuthProvider } from "./review/providers";

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

const FALLBACK_REVIEW_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
const configuredDefaultModel = process.env.BETTER_REVIEW_MODEL?.trim();
const selectionPath =
  process.env.BETTER_REVIEW_MODEL_SELECTION_PATH ??
  path.join(homedir(), ".local", "share", "better-review", "model-selection.json");

const providerAliases = new Map<string, string>([
  ["vercel", "vercel-ai-gateway"],
  ["zai-coding-plan", "zai"],
]);

let currentModel: ModelSelection | undefined;
let explicitSelection = false;

function readSavedSelection(): ModelSelection | undefined {
  let text: string;
  try {
    text = readFileSync(selectionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Cannot read saved review model. Select a model again or check file permissions.",
      {
        cause: error,
      },
    );
  }
  try {
    const saved = JSON.parse(text) as ModelSelection;
    if (
      !saved ||
      typeof saved.providerId !== "string" ||
      typeof saved.modelId !== "string" ||
      !(saved.variant === null || typeof saved.variant === "string") ||
      !REASONING_EFFORTS.includes(saved.thinkingLevel)
    )
      throw new Error("Invalid selection");
    return saved;
  } catch (error) {
    throw new Error("Saved review model is invalid. Select a model again.", { cause: error });
  }
}

function saveSelection(selection: ModelSelection) {
  mkdirSync(path.dirname(selectionPath), { recursive: true });
  const temporary = `${selectionPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(selection), { mode: 0o600 });
    renameSync(temporary, selectionPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const modelCatalog = builtinModels();
const getModelById = (provider: string, modelId: string): Model<Api> | undefined =>
  modelCatalog.getModel(provider, modelId);
const getModelsByProvider = (provider: string): readonly Model<Api>[] =>
  modelCatalog.getModels(provider);
const getProviderIds = (): string[] => modelCatalog.getProviders().map((provider) => provider.id);

function isReasoningEffort(value: ModelThinkingLevel): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function normalizeProviderId(providerId: string): string {
  return providerAliases.get(providerId) ?? providerId;
}

function parseReviewModel(model: string): ModelSelection | null {
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

function hasProviderCredentials(providerId: string): boolean {
  return Boolean(findEnvKeys(providerId)?.length || hasPiOAuthProvider(providerId));
}

export function getModelEntry(providerId: string, modelId: string): ModelEntry | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  const model = getModelById(normalizedProviderId, modelId);
  return model ? toModelEntry(model) : null;
}

function resolveVariant(_model: ModelEntry, input: { variant?: string | null }): string | null {
  // Pi model IDs are selected directly; thinking level is configured separately.
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
  const configured = configuredDefaultModel ? parseReviewModel(configuredDefaultModel) : null;

  if (configured) {
    const model = getModelEntry(configured.providerId, configured.modelId);
    if (model) return toSelectedModel(model, configured.variant, configured.thinkingLevel);
  }
  if (configuredDefaultModel) {
    throw new Error(
      `Configured review model ${configuredDefaultModel} is unavailable. Fix BETTER_REVIEW_MODEL or select a model.`,
    );
  }

  // Local dev usually has Pi's ChatGPT/Codex OAuth but no Anthropic token. Prefer
  // the UI-visible OpenAI model; getCurrentReviewModel() will route it to
  // openai-codex when needed.
  if (hasPiOAuthProvider("openai-codex") && !process.env.OPENAI_API_KEY) {
    const openAiModel = getModelEntry("openai", "gpt-5.5");
    if (openAiModel) return toSelectedModel(openAiModel, null, DEFAULT_REASONING_EFFORT);
  }

  const fallback = parseReviewModel(FALLBACK_REVIEW_MODEL);
  if (fallback) {
    const model = getModelEntry(fallback.providerId, fallback.modelId);
    if (model) return toSelectedModel(model, fallback.variant, fallback.thinkingLevel);
  }

  const firstProvider = getProviderIds()[0];
  const firstModel = firstProvider ? getModelsByProvider(firstProvider)[0] : undefined;
  if (!firstModel) {
    throw new Error("No review models are available");
  }

  return toSelectedModel(toModelEntry(firstModel), null, DEFAULT_REASONING_EFFORT);
}

export function getSelectedModel(): SelectedModel {
  if (!currentModel) {
    currentModel = readSavedSelection();
    explicitSelection = !!currentModel;
  }
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
    throw new Error(
      `Selected review model ${currentModel.providerId}/${currentModel.modelId} is unavailable. Select a model again.`,
    );
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
  const model = resolveSelectedModel(input);
  const selection: ModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
    variant: model.variant,
    thinkingLevel: model.thinkingLevel,
  };
  saveSelection(selection);
  currentModel = selection;
  explicitSelection = true;
  return model;
}

/** Validate/reroute the requested ID without changing the server's selected model. */
export function resolveSelectedModel(input: {
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

  if (model.providerId === "opencode" && !hasProviderCredentials("opencode")) {
    const codexModel = hasProviderCredentials("openai-codex")
      ? getModelEntry("openai-codex", model.modelId)
      : null;
    if (!codexModel) {
      throw new Error(
        `Model ${model.providerId}/${model.modelId} requires OPENCODE_API_KEY. Select an authenticated provider or set OPENCODE_API_KEY.`,
      );
    }
    model = codexModel;
  }

  const variant = resolveVariant(model, { variant: input.variant });
  const thinkingLevel = resolveThinkingLevel(model, { thinkingLevel: input.thinkingLevel });
  return toSelectedModel(model, variant, thinkingLevel);
}

/** Browser storage is a one-time migration source, never a replacement for saved server intent. */
export function restoreSelectedModel(input: Parameters<typeof setSelectedModel>[0]): SelectedModel {
  const selected = getSelectedModel();
  return explicitSelection ? selected : setSelectedModel(input);
}

export function getModelSelectionState() {
  const selected = getSelectedModel();
  return {
    ...selected,
    selectionSource: explicitSelection ? ("saved" as const) : ("default" as const),
  };
}

export function searchModels(query: string): {
  models: ModelEntry[];
  connectedProvidersCount: number;
} {
  const normalizedQuery = query.toLowerCase().trim();
  const configuredProviders = new Set<string>();
  const candidates: ModelEntry[] = [];

  for (const providerId of getProviderIds()) {
    if (hasProviderCredentials(providerId)) {
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

export function getCurrentReviewModel(): string {
  const selected = getSelectedModel();

  // `openai/*` is API-key auth. If the user is logged in through Pi's ChatGPT/Codex
  // OAuth, use Pi's `openai-codex/*` provider for the same model ID instead.
  if (
    selected.providerId === "openai" &&
    !process.env.OPENAI_API_KEY &&
    hasProviderCredentials("openai-codex") &&
    getModelEntry("openai-codex", selected.modelId)
  ) {
    return `openai-codex/${selected.modelId}`;
  }

  if (
    selected.providerId === "opencode" &&
    !hasProviderCredentials("opencode") &&
    hasProviderCredentials("openai-codex") &&
    getModelEntry("openai-codex", selected.modelId)
  ) {
    return `openai-codex/${selected.modelId}`;
  }

  return `${selected.providerId}/${selected.modelId}`;
}

export function getCurrentReviewThinkingLevel(): ReasoningEffort {
  return getSelectedModel().thinkingLevel;
}
