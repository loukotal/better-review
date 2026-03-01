import { splitProps, type JSX, type Component } from "solid-js";

import { cn } from "./cn";

type InputIntent = "default" | "danger";
type InputSize = "sm" | "md";

interface TextInputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  intent?: InputIntent;
  size?: InputSize;
}

const intentClasses: Record<InputIntent, string> = {
  default: "border-border hover:border-text-faint focus:border-accent",
  danger: "border-error/60 focus:border-error",
};

const sizeClasses: Record<InputSize, string> = {
  sm: "px-2 py-1 text-sm",
  md: "px-3 py-2 text-sm",
};

export const TextInput: Component<TextInputProps> = (props) => {
  const [local, rest] = splitProps(props, ["intent", "size", "class"]);

  return (
    <input
      class={cn(
        "w-full bg-bg border text-text placeholder:text-text-faint disabled:opacity-50",
        intentClasses[local.intent ?? "default"],
        sizeClasses[local.size ?? "md"],
        local.class,
      )}
      {...rest}
    />
  );
};
