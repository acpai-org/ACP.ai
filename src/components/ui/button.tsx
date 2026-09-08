"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "glass" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary: cn(
    "bg-primary text-primary-foreground hover:bg-primary-hover",
    "shadow-[0_4px_14px_-2px_rgba(8,145,178,0.5),inset_0_1px_0_rgba(255,255,255,0.2)]",
    "active:shadow-[0_2px_8px_-1px_rgba(8,145,178,0.4)]",
  ),
  glass: cn(
    "glass-btn text-white hover:brightness-110",
  ),
  secondary:
    "glass-tight text-foreground hover:border-primary/30 hover:bg-foreground/5 active:scale-[0.98]",
  ghost:
    "text-muted hover:text-foreground hover:bg-foreground/5 hover:border-border-strong border border-transparent active:scale-[0.98]",
  danger:
    "bg-danger text-white hover:opacity-90 active:scale-[0.98] shadow-[0_4px_14px_-2px_rgba(248,113,113,0.4)]",
  success:
    "bg-success text-white hover:opacity-90 active:scale-[0.98] shadow-[0_4px_14px_-2px_rgba(74,222,128,0.4)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "primary", size = "md", ...props },
    ref,
  ) {
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.97 }}
        className={cn(
          "inline-flex items-center justify-center rounded-xl font-medium",
          "transition-all duration-200 ease-out cursor-pointer select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...(props as React.ComponentProps<typeof motion.button>)}
      />
    );
  },
);
