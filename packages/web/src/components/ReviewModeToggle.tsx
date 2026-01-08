import type { Component } from "solid-js";

import type { ReviewMode } from "../diff/types";

interface ReviewModeToggleProps {
  mode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  commitCount: number;
  disabled?: boolean;
}

export const ReviewModeToggle: Component<ReviewModeToggleProps> = (props) => {
  return (
    <div class="flex items-center text-sm">
      <button
        type="button"
        onClick={() => props.onModeChange("full")}
        disabled={props.disabled}
        class="px-2 py-1 transition-colors border border-border disabled:opacity-50"
        classList={{
          "bg-accent text-black border-accent": props.mode === "full",
          "text-text-muted hover:text-text hover:bg-bg-surface": props.mode !== "full",
        }}
      >
        Full PR
      </button>
      <button
        type="button"
        onClick={() => props.onModeChange("commit")}
        disabled={props.disabled || props.commitCount === 0}
        class="px-2 py-1 transition-colors border border-border border-l-0 disabled:opacity-50"
        classList={{
          "bg-accent text-black border-accent": props.mode === "commit",
          "text-text-muted hover:text-text hover:bg-bg-surface": props.mode !== "commit",
        }}
      >
        By Commit ({props.commitCount})
      </button>
    </div>
  );
};
