import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";

import { trpc } from "../lib/trpc";

interface ModelEntry {
  providerId: string;
  modelId: string;
}

interface ModelSelectorProps {
  disabled?: boolean;
}

export function ModelSelector(props: ModelSelectorProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<ModelEntry[]>([]);
  const [currentModel, setCurrentModel] = createSignal<ModelEntry | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);

  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Load current model on mount
  onMount(async () => {
    try {
      const data = await trpc.models.current.query();
      setCurrentModel(data);
    } catch (err) {
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
      await trpc.models.setCurrent.mutate(model);
      setCurrentModel(model);
      setIsOpen(false);
    } catch (err) {
      console.error("Failed to set model:", err);
    }
  };

  const displayText = () => {
    const model = currentModel();
    if (!model) return "Loading...";
    // Show shortened model name
    return model.modelId.length > 20 ? model.modelId.slice(0, 18) + "..." : model.modelId;
  };

  return (
    <div ref={containerRef} class="relative">
      {/* Current selection button */}
      <button
        type="button"
        onClick={handleOpen}
        disabled={props.disabled}
        class="flex items-center gap-1 px-1.5 py-0.5 text-xs border border-border text-text-muted hover:border-accent hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed max-w-35"
        title={
          currentModel() ? `${currentModel()!.providerId}/${currentModel()!.modelId}` : undefined
        }
      >
        <span class="truncate">{displayText()}</span>
        <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path
            fill-rule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      {/* Dropdown */}
      <Show when={isOpen()}>
        <div class="absolute top-full left-0 mt-1 w-72 bg-bg-surface border border-border shadow-lg z-50">
          {/* Search input */}
          <div class="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder="Search models..."
              class="w-full px-2 py-1 text-sm bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent"
            />
          </div>

          {/* Results list */}
          <div class="max-h-64 overflow-y-auto">
            <Show when={isLoading()}>
              <div class="px-3 py-2 text-sm text-text-faint">Searching...</div>
            </Show>

            <Show when={!isLoading() && searchResults().length === 0}>
              <div class="px-3 py-2 text-sm text-text-faint">No models found</div>
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
                    <span class="text-text-faint text-sm">{model.providerId}</span>
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
