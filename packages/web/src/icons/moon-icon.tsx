import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const MoonIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.5"
    class={props.class}
  >
    <path d="M13.4 10.4A5.7 5.7 0 0 1 5.6 2.6 5.7 5.7 0 1 0 13.4 10.4Z" />
  </svg>
);
