import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";

import { Button, TextInput, Select, Popover } from "../design-system";
import {
  cacheReviewModel,
  resolveReviewModelSelection,
  type ModelEntry,
  type SelectedModel,
} from "../lib/model-selection";
import { trpc } from "../lib/trpc";

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

interface ModelSelectorProps {
  align?: "left" | "right";
  class?: string;
  disabled?: boolean;
  onStateChange?: (state: {
    ready: boolean;
    error: string | null;
    model?: SelectedModel | null;
  }) => void;
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
  const [isResolving, setIsResolving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;

  createEffect(() =>
    props.onStateChange?.({
      ready: !!currentModel() && !isResolving() && !error(),
      error: error(),
      model: currentModel(),
    }),
  );
  onCleanup(() => {
    disposed = true;
    props.onStateChange?.({ ready: false, error: null });
  });

  function acceptModel(model: SelectedModel, persist = true) {
    if (disposed) return;
    if (persist) cacheReviewModel(model);
    setCurrentModel(model);
    setError(null);
  }

  function failed(cause: unknown) {
    if (disposed) return;
    setError(
      `${cause instanceof Error ? cause.message : "Cannot resolve review model"} Retry or choose a model. Reviews are blocked until resolved.`,
    );
  }

  async function resolveSelection() {
    if (isResolving()) return;
    setIsResolving(true);
    try {
      acceptModel(await resolveReviewModelSelection(), false);
    } catch (err) {
      failed(err);
    } finally {
      setIsResolving(false);
    }
  }
  onMount(() => void resolveSelection());

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

  const handleSelect = async (model: ModelEntry) => {
    if (isResolving()) return;
    setIsResolving(true);
    try {
      const selected = currentModel();
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingLevel: selected?.thinkingLevel,
      });
      acceptModel(result.model);
      setIsOpen(false);
    } catch (err) {
      failed(err);
    } finally {
      setIsResolving(false);
    }
  };

  const handleVariantChange = async (variant: string) => {
    const model = currentModel();
    if (!model || isResolving()) return;
    setIsResolving(true);

    try {
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        variant: variant || null,
        thinkingLevel: model.thinkingLevel,
      });
      acceptModel(result.model);
    } catch (err) {
      failed(err);
    } finally {
      setIsResolving(false);
    }
  };

  const handleReasoningEffortChange = async (thinkingLevel: ReasoningEffort) => {
    const model = currentModel();
    if (!model || isResolving()) return;
    setIsResolving(true);

    try {
      const result = await trpc.models.setCurrent.mutate({
        providerId: model.providerId,
        modelId: model.modelId,
        variant: model.variant,
        thinkingLevel,
      });
      acceptModel(result.model);
    } catch (err) {
      failed(err);
    } finally {
      setIsResolving(false);
    }
  };

  const displayText = () => {
    const model = currentModel();
    if (error()) return "Model unavailable";
    if (!model) return "Loading...";
    // Show shortened model name
    const label = model.variant ? `${model.modelId}:${model.variant}` : model.modelId;
    return label.length > 20 ? label.slice(0, 18) + "..." : label;
  };

  return (
    <div class={props.class}>
      <Popover
        label="Choose model"
        trigger={<span class="max-w-40 truncate">{displayText()}</span>}
        triggerSize="sm"
        width={340}
        align={props.align}
        disabled={props.disabled || isResolving()}
        open={isOpen()}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (open) setSearchQuery("");
        }}
      >
        {/* Search input */}
        <div class="p-2 border-b border-border">
          <TextInput
            size="sm"
            aria-label="Search models"
            autofocus
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
                    <Select
                      compact
                      value={model().variant ?? ""}
                      onChange={(e) => handleVariantChange(e.currentTarget.value)}
                      class="w-full px-2 py-1 text-sm bg-bg border border-border text-text"
                    >
                      <option value="">Default</option>
                      <For each={model().variants}>
                        {(variant) => <option value={variant}>{variant}</option>}
                      </For>
                    </Select>
                  </label>
                </Show>

                <Show when={model().reasoning}>
                  <label class="flex flex-col gap-1 text-text">
                    <span>Reasoning effort</span>
                    <Select
                      compact
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
                    </Select>
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
                <Button
                  variant="ghost"
                  aria-pressed={isSelected()}
                  type="button"
                  onClick={() => handleSelect(model)}
                  class="w-full items-start px-3 py-1.5 text-left text-sm hover:bg-bg-elevated transition-colors flex flex-col gap-0.5"
                  classList={{ "bg-bg-elevated": isSelected() }}
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
                </Button>
              );
            }}
          </For>
        </div>
      </Popover>
      <Show when={error()}>
        <p role="alert" class="text-xs text-error">
          {error()}
        </p>
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={isResolving() || props.disabled}
          onClick={() => void resolveSelection()}
        >
          Retry model selection
        </Button>
      </Show>
    </div>
  );
}
