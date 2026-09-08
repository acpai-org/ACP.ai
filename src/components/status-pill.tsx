"use client";

import { motion } from "motion/react";
import type { PaymentStatus } from "@/lib/types";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<
  PaymentStatus,
  { label: string; color: string; bg: string; icon?: "spinner" | "check" | "alert" }
> = {
  parsing: { label: "Understanding", color: "text-primary", bg: "bg-primary/10" },
  clarifying: { label: "Need more info", color: "text-warning", bg: "bg-warning/10" },
  reviewing: { label: "Awaiting confirmation", color: "text-primary", bg: "bg-primary/10" },
  signing: { label: "Sign in wallet", color: "text-warning", bg: "bg-warning/10", icon: "spinner" },
  settling: { label: "Sending", color: "text-warning", bg: "bg-warning/10", icon: "spinner" },
  settled: { label: "Paid", color: "text-success", bg: "bg-success/10", icon: "check" },
  failed: { label: "Failed", color: "text-danger", bg: "bg-danger/10", icon: "alert" },
  pending: { label: "Recorded", color: "text-warning", bg: "bg-warning/10" },
  approving: { label: "Approving", color: "text-warning", bg: "bg-warning/10", icon: "spinner" },
  deploying: { label: "Deploying", color: "text-warning", bg: "bg-warning/10", icon: "spinner" },
  sent: { label: "Sent · verifying", color: "text-primary", bg: "bg-primary/10", icon: "spinner" },
};

export function StatusPill({ status }: { status: PaymentStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        config.color,
        config.bg,
      )}
    >
      {config.icon === "spinner" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : config.icon === "check" ? (
        <Check className="h-3.5 w-3.5" />
      ) : config.icon === "alert" ? (
        <AlertCircle className="h-3.5 w-3.5" />
      ) : (
        <span className={cn("h-2 w-2 rounded-full", config.color.replace("text-", "bg-"))} aria-hidden="true" />
      )}
      {config.label}
    </motion.span>
  );
}
