import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const CommentIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-8.5L2.5 14.5V12H1.75a.75.75 0 0 1-.75-.75v-8.5z" />
  </svg>
);
