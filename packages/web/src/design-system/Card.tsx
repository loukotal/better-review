import { splitProps, type JSX, type Component, type ParentProps } from "solid-js";

import { cn } from "./cn";

type CardVariant = "subtle" | "raised" | "outline";
type CardPadding = "sm" | "md";

interface CardProps extends ParentProps, JSX.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  interactive?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  subtle: "border-border bg-bg",
  raised: "border-border bg-bg shadow-sm",
  outline: "border-border/80 bg-bg-surface/50",
};

const paddingClasses: Record<CardPadding, string> = {
  sm: "p-2",
  md: "p-3",
};

export const Card: Component<CardProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "variant",
    "padding",
    "interactive",
    "class",
    "children",
  ]);

  return (
    <div
      class={cn(
        "border transition-all duration-150",
        variantClasses[local.variant ?? "subtle"],
        paddingClasses[local.padding ?? "md"],
        local.interactive && "hover:border-accent/60 hover:bg-bg-surface hover:-translate-y-[1px]",
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  );
};
