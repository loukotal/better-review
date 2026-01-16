import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

/** Simple list order indicator (no outer box) */
export const ListOrderIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path d="M7 5.75A.75.75 0 0 1 7.75 5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 5.75zm0 4A.75.75 0 0 1 7.75 9h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 9.75zM3.5 6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM4.25 10a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0z" />
  </svg>
);

/** List order indicator with outer box */
export const ListOrderBoxIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75zM7 5.75A.75.75 0 0 1 7.75 5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 5.75zm0 4A.75.75 0 0 1 7.75 9h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 9.75zM3.5 6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM4.25 10a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0z" />
  </svg>
);
