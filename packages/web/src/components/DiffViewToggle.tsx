import type { Component } from "solid-js";

import { SegmentedControl } from "../design-system";
export type DiffViewMode = "original" | "reading";
interface DiffViewToggleProps {
  mode: DiffViewMode;
  onModeChange: (mode: DiffViewMode) => void;
  disabled?: boolean;
}
export const DiffViewToggle: Component<DiffViewToggleProps> = (props) => (
  <SegmentedControl
    label="Diff view"
    value={props.mode}
    onChange={props.onModeChange}
    disabled={props.disabled}
    options={[
      { value: "original", label: "Diff" },
      { value: "reading", label: "Reading" },
    ]}
  />
);
