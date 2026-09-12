"use client";

import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        // S11-a (round-6 styling, VLM-guided): the OFF track was bg-surface-3 —
        // nearly invisible against the card in dark mode, leaving a white knob
        // "floating in a void" (read as a rendering bug). A foreground-tinted
        // track + inset ring keeps the pill legible in both themes.
        checked ? "bg-primary" : "bg-foreground/10 ring-1 ring-inset ring-foreground/25",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-out",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}
