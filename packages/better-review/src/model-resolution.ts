export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export interface ModelEntry {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ReasoningEffort[];
  variants: string[];
  releaseDate: string;
}
export interface ModelSelection {
  providerId: string;
  modelId: string;
  variant: string | null;
  thinkingLevel: ReasoningEffort;
}
export type SelectedModel = ModelEntry & { variant: string | null; thinkingLevel: ReasoningEffort };
export interface ResolvedReviewModel {
  model: { provider: string; modelId: string };
  thinkingLevel: ReasoningEffort;
}

const providerAliases = new Map<string, string>([
  ["vercel", "vercel-ai-gateway"],
  ["zai-coding-plan", "zai"],
]);
export function normalizeModelProviderId(providerId: string): string {
  return providerAliases.get(providerId) ?? providerId;
}
export function normalizeModelVariant(variant?: string | null): string | null {
  return typeof variant === "string" && variant.length > 0 ? variant : null;
}
export function normalizeThinkingLevel(
  model: ModelEntry,
  requested: ReasoningEffort,
): ReasoningEffort {
  if (model.thinkingLevels.includes(requested)) return requested;
  const requestedIndex = REASONING_EFFORTS.indexOf(requested);
  for (let index = requestedIndex; index < REASONING_EFFORTS.length; index++) {
    const candidate = REASONING_EFFORTS[index];
    if (model.thinkingLevels.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = REASONING_EFFORTS[index];
    if (model.thinkingLevels.includes(candidate)) return candidate;
  }
  return "off";
}

/** Facts only: resolution does not fetch, refresh credentials, or persist selection. */
export function createModelResolution(options: {
  catalog: { get(providerId: string, modelId: string): ModelEntry | null };
  credentials: {
    openAiApiKey(): boolean;
    oauth(providerId: string): boolean;
    available(providerId: string): boolean;
  };
  currentThinking?: () => ReasoningEffort | undefined;
}) {
  function route(model: ModelEntry, policy: "explicit" | "current"): ModelEntry {
    const missingOpenAiKey = model.providerId === "openai" && !options.credentials.openAiApiKey();
    const missingOpenCodeKey =
      model.providerId === "opencode" && !options.credentials.available("opencode");
    if (!missingOpenAiKey && !missingOpenCodeKey) return model;
    // Explicit OpenAI intent needs the legacy OAuth/stored-auth fact. Current
    // preference routing additionally accepts environment Codex credentials.
    const hasCodex =
      missingOpenAiKey && policy === "explicit"
        ? options.credentials.oauth("openai-codex")
        : options.credentials.available("openai-codex");
    const codex = hasCodex ? options.catalog.get("openai-codex", model.modelId) : null;
    if (codex) return codex;
    if (policy === "current") return model;
    if (missingOpenAiKey)
      throw new Error(
        `Model ${model.providerId}/${model.modelId} requires OPENAI_API_KEY. Select an openai-codex model or set OPENAI_API_KEY.`,
      );
    throw new Error(
      `Model ${model.providerId}/${model.modelId} requires OPENCODE_API_KEY. Select an authenticated provider or set OPENCODE_API_KEY.`,
    );
  }
  return {
    explicit(input: {
      providerId: string;
      modelId: string;
      variant?: string | null;
      thinkingLevel?: ReasoningEffort | null;
    }): SelectedModel {
      const model = options.catalog.get(normalizeModelProviderId(input.providerId), input.modelId);
      if (!model) throw new Error(`Model not found: ${input.providerId}/${input.modelId}`);
      const routed = route(model, "explicit");
      return {
        ...routed,
        variant: normalizeModelVariant(input.variant),
        thinkingLevel: normalizeThinkingLevel(
          routed,
          input.thinkingLevel ?? options.currentThinking?.() ?? DEFAULT_REASONING_EFFORT,
        ),
      };
    },
    current(selected: SelectedModel): ResolvedReviewModel {
      const routed = route(selected, "current");
      // Current thinking describes the selected preference, not the fallback's
      // supported levels. Do not renormalize it after routing.
      return {
        model: { provider: routed.providerId, modelId: routed.modelId },
        thinkingLevel: selected.thinkingLevel,
      };
    },
  };
}
