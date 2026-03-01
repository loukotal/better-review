import { splitProps, type JSX, type Component, type ParentProps } from "solid-js";

import { cn } from "./cn";

type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger";

interface BadgeProps extends ParentProps, JSX.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  neutral: "border-border text-text-faint bg-bg",
  accent: "border-accent/50 text-accent bg-accent/10",
  success: "border-success/50 text-success bg-success/10",
  warning: "border-warning/50 text-warning bg-warning/10",
  danger: "border-error/50 text-error bg-error/10",
};

export const Badge: Component<BadgeProps> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class", "children"]);

  return (
    <span
      class={cn(
        "inline-flex items-center px-1.5 py-0.5 text-xs border",
        variantClasses[local.variant ?? "neutral"],
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </span>
  );
};
