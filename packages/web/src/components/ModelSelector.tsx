import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";

import { ChevronDownFillIcon } from "../icons/chevron-down-icon";
import { trpc } from "../lib/trpc";

const MODEL_STORAGE_KEY = "better-review:selected-model";
const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

interface ModelEntry {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ReasoningEffort[];
  variants: string[];
  releaseDate: string;
}

interface SelectedModel extends ModelEntry {
  variant: string | null;
  thinkingLevel: ReasoningEffort;
}

interface ModelSelectorProps {
  align?: "left" | "right";
  class?: string;
  disabled?: boolean;
}

function loadSavedModel(): {
  providerId: string;
  modelId: string;
  variant?: string | null;
  thinkingLevel?: ReasoningEffort | null;
} | null {
  const stored = localStorage.getItem(MODEL_STORAGE_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as {
      providerId?: unknown;
      modelId?: unknown;
      variant?: unknown;
      thinkingLevel?: unknown;
    };
    if (typeof parsed.providerId === "string" && typeof parsed.modelId === "string") {
      return {
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        variant:
          typeof parsed.variant === "string" || parsed.variant === null
            ? parsed.variant
            : undefined,
        thinkingLevel: isReasoningEffort(parsed.thinkingLevel) ? parsed.thinkingLevel : undefined,
      };
    }
  } catch (err) {
    console.error("Failed to parse saved model:", err);
  }

  localStorage.removeItem(MODEL_STORAGE_KEY);
  return null;
}

function saveModel(model: SelectedModel) {
  localStorage.setItem(
    MODEL_STORAGE_KEY,
    JSON.stringify({
      providerId: model.providerId,
      modelId: model.modelId,
      variant: model.variant,
      thinkingLevel: model.thinkingLevel,
    }),
  );
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function reasoningEffortOptions(model: SelectedModel): ReasoningEffort[] {
  return model.thinkingLevels.length > 0 ? model.thinkingLevels : ["off"];
}

export function ModelSelector(props: ModelSelectorProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<ModelEntry[]>([]);
  const [connectedProvidersCount, setConnectedProvidersCount] = createSignal<number | null>(null);
  const [currentModel, setCurrentModel] = createSignal<SelectedModel | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);

  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Load current model on mount
  onMount(async () => {
    const savedModel = loadSavedModel();

    try {
      if (savedModel) {
        const result = await trpc.models.setCurrent.mutate(savedModel);
        setCurrentModel(result.model);
        saveModel(result.model);
        return;
      }

      const data = await trpc.models.current.query();
      setCurrentModel(data);
      saveModel(data);
    } catch (err) {
      if (savedModel) {
        localStorage.removeItem(MODEL_STORAGE_KEY);
        try {
          const data = await trpc.models.current.query();
          setCurrentModel(data);
          saveModel(data);
          return;
        } catch (fallbackErr) {
          console.error("Failed to load current model:", fallbackErr);
          return;
        }
      }

      console.error("Failed to load current model:", err);
    }
  });

  // Search models when query changes
  createEffect(async () => {
    const query = searchQuery();

    if (!isOpen()) return;

    setIsLoading(true);
    try {
      const data = await trpc.models.search.query({ q: query });
      setSearchResults(data.models || []);
      setConnectedProvidersCount(data.connectedProvidersCount ?? null);
    } catch (err) {
      console.error("Failed to search models:", err);
    } finally {
      setIsLoading(false);
    }
  });

  // Close dropdown when clicking outside
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  const handleOpen = () => {
    if (props.disabled) return;
    setIsOpen(true);
    setSearchQuery("");
    // Focus input after opening
    setTimeout(() => inputRef?.focus(), 10);
  };

  const handleSelect = async (model: ModelEntry) => {
    try {
      const selected = currentModel();
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingLevel: selected?.thinkingLevel,
      });
      setCurrentModel(result.model);
      saveModel(result.model);
      setIsOpen(false);
    } catch (err) {
      console.error("Failed to set model:", err);
    }
  };

  const handleVariantChange = async (variant: string) => {
    const model = currentModel();
    if (!model) return;

    try {
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        variant: variant || null,
        thinkingLevel: model.thinkingLevel,
      });
      setCurrentModel(result.model);
      saveModel(result.model);
    } catch (err) {
      console.error("Failed to update model variant:", err);
    }
  };

  const handleReasoningEffortChange = async (thinkingLevel: ReasoningEffort) => {
    const model = currentModel();
    if (!model) return;

    try {
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        variant: model.variant,
        thinkingLevel,
      });
      setCurrentModel(result.model);
      saveModel(result.model);
    } catch (err) {
      console.error("Failed to update reasoning effort:", err);
    }
  };

  const displayText = () => {
    const model = currentModel();
    if (!model) return "Loading...";
    // Show shortened model name
    const label = model.variant ? `${model.modelId}:${model.variant}` : model.modelId;
    return label.length > 20 ? label.slice(0, 18) + "..." : label;
  };

  return (
    <div ref={(el) => (containerRef = el)} class={`relative ${props.class ?? ""}`}>
      {/* Current selection button */}
      <button
        type="button"
        onClick={handleOpen}
        disabled={props.disabled}
        class="flex items-center gap-1 px-1.5 py-0.5 text-xs border border-border text-text-muted hover:border-accent hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed max-w-35"
        title={
          currentModel()
            ? `${currentModel()!.providerId}/${currentModel()!.modelId} • reasoning: ${
                REASONING_EFFORT_LABELS[currentModel()!.thinkingLevel]
              }`
            : undefined
        }
      >
        <span class="truncate">{displayText()}</span>
        <ChevronDownFillIcon size={10} class="shrink-0" />
      </button>

      {/* Dropdown */}
      <Show when={isOpen()}>
        <div
          class="absolute top-full mt-1 w-80 max-w-[calc(100vw-1rem)] bg-bg-surface border border-border shadow-lg z-50"
          classList={{
            "left-0": props.align !== "right",
            "right-0": props.align === "right",
          }}
        >
          {/* Search input */}
          <div class="p-2 border-b border-border">
            <input
              ref={(el) => (inputRef = el)}
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder="Search models..."
              class="w-full px-2 py-1 text-sm bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent"
            />

            <Show when={currentModel()}>
              {(model) => (
                <div class="mt-2 space-y-2 text-xs">
                  <div
                    class="text-text-faint truncate"
                    title={`${model().providerId}/${model().modelId}`}
                  >
                    {model().providerId}/{model().modelId}
                  </div>

                  <Show when={model().variants.length > 0}>
                    <label class="flex flex-col gap-1 text-text">
                      <span>Variant</span>
                      <select
                        value={model().variant ?? ""}
                        onChange={(e) => handleVariantChange(e.currentTarget.value)}
                        class="w-full px-2 py-1 text-sm bg-bg border border-border text-text"
                      >
                        <option value="">Default</option>
                        <For each={model().variants}>
                          {(variant) => <option value={variant}>{variant}</option>}
                        </For>
                      </select>
                    </label>
                  </Show>

                  <Show when={model().reasoning}>
                    <label class="flex flex-col gap-1 text-text">
                      <span>Reasoning effort</span>
                      <select
                        value={model().thinkingLevel}
                        onChange={(e) =>
                          handleReasoningEffortChange(e.currentTarget.value as ReasoningEffort)
                        }
                        class="w-full px-2 py-1 text-sm bg-bg border border-border text-text"
                      >
                        <For each={reasoningEffortOptions(model())}>
                          {(effort) => (
                            <option value={effort}>{REASONING_EFFORT_LABELS[effort]}</option>
                          )}
                        </For>
                      </select>
                    </label>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          {/* Results list */}
          <div class="max-h-64 overflow-y-auto">
            <Show when={isLoading()}>
              <div class="px-3 py-2 text-sm text-text-faint">Searching...</div>
            </Show>

            <Show when={!isLoading() && searchResults().length === 0}>
              <div class="px-3 py-2 text-sm text-text-faint">
                {connectedProvidersCount() === 0 ? "No providers connected" : "No models found"}
              </div>
            </Show>

            <For each={searchResults()}>
              {(model) => {
                const isSelected = () =>
                  currentModel()?.providerId === model.providerId &&
                  currentModel()?.modelId === model.modelId;

                return (
                  <button
                    type="button"
                    onClick={() => handleSelect(model)}
                    class="w-full px-3 py-1.5 text-left text-sm hover:bg-bg-elevated transition-colors flex flex-col gap-0.5"
                    classList={{ "bg-accent/10": isSelected() }}
                  >
                    <span class="text-text font-medium truncate">{model.modelId}</span>
                    <span class="text-text-faint text-xs">{model.providerId}</span>
                    <Show when={model.variants.length > 0 || model.reasoning}>
                      <span class="text-[11px] text-text-faint truncate">
                        {[
                          model.reasoning ? "reasoning" : null,
                          model.variants.length > 0 ? `${model.variants.length} variants` : null,
                        ]
                          .filter(Boolean)
                          .join(" • ")}
                      </span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
