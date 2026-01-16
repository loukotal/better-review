import { For, Show, createSignal, type Component } from "solid-js";

import { ListOrderBoxIcon } from "../icons/list-order-icon";

interface ReviewOrderPanelProps {
  files: string[];
  currentFiles: string[];
  onApplyOrder: (files: string[]) => void;
  onFileClick: (file: string) => void;
}

/**
 * Shows the AI-suggested file review order with preview and apply button
 */
export const ReviewOrderPanel: Component<ReviewOrderPanelProps> = (props) => {
  const [showPreview, setShowPreview] = createSignal(false);

  const fileName = (path: string) => {
    const parts = path.split("/");
    return parts[parts.length - 1];
  };

  const dirPath = (path: string) => {
    const parts = path.split("/");
    if (parts.length > 1) {
      return parts.slice(0, -1).join("/") + "/";
    }
    return "";
  };

  // Check if current order differs from suggested
  const orderDiffers = () => {
    if (props.files.length !== props.currentFiles.length) return true;
    for (let i = 0; i < props.files.length; i++) {
      if (props.files[i] !== props.currentFiles[i]) return true;
    }
    return false;
  };

  // Find position changes for preview
  const getPositionChange = (file: string): number | null => {
    const currentIdx = props.currentFiles.indexOf(file);
    const newIdx = props.files.indexOf(file);
    if (currentIdx === -1 || newIdx === -1) return null;
    return currentIdx - newIdx; // positive = moved up, negative = moved down
  };

  return (
    <div class="my-2 border border-accent/30 bg-accent/5">
      {/* Header */}
      <div class="flex items-center justify-between px-2.5 py-2 border-b border-accent/20">
        <div class="flex items-center gap-2">
          <ListOrderBoxIcon size={12} class="text-accent" />
          <span class="text-xs font-medium text-accent">Suggested Review Order</span>
          <span class="text-xs text-text-faint">({props.files.length} files)</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview())}
            class="text-xs text-text-faint hover:text-text transition-colors"
          >
            {showPreview() ? "Hide" : "Preview"}
          </button>
          <Show when={orderDiffers()}>
            <button
              type="button"
              onClick={() => props.onApplyOrder(props.files)}
              class="text-xs px-2 py-0.5 bg-accent text-black hover:bg-accent-bright transition-colors"
            >
              Apply Order
            </button>
          </Show>
          <Show when={!orderDiffers()}>
            <span class="text-xs text-success">Applied</span>
          </Show>
        </div>
      </div>

      {/* File list preview */}
      <Show when={showPreview()}>
        <div class="max-h-48 overflow-y-auto">
          <For each={props.files}>
            {(file, index) => {
              const change = getPositionChange(file);
              return (
                <button
                  type="button"
                  onClick={() => props.onFileClick(file)}
                  class="w-full flex items-center gap-2 px-2.5 py-1 text-left hover:bg-accent/10 transition-colors group"
                >
                  <span class="text-xs text-text-faint w-4">{index() + 1}.</span>
                  <span class="text-xs text-text-faint truncate">{dirPath(file)}</span>
                  <span class="text-xs text-text-muted group-hover:text-text truncate">
                    {fileName(file)}
                  </span>
                  <Show when={change !== null && change !== 0}>
                    <span
                      class={`text-[9px] ml-auto ${change! > 0 ? "text-success" : "text-error"}`}
                    >
                      {change! > 0 ? `+${change}` : change}
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Collapsed summary */}
      <Show when={!showPreview()}>
        <div class="px-2.5 py-1.5 text-xs text-text-faint">
          <For each={props.files.slice(0, 3)}>
            {(file, index) => (
              <>
                <button
                  type="button"
                  onClick={() => props.onFileClick(file)}
                  class="hover:text-accent transition-colors"
                >
                  {fileName(file)}
                </button>
                {index() < Math.min(props.files.length - 1, 2) && <span class="mx-1">→</span>}
              </>
            )}
          </For>
          <Show when={props.files.length > 3}>
            <span class="ml-1">... +{props.files.length - 3} more</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};
