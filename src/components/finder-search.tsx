"use client";

import { useState, useRef, useEffect } from "react";
import { Search, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// FinderSearch (C17): the neumorphic finder search bar — adapted from the
// owner's reference design (Appendix A.2) into the project's token system,
// theme-correct in both directions (the reference is the light version; dark
// inverts the shadow direction per the neumorphism system). Mechanics kept:
// focus activates the icon; submit enters the processing/spinner state and
// briefly disables the input; the icon animates between states.
// ─────────────────────────────────────────────────────────────────────────────

export function FinderSearch({
  value,
  onChange,
  onSubmit,
  placeholder,
  className,
  ariaLabel,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Optional submit handler — enables the processing state on Enter. */
  onSubmit?: () => void | Promise<void>;
  placeholder?: string;
  className?: string;
  ariaLabel: string;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);
  const [processing, setProcessing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // "/" focuses the finder when nothing else holds the keyboard (the chat
  // composer has its own "/" palette — that surface handles its own key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || value) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [value]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!onSubmit || processing) return;
    setProcessing(true);
    try {
      await onSubmit();
    } finally {
      setProcessing(false);
    }
  };

  const clear = () => {
    onChange("");
    inputRef.current?.focus();
  };

  return (
    <form
      role="search"
      onSubmit={handleSubmit}
      className={cn("neumorphic-inset flex items-center gap-2.5 rounded-2xl px-3.5 py-2 transition-shadow duration-300", className)}
      aria-label={ariaLabel}
    >
      <span
        aria-hidden
        className={cn(
          "relative flex h-5 w-5 shrink-0 items-center justify-center transition-all duration-300",
          processing && "animate-spin",
          focused ? "text-primary" : "text-muted-2",
        )}
      >
        {processing ? <Loader2 className="h-4 w-4" /> : <Search className="h-4 w-4" />}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={processing}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-3 focus:outline-none disabled:opacity-60"
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          className="shrink-0 rounded-md px-1.5 text-[10px] font-semibold text-muted-2 transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label={t("finder.clear")}
        >
          ✕
        </button>
      ) : (
        <kbd className="hidden shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[9px] font-semibold text-muted-3 sm:inline-block">
          /
        </kbd>
      )}
    </form>
  );
}
