import type { Component } from "solid-js";

interface IconProps {
  size?: number;
  class?: string;
}

export const FileIcon: Component<IconProps> = (props) => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="currentColor"
    class={props.class}
  >
    <path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073H3.75zM2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-8.5A1.75 1.75 0 0 1 2 14.25V1.75z" />
  </svg>
);
