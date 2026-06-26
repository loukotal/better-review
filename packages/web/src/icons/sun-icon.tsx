import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const SunIcon: Component<IconProps> = (props) => (
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
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.25V2.5" />
    <path d="M8 13.5v1.25" />
    <path d="m3.23 3.23.88.88" />
    <path d="m11.89 11.89.88.88" />
    <path d="M1.25 8H2.5" />
    <path d="M13.5 8h1.25" />
    <path d="m3.23 12.77.88-.88" />
    <path d="m11.89 4.11.88-.88" />
  </svg>
);
