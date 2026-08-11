import type { Component } from "solid-js";

import { Button } from "../design-system";

export type DiffViewMode = "original" | "reading";

interface DiffViewToggleProps {
  mode: DiffViewMode;
  onModeChange: (mode: DiffViewMode) => void;
  disabled?: boolean;
}

export const DiffViewToggle: Component<DiffViewToggleProps> = (props) => (
  <div class="flex items-center text-sm" role="group" aria-label="Diff view">
    <Button
      type="button"
      onClick={() => props.onModeChange("original")}
      disabled={props.disabled}
      variant={props.mode === "original" ? "primary" : "secondary"}
      size="sm"
      aria-pressed={props.mode === "original"}
    >
      Original
    </Button>
    <Button
      type="button"
      onClick={() => props.onModeChange("reading")}
      disabled={props.disabled}
      variant={props.mode === "reading" ? "primary" : "secondary"}
      size="sm"
      class="border-l-0"
      aria-pressed={props.mode === "reading"}
    >
      Reading
    </Button>
  </div>
);
