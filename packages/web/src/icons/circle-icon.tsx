import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const CircleIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    class={props.class}
  >
    <circle cx="8" cy="8" r="5" />
  </svg>
);
