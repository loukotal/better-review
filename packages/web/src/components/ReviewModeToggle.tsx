import type { Component } from "solid-js";

import { SegmentedControl } from "../design-system";
import type { ReviewMode } from "../diff/types";
interface ReviewModeToggleProps {
  mode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  commitCount: number;
  disabled?: boolean;
}
export const ReviewModeToggle: Component<ReviewModeToggleProps> = (props) => (
  <SegmentedControl
    label="Review scope"
    value={props.mode}
    onChange={props.onModeChange}
    disabled={props.disabled}
    options={[
      { value: "full", label: "Full PR" },
      {
        value: "commit",
        label: `By commit (${props.commitCount})`,
        disabled: props.commitCount === 0,
      },
    ]}
  />
);
