import { For, Show, createSignal, type Component } from "solid-js";

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
          <svg 
            width="12" 
            height="12" 
            viewBox="0 0 16 16" 
            fill="currentColor"
            class="text-accent"
          >
            <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75zM7 5.75A.75.75 0 0 1 7.75 5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 5.75zm0 4A.75.75 0 0 1 7.75 9h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 9.75zM3.5 6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM4.25 10a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0z"/>
          </svg>
          <span class="text-[11px] font-medium text-accent">
            Suggested Review Order
          </span>
          <span class="text-[10px] text-text-faint">
            ({props.files.length} files)
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview())}
            class="text-[10px] text-text-faint hover:text-text transition-colors"
          >
            {showPreview() ? "Hide" : "Preview"}
          </button>
          <Show when={orderDiffers()}>
            <button
              type="button"
              onClick={() => props.onApplyOrder(props.files)}
              class="text-[10px] px-2 py-0.5 bg-accent text-black hover:bg-accent-bright transition-colors"
            >
              Apply Order
            </button>
          </Show>
          <Show when={!orderDiffers()}>
            <span class="text-[10px] text-success">Applied</span>
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
                  <span class="text-[10px] text-text-faint w-4">
                    {index() + 1}.
                  </span>
                  <span class="text-[10px] text-text-faint truncate">
                    {dirPath(file)}
                  </span>
                  <span class="text-[11px] text-text-muted group-hover:text-text truncate">
                    {fileName(file)}
                  </span>
                  <Show when={change !== null && change !== 0}>
                    <span class={`text-[9px] ml-auto ${change! > 0 ? 'text-success' : 'text-error'}`}>
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
        <div class="px-2.5 py-1.5 text-[10px] text-text-faint">
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
