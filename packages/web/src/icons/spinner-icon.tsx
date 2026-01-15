import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const SpinnerIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path d="M8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" opacity="0.3" />
    <path d="M8 0a8 8 0 0 1 8 8h-2a6 6 0 0 0-6-6V0z" />
  </svg>
);
