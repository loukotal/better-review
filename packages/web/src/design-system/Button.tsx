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
  primary: "bg-primary text-text hover:bg-primary-hover active:bg-primary",
  secondary: "border border-border text-text-faint hover:text-text hover:border-text-faint",
  ghost: "text-text-faint hover:text-text",
  danger: "border border-error/50 text-error hover:bg-error/10",
  success: "bg-green-600 text-white hover:bg-green-500",
  "success-subtle": "bg-green-600/20 text-green-400 border border-green-600/50",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "px-1.5 py-0.5 text-xs",
  sm: "px-2 py-1 text-sm",
  md: "px-3 py-1.5 text-sm",
  lg: "px-4 py-2 text-base",
  icon: "p-1.5 text-sm",
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "size", "fullWidth", "class"]);

  return (
    <button
      class={cn(
        "inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        variantClasses[local.variant ?? "secondary"],
        sizeClasses[local.size ?? "md"],
        local.fullWidth && "w-full",
        local.class,
      )}
      {...rest}
    />
  );
};
