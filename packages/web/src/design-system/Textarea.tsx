import { splitProps, type JSX, type Component } from "solid-js";

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
  const [local, rest] = splitProps(props, ["intent", "class"]);

  return (
    <textarea
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
