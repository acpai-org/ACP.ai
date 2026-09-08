"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Command palette (⌘K / Ctrl+K) — the app-wide quick-action surface.
//
// N11 rebuild: the PAGES / NETWORK / LANGUAGE groups are GONE (navigation
// lives in the navbar + mobile tab bar; chain switching in the chain
// switcher; language in the language selector). What remains is what a
// command palette is actually FOR:
//
//   • recent chats (jump back into a conversation)
//   • actions — new chat, connect/disconnect wallet, copy address, theme
//     toggle, refresh app data, export the action log
//   • free text → ask the on-page agent (the spotlight path: pressing ↵
//     with no command match hands the query to the assistant)
//
// Full keyboard support: ↑/↓ move, ↵ select, Esc close (globally while the
// dialog is open — not just from the input). Focus is trapped by keeping
// focus in the input; the list is a proper listbox.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { useAccount, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import {
  Search,
  MessageSquare,
  MessageSquareText,
  MessageSquarePlus,
  SunMoon,
  Download,
  Sparkles,
  Link2,
  LogOut,
  Wallet,
  RefreshCw,
  CornerDownRight,
  Check,
  Receipt,
  Users,
  CalendarClock,
  Bell,
  Network,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/types";
import { useTheme } from "@/lib/use-theme";
import { useChatStore, type ChatSession } from "@/lib/chat/chat-store";
import { CHAIN_REGISTRY } from "@/lib/chains/registry";
import { useAppKitSafe } from "@/lib/wagmi/appkit-init";
import { useNotificationsBadge } from "@/lib/notifications-badge";
import { askAgentFromAnywhere, jumpToMessage, PALETTE_OPEN_EVENT } from "@/lib/palette-events";
import { messageSearchTexts, type MessageSearchSource } from "@/lib/message-search";
import { cn } from "@/lib/utils";

interface PaletteCommand {
  id: string;
  group: "chats" | "actions" | "messages";
  icon: LucideIcon;
  label: string;
  hint?: string;
  keywords?: string;
  checked?: boolean;
  run: () => void;
  /** Message-search rows: excerpt with the matched span pre-split for
   * in-place highlighting (styling detail — the match visibly explains WHY
   * the row appeared, exactly like a grep hit). */
  excerpt?: { before: string; match: string; after: string };
  /** Message-search rows: who said it (role chip beside the icon). */
  role?: "user" | "assistant";
  /** Message-search rows: WHERE the match was found when not plain content
   * (reasoning block or agent trace) — rendered as a source badge so an
   * unexpected hit is self-explaining (R5 scope extension). */
  source?: Exclude<MessageSearchSource, "content">;
  /** R19 (ambient state): an optional count pill rendered at the row's trailing
   * edge — the notifications nav entry carries the live unread count from the
   * shared badge store, so ⌘K answers "anything new?" without a page visit. */
  badge?: number;
}

export function CommandPalette() {
  const router = useRouter();
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Global open/close ─────────────────────────────────────────────────────
  // Reset-then-open lives in event handlers (NOT effects — the compiler's
  // cascading-render rule): ⌘K, PALETTE_OPEN_EVENT, and Escape all funnel
  // through these two callbacks.
  const show = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
    // Focus after the open animation starts.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) hide();
        else show();
      }
      // N11 overlay contract: Escape closes the dialog from ANY focus state
      // (not only when the input holds focus — e.g. after tabbing to a row).
      if (e.key === "Escape" && open) {
        e.preventDefault();
        hide();
      }
    };
    const onOpen = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, [open, show, hide]);

  // ── Action helpers ────────────────────────────────────────────────────────
  const exportActionLog = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/actions?limit=200", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { actions: unknown[] };
      const payload = { acpActionLog: 1, exportedAt: new Date().toISOString(), actions: json.actions };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `acp-action-log-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // best-effort, same as the settings surface
    }
  }, []);

  // ── Wallet context (the palette mounts inside Web3Provider) ──
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { open: openWalletModal } = useAppKitSafe();
  // P18 daily-use: quick network switching straight from ⌘K. switchChainAsync
  // is the AWAITED mutation (fund-safety lesson: never fire-and-forget a
  // switch); the wallet surfaces its own rejection prompt.
  const activeChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  // Recent chats (store subscription — the modal is cheap to re-render).
  const chatSessions = useChatStore((s) => s.sessions);
  const chatOrder = useChatStore((s) => s.order);
  // R19: the live unread count — the same store the drawer pill + tabbar dot
  // read (kept fresh by the R17 poller: mount + route change + 45 s).
  const unreadBadge = useNotificationsBadge((s) => s.unread);
  const recentChats = useMemo(
    () =>
      chatOrder
        .map((id) => chatSessions[id])
        .filter((s) => s && s.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [chatOrder, chatSessions],
  );

  // ── Cross-session message search (post-phase feature) ────────────────────
  // Typing a phrase searches what was SAID, not just chat titles: every
  // message across all sessions is scanned (most-recent-first), each hit
  // carries a pre-split excerpt so the matched span renders highlighted,
  // and selecting it jumps to that message in its session.
  const messageHits = useMemo<PaletteCommand[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits: PaletteCommand[] = [];
    const sessionsNewestFirst = chatOrder
      .map((id) => chatSessions[id])
      .filter((s): s is ChatSession => Boolean(s) && s.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const session of sessionsNewestFirst) {
      if (hits.length >= 6) break;
      // Most recent messages first inside a session too — people search for
      // things they just talked about.
      for (let mi = session.messages.length - 1; mi >= 0; mi--) {
        const msg = session.messages[mi];
        // R5 scope extension: scan content + reasoning + trace segments
        // (messageSearchTexts). First matching segment wins the excerpt; a
        // match outside plain content badges the row with its source.
        let matched: { flat: string; idx: number; source: "reasoning" | "trace" | undefined } | null = null;
        for (const seg of messageSearchTexts(msg)) {
          // Newlines flattened BEFORE matching so the excerpt always renders
          // one line and the match index is valid in the rendered string.
          const flat = seg.text.replace(/\s+/g, " ");
          const idx = flat.toLowerCase().indexOf(q);
          if (idx >= 0) {
            matched = { flat, idx, source: seg.source === "content" ? undefined : seg.source };
            break;
          }
        }
        if (!matched) continue;
        const { flat, idx, source } = matched;
        // Excerpt: ~60 chars of context around the FIRST match, ellipsized
        // at both ends.
        const start = Math.max(0, idx - 60);
        const end = Math.min(flat.length, idx + q.length + 60);
        const excerpt = {
          before: (start > 0 ? "…" : "") + flat.slice(start, idx),
          match: flat.slice(idx, idx + q.length),
          after: flat.slice(idx + q.length, end) + (end < flat.length ? "…" : ""),
        };
        hits.push({
          id: `msg-${session.id}-${msg.id}`,
          group: "messages",
          icon: MessageSquareText,
          label: session.title || t("chat.newChat"),
          role: msg.role === "user" ? "user" : "assistant",
          source,
          excerpt,
          run: () => {
            useChatStore.getState().selectChat(session.id);
            if (window.location.pathname !== "/") router.push("/");
            // R3: carry the query so the target message highlights every
            // occurrence of the term, not just the reveal flash.
            jumpToMessage({ sessionId: session.id, messageId: msg.id, term: query.trim() });
          },
        });
        if (hits.length >= 6) break;
      }
    }
    return hits;
  }, [query, chatOrder, chatSessions, t, router]);

  // ── Command list (rebuilt per render; cheap) ──────────────────────────────
  const commands = useMemo<PaletteCommand[]>(() => {
    const chatCommands: PaletteCommand[] = recentChats.map((s) => ({
      id: `chat-${s.id}`,
      group: "chats" as const,
      icon: MessageSquare,
      label: s.title || t("chat.newChat"),
      keywords: `chat conversation session ${s.title}`,
      checked: s.id === useChatStore.getState().activeId,
      run: () => {
        useChatStore.getState().selectChat(s.id);
        router.push("/");
      },
    }));

    const actionCommands: PaletteCommand[] = [
      {
        id: "action-new-chat",
        group: "actions",
        icon: MessageSquarePlus,
        label: t("palette.newChat"),
        keywords: "new chat conversation session",
        run: () => {
          useChatStore.getState().newChat();
          router.push("/");
        },
      },
      {
        id: "action-refresh-data",
        group: "actions",
        icon: RefreshCw,
        label: t("palette.refreshData"),
        hint: t("palette.refreshDataHint"),
        keywords: "refresh reload sync update data balances payments actions",
        run: () => {
          void queryClient.invalidateQueries();
        },
      },
    ];

    // Wallet actions — connect when disconnected; copy/disconnect when live.
    if (!isConnected) {
      actionCommands.push({
        id: "action-connect-wallet",
        group: "actions",
        icon: Wallet,
        label: t("palette.connectWallet"),
        keywords: "connect wallet metamask walletconnect sign in",
        run: () => void openWalletModal(),
      });
    } else {
      if (address) {
        actionCommands.push({
          id: "action-copy-address",
          group: "actions",
          icon: Link2,
          label: t("palette.copyAddress"),
          hint: `${address.slice(0, 6)}…${address.slice(-4)}`,
          keywords: "copy wallet address clipboard",
          run: () => {
            void navigator.clipboard?.writeText(address).catch(() => undefined);
          },
        });
      }
      actionCommands.push({
        id: "action-disconnect-wallet",
        group: "actions",
        icon: LogOut,
        label: t("palette.disconnectWallet"),
        keywords: "disconnect wallet logout sign out",
        run: () => disconnect(),
      });
    }

    actionCommands.push(
      {
        id: "action-theme",
        group: "actions",
        icon: SunMoon,
        label: t("palette.toggleTheme"),
        hint: theme === "dark" ? "☾" : "☀",
        keywords: "theme dark light appearance mode",
        run: () => toggle(),
      },
      {
        id: "action-export-log",
        group: "actions",
        icon: Download,
        label: t("palette.exportLog"),
        keywords: "export audit log actions json download",
        run: () => void exportActionLog(),
      },
    );

    // R8: page navigation commands — power users reach every surface from ⌘K.
    // Labels reuse the nav.* names via a single parameterized i18n key.
    const NAV_TARGETS: Array<{ href: string; labelKey: TranslationKey; icon: LucideIcon; keywords: string }> = [
      { href: "/wallet", labelKey: "nav.wallet", icon: Wallet, keywords: "wallet balance tokens swap receive" },
      { href: "/payments", labelKey: "nav.payments", icon: Receipt, keywords: "action log audit trail payments history attestcoin" },
      { href: "/contacts", labelKey: "nav.contacts", icon: Users, keywords: "contacts address book recipients mention" },
      { href: "/recurring", labelKey: "nav.recurring", icon: CalendarClock, keywords: "recurring schedules subscriptions cadence fire" },
      { href: "/notifications", labelKey: "nav.notifications", icon: Bell, keywords: "notifications alerts inbox unread" },
      { href: "/settings", labelKey: "nav.settings", icon: Settings, keywords: "settings preferences provider skills attestcoin config" },
    ];
    for (const n of NAV_TARGETS) {
      actionCommands.push({
        id: `action-nav-${n.href.slice(1)}`,
        group: "actions",
        icon: n.icon,
        label: t("palette.goTo", { page: t(n.labelKey) }),
        keywords: `go to navigate open ${n.keywords}`,
        ...(n.href === "/notifications" && unreadBadge > 0 ? { badge: unreadBadge } : {}),
        run: () => router.push(n.href),
      });
    }

    // P18: network switching rows. They stay OUT of the empty-query list (the
    // unfiltered palette is chats + core actions) and appear the moment the
    // query is network-flavored ("switch", "network", "chain", or any chain
    // name/symbol) — 9 chains otherwise drown the daily-use rows.
    const q = query.trim().toLowerCase();
    const networkish =
      q.length >= 2 &&
      (q.includes("switch") || q.includes("network") || q.includes("chain") ||
        CHAIN_REGISTRY.some(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.nativeCurrency.symbol.toLowerCase().includes(q) ||
            c.key.includes(q),
        ));
    if (isConnected && networkish) {
      for (const c of CHAIN_REGISTRY) {
        actionCommands.push({
          id: `action-chain-${c.key}`,
          group: "actions",
          icon: Network,
          label: t("palette.switchTo", { chain: c.name }),
          hint: c.testnet ? t("chain.testnetChip") : t("chain.mainnetChip"),
          checked: c.chainId === activeChainId,
          keywords: `switch network chain ${c.name} ${c.nativeCurrency.symbol} ${c.key} ${c.testnet ? "testnet" : "mainnet"}`,
          run: () => {
            void switchChainAsync({ chainId: c.chainId }).catch(() => {
              /* the wallet's own rejection prompt is the loud surface */
            });
          },
        });
      }
    }

    return [...chatCommands, ...actionCommands];
  }, [router, t, theme, toggle, exportActionLog, recentChats, isConnected, address, openWalletModal, disconnect, queryClient, query, activeChainId, switchChainAsync, unreadBadge]);

  // ── Filtering ─────────────────────────────────────────────────────────────
  const { filtered, askEntry } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { filtered: commands, askEntry: null as null | PaletteCommand };
    const scored = commands.filter((c) => {
      const haystack = `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
    // Ask entry: always available when typing — pressing ↵ with it selected
    // (or with no command matches) hands the query to the assistant.
    const ask: PaletteCommand = {
      id: "ask-agent",
      group: "actions",
      icon: Sparkles,
      label: t("palette.askAgent"),
      hint: query.trim().length > 44 ? `${query.trim().slice(0, 44)}…` : query.trim(),
      keywords: "ask agent chat assistant",
      run: () => {
        askAgentFromAnywhere(query);
        // When launched from another page, navigate to the chat — the pending
        // ask rides across the navigation via sessionStorage.
        if (window.location.pathname !== "/") router.push("/");
      },
    };
    return { filtered: scored, askEntry: ask };
  }, [commands, query, t, router]);

  // Flat render list. Ordering rule (verified feel):
  // - Matches exist → the ask entry goes LAST: typing an exact command name
  //   ("中文", "payments") must select the command on ↵, not punt to the agent.
  // - Message hits rank AFTER command matches (commands are deliberate
  //   targets; message search is discovery) but BEFORE the ask row — and
  //   they surface even when no command matched, which is exactly the
  //   "find what was said" case.
  // - No matches of any kind → the ask entry is the only row.
  const renderList = useMemo(() => {
    const msgRows = messageHits.map((c) => ({ kind: "msg" as const, cmd: c }));
    const askRow = askEntry ? [{ kind: "ask" as const, cmd: askEntry }] : [];
    const cmdRows = filtered.map((c) => ({ kind: "cmd" as const, cmd: c }));
    return [...cmdRows, ...msgRows, ...askRow];
  }, [filtered, messageHits, askEntry]);

  // Derived clamp: when the list shrinks (typing filters), keep the active
  // index in range WITHOUT a state-syncing effect (compiler-friendly).
  const active = Math.min(activeIndex, Math.max(0, renderList.length - 1));

  // Keep the active row in view (reads DOM only — no setState).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runAndClose = useCallback((cmd: PaletteCommand) => {
    hide();
    // Run after the close animation begins so page navigation doesn't fight
    // the exit transition.
    requestAnimationFrame(() => cmd.run());
  }, [hide]);

  // ── Keyboard nav inside the palette ───────────────────────────────────────
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (renderList.length === 0 ? 0 : (Math.min(i, renderList.length - 1) + 1) % renderList.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (renderList.length === 0 ? 0 : (Math.min(i, renderList.length - 1) - 1 + renderList.length) % renderList.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = renderList[active];
        if (entry) runAndClose(entry.cmd);
      }
    },
    [renderList, active, runAndClose, hide],
  );

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const entry = renderList[active];
      if (entry) runAndClose(entry.cmd);
    },
    [renderList, active, runAndClose],
  );

  const groupLabel = (g: PaletteCommand["group"]): string => {
    switch (g) {
      case "chats":
        return t("palette.groupChats");
      case "messages":
        return t("palette.groupMessages");
      default:
        return t("palette.groupActions");
    }
  };

  // Insert group headers while rendering.
  let lastGroup: string | null = null;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[16vh]"
          role="dialog"
          aria-modal="true"
          aria-label={t("palette.shortcutHint")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-hidden />

          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="glass-panel relative flex w-full max-w-lg flex-col overflow-hidden !rounded-3xl !p-0"
          >
            {/* Input row */}
            <form onSubmit={onSubmit} className="flex items-center gap-3 border-b border-border px-4 py-3.5">
              <Search className="h-4.5 w-4.5 shrink-0 text-muted" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder={t("palette.placeholder")}
                aria-label={t("palette.placeholder")}
                aria-controls="palette-list"
                className="w-full bg-transparent text-[15px] text-foreground placeholder:text-muted focus:outline-none"
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="hidden shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0 font-mono text-[10px] font-medium leading-4 text-muted sm:inline">
                esc
              </kbd>
            </form>

            {/* Results */}
            {/* No top padding on the scroll container: the sticky group
                headers must sit flush against the scrollport top edge, else
                rows glide through a visible sliver above the stuck header. */}
            <div ref={listRef} id="palette-list" role="listbox" className="acp-scroll max-h-[46vh] overflow-y-auto px-2 pb-2">
              {renderList.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted">{t("palette.noResults")}</p>
              ) : (
                renderList.map((entry, i) => {
                  const cmd = entry.cmd;
                  // The trailing ask row never carries a group header — it is
                  // its own thing (bordered, primary icon) and sits at the end.
                  const showHeader = entry.kind !== "ask" && cmd.group !== lastGroup;
                  lastGroup = cmd.group;
                  const Icon = cmd.icon;
                  const isActive = i === active;
                  return (
                    // Fragment (not a div) so the sticky group header is a
                    // DIRECT child of the scroll container — sticky is
                    // constrained to its containing block, and a wrapper div
                    // per row would limit the header to one row's height.
                    <Fragment key={cmd.id}>
                      {showHeader ? (
                        // Sticky while scrolling long filtered lists (P2-10
                        // queue #4): opaque head fading to transparent so
                        // rows glide under it; base color = panel base.
                        <p
                          aria-hidden
                          className="sticky top-0 z-10 bg-gradient-to-b from-(--panel-bg-color) via-[var(--panel-bg-color)]/85 to-transparent px-3 pb-2.5 pt-2 text-[10px] font-bold uppercase tracking-widest text-muted-2"
                        >
                          {groupLabel(cmd.group)}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        data-index={i}
                        onClick={() => runAndClose(cmd)}
                        onMouseMove={() => setActiveIndex(i)}
                        aria-label={cmd.excerpt ? t("palette.jumpToMessage", { chat: cmd.label }) : undefined}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                          "cursor-pointer focus-visible:outline-none",
                          isActive ? "bg-primary/15 text-foreground" : "text-muted hover:bg-foreground/5",
                          entry.kind === "ask" && "border border-primary/25",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                            entry.kind === "ask"
                              ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                              : cmd.group === "chats"
                                ? "bg-primary/10 text-primary"
                                : cmd.group === "messages"
                                  ? "bg-primary/[0.07] text-primary/90"
                                  : "bg-surface-2 text-muted",
                          )}
                        >
                          <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("flex min-w-0 items-center gap-2", "")}>
                            {cmd.role ? (
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide",
                                  cmd.role === "user" ? "bg-primary/12 text-primary/90" : "bg-foreground/8 text-muted-2",
                                )}
                                aria-hidden
                              >
                                {cmd.role === "user" ? t("palette.msgRoleUser") : t("palette.msgRoleAgent")}
                              </span>
                            ) : null}
                            {cmd.source ? (
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide ring-1",
                                  cmd.source === "reasoning"
                                    ? "bg-warning/10 text-warning ring-warning/25"
                                    : "bg-success/10 text-success ring-success/25",
                                )}
                                aria-hidden
                              >
                                {cmd.source === "reasoning" ? t("palette.msgSourceReasoning") : t("palette.msgSourceTrace")}
                              </span>
                            ) : null}
                            <span className={cn("min-w-0 truncate font-medium", isActive ? "text-foreground" : "text-foreground/90")}>
                              {cmd.label}
                            </span>
                          </span>
                          {cmd.excerpt ? (
                            <span className="mt-0.5 flex items-baseline gap-1 truncate text-xs text-muted">
                              <span className="truncate font-mono text-[11px] text-muted/90">{cmd.excerpt.before}</span>
                              <mark
                                className="shrink-0 rounded-[3px] bg-primary/20 px-0.5 font-mono text-[11px] font-semibold text-primary dark:text-primary-light"
                                aria-hidden
                              >
                                {cmd.excerpt.match}
                              </mark>
                              <span className="truncate font-mono text-[11px] text-muted/90">{cmd.excerpt.after}</span>
                            </span>
                          ) : cmd.hint ? (
                            <span className="block truncate text-xs text-muted">{cmd.hint}</span>
                          ) : null}
                        </span>
                        {/* R19 (ambient state): the unread-count pill. Visible
                            text (not just aria) so the option's accessible
                            name reads "Go to Notifications 3". Capped at 99+
                            like the drawer pill. */}
                        {cmd.badge ? (
                          <span
                            className={cn(
                              "shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary",
                              isActive && "ring-1 ring-primary/30",
                            )}
                          >
                            {cmd.badge > 99 ? "99+" : cmd.badge}
                          </span>
                        ) : null}
                        {cmd.checked ? (
                          <span className="flex shrink-0 items-center justify-center" aria-hidden>
                            <Check className="h-3.5 w-3.5 text-primary" strokeWidth={3} />
                          </span>
                        ) : entry.kind === "msg" && !isActive ? (
                          <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-2/70" aria-hidden />
                        ) : isActive || (i === renderList.length - 1 && entry.kind === "ask") ? (
                          /* R19 styling detail: the active row carries the ↵
                             affordance (standard palette grammar — the key
                             hint travels with the highlight, not only the
                             terminal ask row). */
                          <span className="shrink-0 font-mono text-[10px] font-semibold text-muted-2">↵</span>
                        ) : null}
                      </button>
                    </Fragment>
                  );
                })
              )}
            </div>

            {/* Footer legend */}
            <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-muted">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-surface-2 px-1 py-px font-mono text-[10px]">↑↓</kbd>
                {t("palette.kbdNav")}
              </span>
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-border bg-surface-2 px-1 py-px font-mono text-[10px]">↵</kbd>
                {t("palette.kbdSelect")}
              </span>
              <span className="ml-auto hidden items-center gap-1.5 sm:flex">
                <Sparkles className="h-3 w-3 text-primary" aria-hidden />
                {query.trim() ? t("palette.askFooter") : t("palette.shortcutHint")}
              </span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
