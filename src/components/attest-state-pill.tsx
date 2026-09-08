"use client";

import { memo } from "react";
import {
  ShieldCheck,
  ShieldQuestion,
  ShieldAlert,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Attestcoin attestation state pill.
//
// One visual language for attestation state across the app: the payments page
// attestation card, the chat intent card footer, and future surfaces all
// render the same pill (icon + label + semantic color) for
// loading / proof / pending / unknown_tx / error.
// ─────────────────────────────────────────────────────────────────────────────

export type AttestPillState =
  | "loading"
  | "proof"
  | "pending"
  | "unknown_tx"
  | "error";

interface PillConfig {
  icon: LucideIcon;
  cls: string;
  spin: boolean;
  labelKey:
    | "payments.attestVerifying"
    | "payments.attestVerified"
    | "payments.attestPending"
    | "payments.attestUnknownTx"
    | "payments.attestError";
}

const PILL_CONFIG: Record<AttestPillState, PillConfig> = {
  loading: { icon: Loader2, cls: "border-primary/30 bg-primary/10 text-primary shadow-[0_0_0_1px_rgba(34,211,238,0.12)]", spin: true, labelKey: "payments.attestVerifying" },
  proof: { icon: ShieldCheck, cls: "border-success/30 bg-success/10 text-success shadow-[0_0_12px_-4px_rgba(74,222,128,0.5)]", spin: false, labelKey: "payments.attestVerified" },
  pending: { icon: ShieldQuestion, cls: "border-warning/30 bg-warning/10 text-warning", spin: false, labelKey: "payments.attestPending" },
  unknown_tx: { icon: ShieldAlert, cls: "border-warning/30 bg-warning/10 text-warning", spin: false, labelKey: "payments.attestUnknownTx" },
  error: { icon: ShieldAlert, cls: "border-danger/30 bg-danger/10 text-danger", spin: false, labelKey: "payments.attestError" },
};

export const AttestStatePill = memo(function AttestStatePill({
  state,
  size = "sm",
}: {
  state: AttestPillState;
  size?: "sm" | "xs";
}) {
  const { t } = useI18n();
  const cfg = PILL_CONFIG[state];

  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        size === "xs" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]",
        cfg.cls,
      )}
    >
      <Icon className={cn(size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3", cfg.spin && "animate-spin")} />
      {t(cfg.labelKey)}
    </span>
  );
});
