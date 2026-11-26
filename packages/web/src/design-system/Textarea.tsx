import { createEffect, splitProps, type JSX, type Component } from "solid-js";

import { cn } from "./cn";

type TextareaIntent = "default" | "danger";

interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  intent?: TextareaIntent;
}

const intentClasses: Record<TextareaIntent, string> = {
  default: "border-border focus:border-accent",
  danger: "border-error/60 focus:border-error",
};

export const Textarea: Component<TextareaProps> = (props) => {
  const [local, rest] = splitProps(props, ["intent", "class", "ref", "autofocus"]);
  let element: HTMLTextAreaElement | undefined;
  let focused = false;
  // Native autofocus skips disabled fields; durable drafts keep editors disabled while loading.
  createEffect(() => {
    if (!local.autofocus || focused || rest.disabled || !element) return;
    focused = true;
    element.focus();
  });

  return (
    <textarea
      ref={(el) => {
        element = el;
        if (typeof local.ref === "function") local.ref(el);
      }}
      class={cn(
        "w-full bg-bg rounded-md border px-3 py-2 text-sm text-text placeholder:text-text-faint resize-y disabled:opacity-50",
        intentClasses[local.intent ?? "default"],
        local.class,
      )}
      aria-invalid={local.intent === "danger" || undefined}
      {...rest}
    />
  );
};
