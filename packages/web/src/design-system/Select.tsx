import { splitProps, type JSX, type Component } from "solid-js";

import { cn } from "./cn";

interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  compact?: boolean;
}

export const Select: Component<SelectProps> = (props) => {
  const [local, rest] = splitProps(props, ["compact", "class"]);

  return (
    <select
      class={cn(
        "bg-bg border border-border text-text font-mono cursor-pointer focus:border-accent disabled:opacity-50",
        local.compact ? "px-2 py-1 text-sm" : "px-3 py-2 text-sm",
        local.class,
      )}
      {...rest}
    />
  );
};
