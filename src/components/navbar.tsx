"use client";

import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { X, Menu } from "lucide-react";
import { ALL_NAV_ITEMS } from "@/lib/nav";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { BrandMarkOnly } from "@/components/brand";
import { useMobileNav } from "@/lib/mobile-nav";
import { useChatsNav } from "@/lib/chats-nav";
import { useNotificationsBadge } from "@/lib/notifications-badge";
import { cn } from "@/lib/utils";

const WalletButton = dynamic(
  () => import("@/components/wallet-button").then((m) => m.WalletButton),
  { ssr: false },
);

const ChainSwitcher = dynamic(
  () => import("@/components/chain-switcher").then((m) => m.ChainSwitcher),
  { ssr: false },
);

const LanguageSelector = dynamic(
  () => import("@/components/language-selector").then((m) => m.LanguageSelector),
  { ssr: false },
);

const ThemeToggle = dynamic(
  () => import("@/components/theme-toggle").then((m) => m.ThemeToggle),
  { ssr: false },
);

const NAV_LINKS = ALL_NAV_ITEMS.filter((i) =>
  ["Chat", "Actions", "Recurring", "Contacts", "Wallet", "Settings"].includes(i.label),
);

// ─────────────────────────────────────────────────────────────────────────────
// Navbar (P1/N5/N7/C19):
//   ANDROID (<sm): top bar = brand mark + the CHATS control, NOTHING else —
//     page navigation lives in the bottom navbar ("More" three-line thingie).
//   TABLET (sm–xl): brand mark + the three-line menu selector at the FAR
//     LEFT (immediately behind the logo, P1) + language/theme, chain +
//     wallet right.
//   DESKTOP (xl+): ONE capsule, horizontally CENTERED (N5): brand mark +
//     links + language + theme. It shrinks itself as the viewport narrows so
//     it never overlaps the top-right cluster.
// The right capsule (chain + wallet) stays OUTSIDE the navbar, top-right.
// P1: the navbar shows the logo mark ONLY — no "ACP.ai" text.
// ─────────────────────────────────────────────────────────────────────────────

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const menuOpen = useMobileNav((s) => s.open);
  const toggleMenu = useMobileNav((s) => s.toggle);
  const closeMenu = useMobileNav((s) => s.setOpen);
  const chatsOpen = useChatsNav((s) => s.open);
  const setChatsOpen = useChatsNav((s) => s.setOpen);
  // R17 (unread badge): the drawer's Notifications row carries the live
  // unread count (store shared with the tabbar More dot + the page itself).
  const unread = useNotificationsBadge((s) => s.unread);
  const { t } = useI18n();

  const navLabelKey: Record<string, TranslationKey> = {
    Chat: "nav.chat",
    Actions: "nav.payments",
    Recurring: "nav.recurring",
    Contacts: "nav.contacts",
    Wallet: "nav.wallet",
    Settings: "nav.settings",
    Notifications: "nav.notifications",
    Security: "nav.security",
  };

  function navLabel(label: string): string {
    const key = navLabelKey[label];
    return key ? t(key) : label;
  }

  /** The CHATS control (N7): on the chat page it toggles the sessions
   *  sidebar; elsewhere it goes to the chat page and opens it. */
  function handleChatsToggle() {
    if (pathname !== "/") {
      setChatsOpen(true);
      router.push("/");
    } else {
      setChatsOpen(!chatsOpen);
    }
  }

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  // N11 (Escape contract): every overlay closes on Escape — this drawer
  // previously had no close affordance while open (the bottom-bar toggle
  // sits UNDER it).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, closeMenu]);

  // U2: leaving via ANY route change (drawer link, bottom-tab link, browser
  // back) closes the drawer — it must never linger over a page the user
  // navigated to from under it.
  useEffect(() => {
    if (menuOpen) closeMenu(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <>
      {/* ── Main capsule: brand + nav + language + theme.
           Android (<sm): brand + CHATS control only (N7).
           Tablet (sm–lg): brand + lang/theme + nav hamburger.
           Desktop (xl+): CENTERED (N5) — clamped so it never runs under the
             top-right cluster; true viewport-center from 1920px (plain CSS —
             see navbar-true-center) where the budget allows. Self-shrink
             ladder: xl shows ICON-ONLY links (narrow zone shared with the
             cluster), 2xl+ adds labels back (room to breathe). */}
      <div
        className={cn(
          "fixed top-3 z-50 sm:top-4",
          "left-4 sm:left-6",
          // xl: the container spans [left-margin, cluster-zone]; the capsule
          // centers itself inside it (mx-auto on the w-fit nav) — overlap-proof
          // by construction.
          // ≥1920px (navbar-true-center, plain unlayered CSS in globals.css —
          // custom-breakpoint variants lose the cascade to smaller standard
          // breakpoints in the emitted sheet): TRUE viewport centering; the
          // U1 logo is ~98px wider than the old square mark, so the old 2xl
          // breakpoint no longer cleared the cluster (measured 34px of
          // overlap at 1600px before this fix).
          "xl:right-[26rem]",
          "navbar-true-center",
        )}
      >
        <nav
          className="neumorphic flex w-fit items-center gap-1.5 px-3 py-2.5 sm:gap-2 sm:px-4 xl:mx-auto 2xl:gap-3"
          style={{ borderRadius: 44 }}
          aria-label={t("nav.mainNav")}
        >
          <Link href="/" className="flex shrink-0" aria-label={t("nav.home")}>
            {/* P1: logo only — the ACP.ai wordmark is removed from the navbar.
                U1 (owner request): MUCH bigger mark — the tight-cropped mark
                (brand.tsx) renders edge-to-edge: 40px tall on phones
                (~121px wide), 48px on sm+ (~146px). The navbar capsule is
                60px mobile / 68px sm+; every surface that clears the fixed
                navbar was rebalanced (page-container, route-skeleton,
                chat-view columns, this drawer's pt). */}
            <BrandMarkOnly className="h-10 sm:h-12" />
          </Link>

          {/* P1: the three-line menu selector sits at the FAR LEFT of the
              navbar, immediately BEHIND (after) the logo — visible where the
              nav links are collapsed to the drawer (tablet sm–xl). Android's
              top bar stays brand + CHATS only (N7 — navigation lives in the
              bottom bar there); 2xl+ has the centered links. */}
          <div className="hidden items-center gap-1 sm:flex xl:hidden">
            <button
              type="button"
              onClick={toggleMenu}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={menuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>

          {/* xl–2xl: icon-only links (self-shrink zone). 2xl+: labeled links. */}
          <div className="hidden items-center gap-0.5 xl:flex">
            {NAV_LINKS.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={navLabel(item.label)}
                  title={navLabel(item.label)}
                  className={cn(
                    "relative rounded-2xl px-2.5 py-1.5 font-medium transition-all duration-200 2xl:px-3.5",
                    isActive
                      ? "bg-primary/15 ring-1 ring-primary/25"
                      : "hover:bg-foreground/5",
                  )}
                >
                  <span className="hidden 2xl:inline text-sm tracking-wide">
                    {navLabel(item.label)}
                  </span>
                  <Icon
                    className={cn(
                      "h-4 w-4 2xl:hidden",
                      isActive ? "text-foreground" : "text-muted",
                    )}
                  />
                  {isActive ? (
                    <span
                      aria-hidden
                      className="absolute inset-x-3 -bottom-[1px] h-[2px] rounded-full bg-gradient-to-r from-primary/0 via-primary to-primary/0"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>

          <div className="hidden items-center gap-1 sm:flex">
            {/* Owner request: flag ONLY in the navbar — the language label
                next to the flag was taking too much horizontal space in the
                capsule (the full name stays discoverable via the button
                title/aria-label + dropdown). */}
            <LanguageSelector />
            <ThemeToggle />
          </div>

          {/* CHATS control — Android's only top-bar control (N7): the
              owner's "three line thingie for CHATS". */}
          <button
            type="button"
            onClick={handleChatsToggle}
            aria-label={chatsOpen ? t("chat.closeSidebar") : t("chat.openSidebar")}
            aria-expanded={chatsOpen}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-foreground/10 hover:text-foreground sm:hidden",
              chatsOpen && "bg-foreground/10 text-foreground",
            )}
          >
            {chatsOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </nav>
      </div>

      {/* ── Right capsule: chain + wallet (top-right corner, outside navbar).
           Hidden on Android (N7) — connect/chain live in the bottom-bar
           drawer and on the Wallet page there. */}
      <div className="fixed right-4 top-3 z-50 hidden sm:right-6 sm:top-4 sm:flex">
        {/* py-3.5 balances the taller logo capsule (68px vs 60px) so the two
            top corners read as one system. */}
        <div className="neumorphic flex items-center gap-2 px-2.5 py-3.5" style={{ borderRadius: 44 }}>
          <div className="hidden sm:block">
            {/* plain (flat) inside the neumorphic capsule — C13: no stacked
                shadows; non-compact renders the active chain NAME (C14). */}
            <ChainSwitcher plain />
          </div>
          <WalletButton />
        </div>
      </div>

      {/* ── Mobile nav drawer (bottom-bar "More" / tablet hamburger) ─────── */}
      {/* U2 (owner bug): on Android the drawer used to cover the WHOLE
          viewport (inset-0) — the bottom tabbar (z-30) sat under it, so the
          "More" toggle that opened it was unreachable and there was no way
          out on a touch device (Escape needs a keyboard; the backdrop gutter
          is a hidden affordance). The drawer now ENDS above the tabbar
          (bottom-[calc(4.5rem+env(safe-area-inset-bottom))], tabbar top edge
          is 4.25rem+safe) so the bar — with its More/X toggle — stays visible
          and clickable while the sheet is open. Tablet (sm+) has no tabbar:
          full-height drawer there (sm:bottom-0), closed via the navbar X.
          Because the bar below stays interactive, this is honestly a
          NON-modal sheet → aria-modal removed (role=dialog kept). */}
      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => closeMenu(false)}
            role="dialog"
            aria-label={t("nav.openMenu")}
            className="fixed inset-x-0 top-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] sm:inset-0 z-40 flex flex-col bg-[var(--overlay-bg)] backdrop-blur-2xl px-6 pt-28 overflow-y-auto"
          >
            {/* Clicks on nav rows / control rows stop propagation — everything
                else (the backdrop) closes the drawer. */}
            <div className="mx-auto flex w-full max-w-sm flex-col gap-1" onClick={(e) => e.stopPropagation()}>
              {ALL_NAV_ITEMS.map((item, i) => {
                const isActive = pathname === item.href;
                const Icon = item.icon;
                return (
                  <motion.div
                    key={item.href}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04, duration: 0.25, ease: "easeOut" }}
                  >
                    <Link
                      href={item.href}
                      onClick={() => closeMenu(false)}
                      className={cn(
                        "flex items-center gap-4 rounded-2xl px-5 py-3.5 text-base font-medium transition-all duration-200",
                        isActive
                          ? "bg-primary/15 text-foreground"
                          : "text-muted hover:bg-foreground/5 hover:text-foreground",
                      )}
                    >
                      <Icon className={cn(
                        "h-5 w-5",
                        isActive ? "text-primary" : "text-muted-2",
                      )} />
                      <span>{navLabel(item.label)}</span>
                      {/* R17 (unread badge): the Notifications row carries the
                          live count — replaces the active dot when set (the
                          pill is the stronger, more informative signal). */}
                      {item.href === "/notifications" && unread > 0 ? (
                        <span
                          className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground shadow-[0_2px_6px_-1px_rgba(8,145,178,0.5)]"
                          aria-label={t("nav.notificationsBadge", { count: unread })}
                        >
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : isActive ? (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary/70" />
                      ) : null}
                    </Link>
                  </motion.div>
                );
              })}
            </div>
            <div className="mx-auto mt-6 flex w-full max-w-sm flex-col gap-4 pb-10" onClick={(e) => e.stopPropagation()}>
              {/* N8: bare (unboxed) connect button inside the drawer — the
                  drawer row is chrome enough; a boxed button inside it looked
                  wrong on Android. */}
              <div className="flex items-center justify-between rounded-2xl border border-border px-4 py-3">
                <span className="text-sm font-medium text-muted">{t("nav.network")}</span>
                <ChainSwitcher compact />
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-border px-4 py-1.5">
                <WalletButton boxed={false} />
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-border px-4 py-3">
                <span className="text-sm font-medium text-muted">{t("common.language")}</span>
                <LanguageSelector />
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-border px-4 py-3">
                <span className="text-sm font-medium text-muted">{t("settings.theme")}</span>
                <ThemeToggle />
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
