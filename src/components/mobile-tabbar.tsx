"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageSquare, Receipt, Wallet, Settings, Menu, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { useMobileNav } from "@/lib/mobile-nav";
import { useNotificationsBadge } from "@/lib/notifications-badge";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// MobileTabbar — bottom tab bar (brief §11 mobile).
//
// The four highest-traffic destinations get one-tap reachability on phones;
// "More" opens the full navigation drawer (shared state with the navbar
// hamburger via lib/mobile-nav.ts — the drawer itself renders in Navbar).
//
// Invariants:
//  - hidden ≥sm (desktop keeps the navbar links); z-30 keeps it UNDER the
//    nav drawer (z-40) and the command palette so overlays cover it.
//  - 44px minimum touch targets; label + icon so it survives without color.
//  - bottom offset respects the iOS home-indicator safe area (viewportFit
//    "cover" is set in layout.tsx so env() resolves on notched devices).
//  - "More" carries the active treatment when the current page is not one
//    of the four primary tabs (so /recurring & co. never look orphaned).
//  - HIDES when the on-screen keyboard opens (visualViewport height drops
//    ≥25% / 150px): a floating pill above the keyboard covers the composer
//    and reads as a bug. URL-bar shrink false positives stay under the
//    threshold (~10–15%). State changes only fire from the vv event
//    listeners (never synchronously in the effect body — cascading-render
//    rule); a keyboard can't be open at mount, so no initial probe needed.
// ─────────────────────────────────────────────────────────────────────────────

interface Tab {
  href: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

const TABS: Tab[] = [
  { href: "/", labelKey: "nav.chat", icon: MessageSquare },
  { href: "/payments", labelKey: "nav.payments", icon: Receipt },
  { href: "/wallet", labelKey: "nav.wallet", icon: Wallet },
  { href: "/settings", labelKey: "nav.settings", icon: Settings },
];

export function MobileTabbar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const drawerOpen = useMobileNav((s) => s.open);
  const toggleDrawer = useMobileNav((s) => s.toggle);
  // R17 (unread badge): the Notifications destination lives INSIDE the More
  // drawer on phones — a small primary dot on the Menu glyph says "something
  // new is one tap away" without stealing the label row. Hidden while the
  // drawer is open (the Notifications row inside carries the exact count).
  const unread = useNotificationsBadge((s) => s.unread);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onViewportChange = () => {
      const shrunk = window.innerHeight - vv.height > Math.max(150, window.innerHeight * 0.25);
      setKeyboardOpen(shrunk);
    };
    vv.addEventListener("resize", onViewportChange);
    vv.addEventListener("scroll", onViewportChange);
    return () => {
      vv.removeEventListener("resize", onViewportChange);
      vv.removeEventListener("scroll", onViewportChange);
    };
  }, []);

  const moreActive = !TABS.some((tab) => tab.href === pathname);

  return (
    <nav
      aria-label={t("nav.mobileTabs")}
      aria-hidden={keyboardOpen}
      className={cn(
        "fixed inset-x-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-30 transition-[transform,opacity] duration-300 ease-out sm:hidden",
        keyboardOpen && "pointer-events-none translate-y-[180%] opacity-0",
      )}
    >
      <div
        className="neumorphic flex items-stretch gap-1 px-2 py-1.5"
        style={{ borderRadius: 32 }}
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 py-1.5 transition-all duration-200",
                isActive
                  ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                  : "text-muted hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10",
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.4 : 2} />
              <span className="text-[10px] font-medium leading-none tracking-wide">
                {t(tab.labelKey)}
              </span>
            </Link>
          );
        })}
        {/* N7: the bottom bar's navigation control is the owner's "three
            line thingie" (Menu), not dots — page navigation lives here on
            Android. U2: while the drawer is open the icon flips to X and the
            button carries the open treatment — the tab stays OUT from under
            the drawer (the drawer ends above the bar), so this toggle is
            always reachable and reads as the close affordance it now is. */}
        <button
          type="button"
          onClick={toggleDrawer}
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          className={cn(
            "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 py-1.5 transition-all duration-200",
            moreActive || drawerOpen
              ? "bg-primary/15 text-primary ring-1 ring-primary/25"
              : "text-muted hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10",
          )}
        >
          {drawerOpen ? <X className="h-5 w-5" strokeWidth={2.4} /> : (
            <span className="relative">
              <Menu className="h-5 w-5" strokeWidth={moreActive ? 2.4 : 2} />
              {unread > 0 ? (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_0_1.5px_var(--neu-bg-color)]"
                />
              ) : null}
            </span>
          )}
          <span className="text-[10px] font-medium leading-none tracking-wide">
            {t("nav.more")}
          </span>
        </button>
      </div>
    </nav>
  );
}
