import { Show, type JSX } from "solid-js";
export function EmptyState(props: {
  title: string;
  description?: string;
  children?: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <div class="mx-auto max-w-lg px-4 py-12 text-center">
      <h2 class="text-base font-medium text-text">{props.title}</h2>
      <Show when={props.description}>
        <p class="mt-2 text-sm leading-6 text-text-muted">{props.description}</p>
      </Show>
      <Show when={props.children}>
        <div class="mt-3 text-sm text-text-muted">{props.children}</div>
      </Show>
      <Show when={props.actions}>
        <div class="mt-4 flex flex-wrap justify-center gap-2">{props.actions}</div>
      </Show>
    </div>
  );
}
