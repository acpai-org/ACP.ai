"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand";
import { useI18n } from "@/lib/i18n";
import { useInstallBanner } from "@/lib/install-banner-store";

// ─────────────────────────────────────────────────────────────────────────────
// InstallBanner (brief §11 — installable app): surfaces the browser's deferred
// install prompt (Chrome/Edge/Android) or, on iOS Safari (which never fires
// beforeinstallprompt), a one-time "Share → Add to Home Screen" hint.
//
// Invariants:
//  - NEVER renders in standalone mode (already installed) or within 14 days
//    of an explicit dismissal (localStorage timestamp cooldown — the native
//    prompt APIs forbid nagging, and so do we).
//  - The deferred event is preventDefault()ed and stashed in a ref, so the
//    banner's Install button is the ONLY thing that can trigger the browser
//    sheet (browser policy: prompt() requires a user gesture).
//  - Sits above the mobile tab bar (bottom offset matches main's tabbar
//    padding) and at the bottom of the desktop layout; z-30 keeps it under
//    the nav drawer (z-40) and command palette.
//  - iOS state flips only from the timeout / event listener callbacks (never
//    synchronously in the effect body — cascading-render lint rule).
// ─────────────────────────────────────────────────────────────────────────────

const DISMISS_KEY = "acp:install-dismissed";
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS browsers never fire beforeinstallprompt; installs go through Share. */
function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Dismissed within the cooldown window? (reads fresh — Chrome refires.) */
function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw != null && !Number.isNaN(Number(raw)) && Date.now() - Number(raw) < COOLDOWN_MS;
  } catch {
    return false;
  }
}

export function InstallBanner() {
  const { t } = useI18n();
  const [reason, setReason] = useState<null | "prompt" | "ios">(null);
  const [installing, setInstalling] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  // D7/N6: publish visibility so the frame's <main> can add clearance —
  // the mobile banner floats exactly over the chat composer band otherwise.
  const setVisible = useInstallBanner((s) => s.setVisible);
  useEffect(() => {
    setVisible(reason !== null);
  }, [reason, setVisible]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage unavailable — session-only dismissal is still fine */
    }
    setReason(null);
  };

  useEffect(() => {
    if (isStandalone()) return;
    if (recentlyDismissed()) return;

    // Chrome re-fires beforeinstallprompt over time (navigation, engagement
    // heuristics) — re-check the cooldown per event so an early dismissal
    // actually sticks for the full window. preventDefault ALWAYS runs: the
    // native mini-infobar stays suppressed either way.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      promptRef.current = e as BeforeInstallPromptEvent;
      if (!recentlyDismissed()) setReason("prompt");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS hint appears after a short beat (letting the page settle first) and
    // only if the native prompt path hasn't already shown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIOS()) {
      timer = setTimeout(() => setReason((r) => (r === null ? "ios" : r)), 1600);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  const install = async () => {
    const ev = promptRef.current;
    if (!ev || installing) return;
    setInstalling(true);
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      if (choice.outcome === "accepted") {
        // Installed (or on its way) — stop asking.
        try {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
        setReason(null);
      }
    } catch {
      /* the native sheet was closed — keep the banner, user can retry */
    }
    setInstalling(false);
  };

  return (
    <AnimatePresence>
      {reason !== null ? (
        <motion.section
          aria-label={t("install.title")}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="fixed inset-x-4 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-30 sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-[24rem] sm:-translate-x-1/2"
        >
          {/* S12-g (round-7 styling, VLM-guided): the floating banner read as
              flat against the page in dark mode — the neumorphic panel
              shadows alone don't define an edge. A resting inset ring + a
              deeper drop shadow lift it off the page (same recipe as the
              chat composer, S10-a). */}
          <div className="glass-panel flex items-center gap-3 rounded-2xl p-3.5 shadow-[0_18px_44px_-16px_rgba(0,0,0,0.65)] ring-1 ring-inset ring-foreground/[0.08]">
            {/* U1: tight-cropped mark (was a square chip wrapping the padded
                1024² asset — the glyph inside read ~7px tall). The wordmark
                now renders edge-to-edge at a legible height. */}
            <BrandMark className="h-7" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">{t("install.title")}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                {reason === "ios" ? t("install.iosBody") : t("install.body")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {reason === "prompt" ? (
                <Button onClick={install} size="sm" disabled={installing} aria-label={t("install.action")}>
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">{t("install.action")}</span>
                </Button>
              ) : null}
              <Button
                onClick={dismiss}
                size="sm"
                variant="ghost"
                className="h-8 w-8 px-0"
                aria-label={t("install.later")}
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
