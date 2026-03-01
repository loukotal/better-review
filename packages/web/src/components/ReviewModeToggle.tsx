import type { Component } from "solid-js";

import { Button } from "../design-system";
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
      <Button
        type="button"
        onClick={() => props.onModeChange("full")}
        disabled={props.disabled}
        variant="secondary"
        size="sm"
        class={
          props.mode === "full"
            ? "bg-accent text-black border-accent hover:text-black hover:border-accent"
            : "text-text-muted hover:bg-bg-surface"
        }
      >
        Full PR
      </Button>
      <Button
        type="button"
        onClick={() => props.onModeChange("commit")}
        disabled={props.disabled || props.commitCount === 0}
        variant="secondary"
        size="sm"
        class={`border-l-0 ${
          props.mode === "commit"
            ? "bg-accent text-black border-accent hover:text-black hover:border-accent"
            : "text-text-muted hover:bg-bg-surface"
        }`}
      >
        By Commit ({props.commitCount})
      </Button>
    </div>
  );
};
