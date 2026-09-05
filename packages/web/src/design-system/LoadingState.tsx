import { For } from "solid-js";
export function LoadingState(props: { label: string }) {
  return (
    <div role="status" class="mx-auto w-full max-w-3xl px-4 py-8">
      <p class="mb-5 text-sm text-text-muted">{props.label}</p>
      <div aria-hidden="true" class="space-y-3 animate-pulse">
        <For each={["w-3/4", "w-full", "w-5/6"]}>
          {(width) => <div class={`h-8 rounded bg-bg-elevated ${width}`} />}
        </For>
      </div>
    </div>
  );
}
