import { splitProps, type JSX, type Component } from "solid-js";

import { cn } from "./cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "success-subtle";

type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-text hover:bg-primary-hover active:bg-primary font-medium",
  secondary:
    "border border-border bg-bg-surface text-text-muted hover:text-text hover:border-text-faint",
  ghost: "text-text-muted hover:text-text hover:bg-bg-elevated",
  danger: "border border-error/50 text-error hover:bg-error/10",
  success: "bg-success-solid text-white hover:bg-success-solid/85",
  "success-subtle": "bg-success/10 text-success border border-success/40",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "min-h-6 px-2 py-0.5 text-xs",
  sm: "min-h-7 px-2 py-1 text-xs",
  md: "min-h-8 px-3 py-1.5 text-sm",
  lg: "px-4 py-2 text-base",
  icon: "size-8 shrink-0 p-1.5 text-sm",
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "size", "fullWidth", "class"]);

  return (
    <button
      class={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md border border-transparent whitespace-nowrap font-sans transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        variantClasses[local.variant ?? "secondary"],
        sizeClasses[local.size ?? "md"],
        local.fullWidth && "w-full",
        local.class,
      )}
      {...rest}
    />
  );
};
