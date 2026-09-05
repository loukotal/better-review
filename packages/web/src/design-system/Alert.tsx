import { Show, type JSX } from "solid-js";

import { cn } from "./cn";
const styles = {
  danger: "border-error/40 bg-error/5",
  warning: "border-warning/40 bg-warning/5",
  info: "border-info/40 bg-info/5",
  success: "border-success/40 bg-success/5",
};
export function Alert(props: {
  intent?: keyof typeof styles;
  title?: string;
  children?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
}) {
  return (
    <div
      role={props.intent === "danger" ? "alert" : "status"}
      class={cn(
        "rounded-md border px-3 py-2.5 text-sm text-text",
        styles[props.intent ?? "info"],
        props.class,
      )}
    >
      <Show when={props.title}>
        <p class="m-0 font-medium">{props.title}</p>
      </Show>
      <Show when={props.children}>
        <div class={props.title ? "mt-1 text-text-muted leading-5" : "leading-5"}>
          {props.children}
        </div>
      </Show>
      <Show when={props.actions}>
        <div class="mt-3 flex flex-wrap gap-2">{props.actions}</div>
      </Show>
    </div>
  );
}
