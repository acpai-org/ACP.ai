import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CardProps {
  children: ReactNode;
  className?: string;
  glass?: boolean;
}

export function Card({ children, className, glass = true }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl p-5 text-foreground",
        glass
          ? "glass-panel"
          : "border border-border bg-surface/60 shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: CardProps) {
  return (
    <div className={cn("mb-4 flex items-center justify-between", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: CardProps) {
  return (
    <h2 className={cn("text-sm font-semibold text-foreground", className)}>
      {children}
    </h2>
  );
}

export function CardBody({ children, className }: CardProps) {
  return <div className={cn("space-y-3", className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  sublabel,
  icon,
  iconClassName,
  className,
}: {
  label: string;
  // widened from `string` so callers can compose inline status marks
  // (dot + label) without wrapping tricks; every existing call site passes
  // a plain string, which remains valid.
  value: ReactNode;
  sublabel?: string;
  icon?: ReactNode;
  /** Per-tile accent tint for the icon (e.g. "text-success" on the attested tile).
   *  Overrides the default muted→primary hover transition. */
  iconClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass-item group rounded-2xl p-5 transition-all duration-300",
        "hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)]",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">{label}</p>
        {icon ? (
          <div
            className={cn(
              // S11-c (round-6 styling, VLM-guided): default icon contrast
              // bumped one step (muted-2 → muted) — the stat-card icons read
              // as "very faint" in dark mode otherwise.
              "text-muted transition-colors duration-300",
              iconClassName ? "group-hover:brightness-110" : "group-hover:text-primary",
              iconClassName,
            )}
          >
            {icon}
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-xs text-muted-2">{sublabel}</p>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  iconTileClassName,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Optional accent for the icon tile (e.g. "bg-success/10 text-success ring-1 ring-inset ring-success/20"). */
  iconTileClassName?: string;
}) {
  return (
    <div className="glass-panel flex flex-col items-center justify-center gap-3 py-16 text-center">
      {icon ? (
        <div
          className={cn(
            // R25: the default tile was bg-surface-2/text-muted-2 — nearly
            // invisible against the glass panel (live VLM review). Now a
            // primary-tinted tile with an inset ring + top highlight so the
            // empty state anchors the card visually instead of dissolving.
            "flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/[0.07] text-primary/80 ring-1 ring-inset ring-primary/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]",
            iconTileClassName,
          )}
        >
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mt-1 text-xs text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
