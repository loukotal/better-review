import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";

import {
  createModelResolution,
  DEFAULT_REASONING_EFFORT,
  normalizeModelProviderId,
  normalizeModelVariant,
  normalizeThinkingLevel,
  REASONING_EFFORTS,
  type ModelEntry,
  type ModelSelection,
  type ReasoningEffort,
  type SelectedModel,
  type ResolvedReviewModel,
} from "./model-resolution";
import { catalogProviders } from "./review/pi-catalog";
import { hasPiOAuthProvider } from "./review/providers";

export { REASONING_EFFORTS } from "./model-resolution";
export type {
  ModelEntry,
  ModelSelection,
  ReasoningEffort,
  SelectedModel,
} from "./model-resolution";

// Defaults follow the catalog: the newest Sol, else the newest Opus. Variants (-pro, -fast,
// dated snapshots) never qualify.
const SOL_MODEL = /^gpt-(\d+)(?:\.(\d+))?-sol$/;
const OPUS_MODEL = /^claude-opus-(\d+)(?:-(\d+))?$/;

function newestModel(providerId: string, pattern: RegExp): Model<Api> | undefined {
  let newest: { model: Model<Api>; major: number; minor: number } | undefined;
  for (const model of getModelsByProvider(providerId)) {
    const match = pattern.exec(model.id);
    if (!match) continue;
    const major = Number(match[1]),
      minor = Number(match[2] ?? 0);
    if (!newest || major > newest.major || (major === newest.major && minor > newest.minor))
      newest = { model, major, minor };
  }
  return newest?.model;
}
const configuredDefaultModel = process.env.BETTER_REVIEW_MODEL?.trim();
const selectionPath =
  process.env.BETTER_REVIEW_MODEL_SELECTION_PATH ??
  path.join(homedir(), ".local", "share", "better-review", "model-selection.json");

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

const modelCatalog = createModels();
for (const provider of catalogProviders()) modelCatalog.setProvider(provider);
const getModelById = (provider: string, modelId: string): Model<Api> | undefined =>
  modelCatalog.getModel(provider, modelId);
const getModelsByProvider = (provider: string): readonly Model<Api>[] =>
  modelCatalog.getModels(provider);
const getProviderIds = (): string[] => modelCatalog.getProviders().map((provider) => provider.id);

function isReasoningEffort(value: ModelThinkingLevel): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function parseReviewModel(model: string): ModelSelection | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;

  const providerId = normalizeModelProviderId(model.slice(0, slash));
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
  const normalizedProviderId = normalizeModelProviderId(providerId);
  const model = getModelById(normalizedProviderId, modelId);
  return model ? toModelEntry(model) : null;
}

function toSelectedModel(
  model: ModelEntry,
  variant: string | null,
  thinkingLevel: ReasoningEffort,
): SelectedModel {
  return { ...model, variant, thinkingLevel: normalizeThinkingLevel(model, thinkingLevel) };
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

  // Prefer native OpenAI auth (API key or ChatGPT sign-in). Legacy Codex-only
  // setups keep their own provider rather than masquerading as OpenAI.
  const openAiProvider = hasProviderCredentials("openai")
    ? "openai"
    : hasProviderCredentials("openai-codex")
      ? "openai-codex"
      : null;
  if (openAiProvider) {
    const sol = newestModel(openAiProvider, SOL_MODEL);
    if (sol) return toSelectedModel(toModelEntry(sol), null, DEFAULT_REASONING_EFFORT);
  }

  const opus = newestModel("anthropic", OPUS_MODEL);
  if (opus) return toSelectedModel(toModelEntry(opus), null, DEFAULT_REASONING_EFFORT);

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

  const variant = normalizeModelVariant(currentModel.variant);
  const thinkingLevel = normalizeThinkingLevel(model, currentModel.thinkingLevel);
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

const modelResolution = createModelResolution({
  catalog: { get: getModelEntry },
  credentials: {
    available: hasProviderCredentials,
  },
  currentThinking: () => currentModel?.thinkingLevel,
});

/** Validate/reroute the requested ID without changing the server's selected model. */
export function resolveSelectedModel(input: {
  providerId: string;
  modelId: string;
  variant?: string | null;
  thinkingLevel?: ReasoningEffort | null;
}): SelectedModel {
  return modelResolution.explicit(input);
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

export function resolveCurrentReviewModel(): ResolvedReviewModel {
  return modelResolution.current(getSelectedModel());
}

export function getCurrentReviewModel(): string {
  const { model } = resolveCurrentReviewModel();
  return `${model.provider}/${model.modelId}`;
}

export function getCurrentReviewThinkingLevel(): ReasoningEffort {
  return getSelectedModel().thinkingLevel;
}
