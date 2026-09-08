"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Keyboard, X } from "lucide-react";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { SHORTCUTS_OPEN_EVENT } from "@/lib/palette-events";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// ShortcutsHelp — the `?` overlay: a quick reference for every keyboard
// shortcut that actually exists in the app (each row was verified against the
// live keydown handlers — chat-input.tsx, command-palette.tsx — not from
// memory). Opens with `?` (Shift+/) anywhere typing is not already happening,
// or from the composer's keyboard button (the touch path — phones have no `?`
// key in reach). Escape and backdrop click close it.
// ─────────────────────────────────────────────────────────────────────────────

interface ShortcutRow {
  keys: string[];
  labelKey: TranslationKey;
}

const SECTIONS: Array<{ titleKey: TranslationKey; rows: ShortcutRow[] }> = [
  {
    titleKey: "shortcuts.everywhere",
    rows: [
      { keys: ["⌘", "K"], labelKey: "shortcuts.palette" },
      { keys: ["?"], labelKey: "shortcuts.help" },
      { keys: ["Esc"], labelKey: "shortcuts.escape" },
    ],
  },
  {
    titleKey: "shortcuts.chat",
    rows: [
      { keys: ["Enter"], labelKey: "shortcuts.send" },
      { keys: ["Shift", "Enter"], labelKey: "shortcuts.newline" },
      { keys: ["/"], labelKey: "shortcuts.slash" },
      { keys: ["@"], labelKey: "shortcuts.mention" },
      { keys: ["⌫"], labelKey: "shortcuts.chipRemove" },
    ],
  },
  {
    titleKey: "shortcuts.menus",
    rows: [
      { keys: ["↑", "↓"], labelKey: "shortcuts.navigate" },
      { keys: ["Enter", "Tab"], labelKey: "shortcuts.select" },
      { keys: ["Esc"], labelKey: "shortcuts.menuDismiss" },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0 font-mono text-[10.5px] font-medium leading-5 text-muted-2 shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.06)]">
      {children}
    </kbd>
  );
}

export function ShortcutsHelp() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // The element that held focus before the overlay opened — restored on close
  // so keyboard users land back where they came from.
  const restoreRef = useRef<HTMLElement | null>(null);

  const openDialog = useCallback(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) {
        // `?` = Shift+/ on every common layout. Never steal it from a text
        // field (the palette input, the composer, search boxes) or during IME
        // composition — typing a question must keep typing a question.
        if (e.key !== "?") return;
        const el = e.target instanceof HTMLElement ? e.target : null;
        const tag = el?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
        if (e.isComposing) return;
        e.preventDefault();
        openDialog();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    // Touch path: surfaces without a `?` key (the composer's keyboard button)
    // dispatch SHORTCUTS_OPEN_EVENT, exactly like the palette's open bridge.
    const onOpenEvent = () => openDialog();
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_OPEN_EVENT, onOpenEvent);
    };
  }, [open, openDialog]);

  // Focus the close button when the dialog opens; restore the prior focus
  // when it fully unmounts.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const restore = restoreRef.current;
    return () => {
      restore?.focus?.();
    };
  }, [open]);

  let rowIdx = 0;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[80] flex items-center justify-center px-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("shortcuts.title")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden />

          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="glass-panel relative flex w-full max-w-md flex-col overflow-hidden !rounded-3xl !p-0"
          >
            {/* Header */}
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                <Keyboard className="h-4 w-4 text-primary" aria-hidden />
              </span>
              <h2 className="flex-1 text-[15px] font-semibold tracking-tight text-foreground">{t("shortcuts.title")}</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-2 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                aria-label={t("shortcuts.closeDialog")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Sections */}
            <div className="acp-scroll max-h-[64vh] overflow-y-auto px-4 py-3">
              {SECTIONS.map((section) => (
                <div key={section.titleKey} className="mb-4 last:mb-1">
                  <p
                    aria-hidden
                    className="mb-1.5 px-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-2"
                  >
                    {t(section.titleKey)}
                  </p>
                  <ul className="space-y-0.5">
                    {section.rows.map((row) => {
                      const i = rowIdx++;
                      return (
                        <motion.li
                          key={row.labelKey}
                          initial={{ opacity: 0, x: -4 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.05 + Math.min(i * 0.025, 0.25), duration: 0.22, ease: "easeOut" }}
                          className={cn(
                            "flex items-center justify-between gap-4 rounded-lg px-1.5 py-1.5",
                            i % 2 === 1 && "bg-foreground/[0.025]",
                          )}
                        >
                          <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted">{t(row.labelKey)}</span>
                          <span className="flex shrink-0 items-center gap-1">
                            {row.keys.map((k, ki) => (
                              <Kbd key={k + String(ki)}>{k}</Kbd>
                            ))}
                          </span>
                        </motion.li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>

            {/* Footer — the discovery loop: how you got here, one line */}
            <div className="border-t border-border px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-3">
                <Kbd>?</Kbd>
                <span>{t("shortcuts.footerHint")}</span>
              </p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
