import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

/** Stroke-based chevron down icon */
export const ChevronDownIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path
      d="M4.5 5.5L8 9l3.5-3.5"
      stroke="currentColor"
      stroke-width="1.5"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

/** Fill-based chevron down icon (larger viewBox variant) */
export const ChevronDownFillIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 20 20"
    fill="currentColor"
    class={props.class}
  >
    <path
      fill-rule="evenodd"
      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
      clip-rule="evenodd"
    />
  </svg>
);

/** Stroke-based chevron down icon (24x24 viewBox variant) */
export const ChevronDownLargeIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    class={props.class}
  >
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
  </svg>
);
