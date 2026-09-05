import { For, type JSX } from "solid-js";

import { Button } from "./Button";

export function SegmentedControl<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: JSX.Element; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-bg p-0.5"
    >
      <For each={props.options}>
        {(option) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={props.value === option.value}
            disabled={props.disabled || option.disabled}
            class={
              props.value === option.value ? "bg-bg-elevated text-text font-medium" : undefined
            }
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </Button>
        )}
      </For>
    </div>
  );
}
