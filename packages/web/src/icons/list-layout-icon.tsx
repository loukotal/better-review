import { Show } from "solid-js";

import type { PrListLayout } from "../lib/pr-list-layout";

export function ListLayoutIcon(props: { layout: PrListLayout; size?: number; class?: string }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="14" height="14" rx="1.5" />
      <Show when={props.layout === "table"} fallback={<path d="M6 6.5h8M6 9h5M6 12h8M6 14.5h5" />}>
        <path d="M3 8h14M3 12h14M8 3v14" />
      </Show>
    </svg>
  );
}
