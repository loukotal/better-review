import { type JSX, Show } from "solid-js";

import { cn } from "./cn";
export function PanelHeader(props: { title: string; actions?: JSX.Element; class?: string }) {
  return (
    <div
      class={cn(
        "flex min-h-11 items-center justify-between gap-3 border-b border-border px-3 py-2",
        props.class,
      )}
    >
      <h2 class="min-w-0 truncate text-sm font-medium text-text">{props.title}</h2>
      <Show when={props.actions}>
        <div class="flex shrink-0 items-center gap-1">{props.actions}</div>
      </Show>
    </div>
  );
}
