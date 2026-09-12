"use client";

import { useState, useEffect, useCallback, useMemo, startTransition, memo } from "react";
import Link from "next/link";
import { Bell, BellOff, BellRing, CheckCheck, Circle, AlertCircle, Shield, ShieldCheck, Info, Inbox, Check, X, Repeat, Receipt, ListChecks } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { StatCard, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePayments } from "@/lib/api";
import { useAskAgent } from "@/lib/use-ask-agent";
import { networkName } from "@/lib/wagmi/chains";
import { shortenAddress } from "@/lib/format";
import { useFormatters } from "@/lib/use-formatters";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { useNotificationsBadge } from "@/lib/notifications-badge";
import { cn } from "@/lib/utils";

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: "payment" | "security" | "system";
  read: boolean;
  relatedPaymentId?: string | null;
  createdAt: number;
}

const typeConfig: Record<string, { icon: typeof Bell; className: string; labelKey: TranslationKey }> = {
  payment: { icon: Bell, className: "bg-primary/10 text-primary", labelKey: "notifications.typePayment" },
  security: { icon: Shield, className: "bg-warning/10 text-warning", labelKey: "notifications.typeSecurity" },
  system: { icon: Info, className: "bg-surface-3 text-muted", labelKey: "notifications.typeSystem" },
};

/**
 * Notification rows may carry server-generated display strings OR a semantic
 * translation key in `title` ("notifications.event.<event>") with JSON params
 * in `message` (written by lib/notifications.ts). The key form renders in the
 * active locale — the seam Phase 2 (Attestcoin Protocol events) will write
 * through. Legacy/raw strings fall through unchanged.
 */
const EVENT_KEY = /^notifications\.event\.(initiated|settling|settled|failed|attested)$/;

function isEventKey(title: string): title is `notifications.event.${"initiated" | "settling" | "settled" | "failed" | "attested"}` {
  return EVENT_KEY.test(title);
}

/** In-flight family (mirrors the payments page's isPendingStatus). */
const IN_FLIGHT = new Set(["pending", "signing", "settling", "sent", "approving", "deploying"]);

/**
 * R14 (event-tone icons): payment-event notifications get a semantic icon +
 * tint instead of the generic bell — one glance reads the outcome. Attested
 * keeps the R11 ShieldCheck; settled flips to a success Check; failed to a
 * danger X; in-flight events (initiated/settling) keep the bell in primary.
 */
const EVENT_TONE: Record<string, { icon: typeof Bell; className: string }> = {
  settled: { icon: Check, className: "bg-success/10 text-success" },
  failed: { icon: X, className: "bg-danger/10 text-danger" },
  attested: { icon: ShieldCheck, className: "bg-success/10 text-success" },
  initiated: { icon: Bell, className: "bg-primary/10 text-primary" },
  settling: { icon: Bell, className: "bg-primary/10 text-primary" },
};

const NotificationsSkeleton = memo(function NotificationsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-2xl border border-border bg-surface/50 p-4"
        >
          <div className="shimmer h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className={cn("shimmer h-3.5 rounded-md", i % 3 === 0 ? "w-1/2" : "w-1/3")} />
            <div className="shimmer h-3 w-2/3 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
});

export default function NotificationsPage() {
  const { t } = useI18n();
  const { timeAgo, formatFullDate, formatDay } = useFormatters();
  const askAgent = useAskAgent();
  // R17 (unread badge): this page is the SOURCE OF TRUTH while mounted —
  // one effect mirrors the derived unread count into the global badge store
  // (drawer pill + tabbar dot) on every load/poll/mark-read, with no poll wait.
  const setUnreadBadge = useNotificationsBadge((s) => s.setUnread);
  // R14 (repeat intent): the notifications page joins each payment-event row
  // to its payment via relatedPaymentId. The shared TanStack ["payments"]
  // cache (same key the payments/contacts pages use) makes this a local read
  // — already-cached when arriving from those pages, one fetch otherwise.
  const { data: paymentsData } = usePayments();
  const paymentById = useMemo(() => {
    const map = new Map<string, { id: string; recipientAddress: string; recipientLabel: string | null; amountHuman: string; token: string; status: string; chainId: number }>();
    for (const p of paymentsData?.payments ?? []) {
      map.set(p.id, {
        id: p.id,
        recipientAddress: p.recipientAddress,
        recipientLabel: p.recipientLabel,
        amountHuman: p.amountHuman,
        token: p.token,
        status: p.status,
        chainId: p.chainId,
      });
    }
    return map;
  }, [paymentsData]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  // R10 day-group "now" — kept in state (purity rule: Date.now() can't be
  // called during render) and refreshed once a minute from an interval
  // callback, so a page left open re-buckets Today → Yesterday at midnight.
  const [now, setNow] = useState(() => Date.now());
  // R4 type filter — chip row between the stats and the list. "all" is the
  // default; counts per type drive the chips (a type with zero rows hides
  // its chip so the row never offers a dead-end filter).
  const [filter, setFilter] = useState<"all" | "payment" | "security" | "system">("all");

  const retry = useCallback(() => {
    startTransition(() => {
      setLoading(true);
      setFetchError(false);
    });
    setNotifications([]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch("/api/notifications", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) startTransition(() => setFetchError(true));
          return;
        }
        const data = await res.json() as { notifications: NotificationItem[] };
        if (!cancelled) startTransition(() => setNotifications(data.notifications));
      } catch {
        if (!cancelled) startTransition(() => setFetchError(true));
      } finally {
        if (!cancelled) startTransition(() => setLoading(false));
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    const minute = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      clearInterval(minute);
    };
  }, []);

  const markAllRead = useCallback(async () => {
    await fetch("/api/notifications/mark-all-read", { method: "POST" });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const markRead = useCallback(async (id: string) => {
    await fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  // ── R18 (bulk select): selection mode — the icon avatar becomes a checkbox
  // (the Gmail pattern: no layout shift, the position reads as "selectable"),
  // row clicks toggle, and the header action row swaps to Select all /
  // Mark N read / Cancel. The bulk POST reuses mark-all-read with an {ids}
  // body; the R17 page-mirror effect keeps the global badge honest with no
  // extra work. Selection survives filter switches (ids are page-global).
  //
  // R19 (mark-unread): the mode now runs BOTH directions — the primary
  // "Mark N read" (enabled when the selection holds unread rows) and a
  // compact BellRing "Mark N unread" (enabled when it holds read rows),
  // so read rows can be re-surfaced like every mail client offers.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enterSelect = useCallback(() => {
    setSelectMode(true);
    setSelectedIds(new Set());
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const markSelectedRead = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await fetch("/api/notifications/mark-all-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    // Optimistic local flip — the R17 mirror effect pushes the new count to
    // the badge store, then the mode exits (the task is done).
    setNotifications((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)));
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [selectedIds]);

  // R19 (mark-unread): the reverse bulk op — flips the SELECTED READ rows
  // back to unread (endpoint guards on read=true; idempotent). Same shape
  // as markSelectedRead: optimistic local flip → mirror effect → exit mode.
  const markSelectedUnread = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await fetch("/api/notifications/mark-unread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setNotifications((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, read: false } : n)));
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [selectedIds]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // R19: which bulk actions the CURRENT selection can run — a mixed selection
  // enables both (each op only touches the rows it applies to); an empty or
  // one-sided selection disables the inapplicable button instead of hiding
  // it (stable layout, honest affordance).
  const selectedHasRead = notifications.some((n) => selectedIds.has(n.id) && n.read);
  const selectedHasUnread = notifications.some((n) => selectedIds.has(n.id) && !n.read);

  // R17: mirror the local truth into the global badge store (see comment at
  // the selector). Runs on mount-load, every 15 s poll, and each mutation.
  useEffect(() => {
    setUnreadBadge(unreadCount);
  }, [unreadCount, setUnreadBadge]);
  const counts = useMemo(
    () => ({
      payment: notifications.filter((n) => n.type === "payment").length,
      security: notifications.filter((n) => n.type === "security").length,
      system: notifications.filter((n) => n.type === "system").length,
    }),
    [notifications],
  );
  const visible = useMemo(
    () => (filter === "all" ? notifications : notifications.filter((n) => n.type === filter)),
    [notifications, filter],
  );

  // R18: select-all operates on the CURRENT filter view (what you see is
  // what gets selected); declared after `visible` to keep the dep honest.
  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(visible.map((n) => n.id)));
  }, [visible]);

  // R10 (day grouping): rows are bucketed by LOCAL calendar day and headed
  // "Today" / "Yesterday" / a locale day label — a flat wall of rows gave
  // no sense of when things happened. Recomputed on every poll (visible
  // changes identity) and every minute (now), so a page left open
  // overnight re-buckets itself.
  const dayGroups = useMemo(() => {
    if (visible.length === 0) return [] as Array<{ key: string; label: string; items: NotificationItem[] }>;
    const dayStart = (ts: number) => {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const todayStart = dayStart(now);
    const yesterdayStart = todayStart - 86_400_000;
    const byDay = new Map<number, NotificationItem[]>();
    for (const n of visible) {
      const k = dayStart(n.createdAt);
      const bucket = byDay.get(k);
      if (bucket) bucket.push(n);
      else byDay.set(k, [n]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => b - a)
      .map(([dayKey, items]) => ({
        key: String(dayKey),
        label:
          dayKey === todayStart
            ? t("notifications.today")
            : dayKey === yesterdayStart
              ? t("notifications.yesterday")
              : formatDay(items[0].createdAt),
        items: items.slice().sort((a, b) => b.createdAt - a.createdAt),
      }));
  }, [visible, t, formatDay, now]);

  function renderTitle(n: NotificationItem): string {
    return isEventKey(n.title) ? t(n.title) : n.title;
  }

  function renderMessage(n: NotificationItem): string {
    if (!isEventKey(n.title)) return n.message;
    try {
      const params = JSON.parse(n.message) as Record<string, string | number>;
      return t(`notifications.eventMsg.${n.title.split(".").pop()}` as TranslationKey, params);
    } catch {
      return n.message;
    }
  }

  return (
    <PageContainer
      title={t("notifications.title")}
      description={t("notifications.desc")}
      icon={<Bell className="h-5 w-5" />}
      action={
        // R18 (bulk select): the action row swaps wholesale in select mode —
        // Select all (current filter view) / Mark N read / Mark N unread /
        // Cancel. R19: the entry condition widened from "unread > 0" to any
        // notifications existing — mark-UNREAD makes selection useful on an
        // all-read list too (re-surface rows you want to find again).
        selectMode ? (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={selectAllVisible} disabled={visible.length === 0}>
              {t("notifications.selectAll")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={markSelectedRead}
              disabled={!selectedHasUnread}
              aria-label={t("notifications.markSelected", { count: selectedIds.size })}
            >
              <CheckCheck className="h-4 w-4" />
              <span className="hidden min-[420px]:inline">{t("notifications.markSelected", { count: selectedIds.size })}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={markSelectedUnread}
              disabled={!selectedHasRead}
              aria-label={t("notifications.markUnread", { count: selectedIds.size })}
              title={t("notifications.markUnread", { count: selectedIds.size })}
              className="px-2"
            >
              <BellRing className="h-4 w-4" />
              <span className="hidden min-[560px]:inline">{t("notifications.markUnread", { count: selectedIds.size })}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={exitSelect}
              aria-label={t("notifications.selectExit")}
              title={t("notifications.selectExit")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : notifications.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={enterSelect}
              aria-label={t("notifications.select")}
              title={t("notifications.select")}
            >
              <ListChecks className="h-4 w-4" />
              <span className="hidden min-[420px]:inline">{t("notifications.select")}</span>
            </Button>
            {unreadCount > 0 ? (
              <Button variant="secondary" size="sm" onClick={markAllRead}>
                <CheckCheck className="h-4 w-4" />
                {t("notifications.markAllRead")}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* R19 styling detail: the Unread tile carries the state — the value
            and icon flip to primary when there IS unseen work, and stay muted
            when caught up (a quick glance answers "anything new?" from the
            color alone). */}
        <StatCard
          label={t("notifications.unread")}
          value={
            <span className={unreadCount > 0 ? "text-primary" : undefined}>
              {unreadCount}
            </span>
          }
          icon={<Bell className="h-4 w-4" />}
          iconClassName={unreadCount > 0 ? "text-primary" : undefined}
        />
        <StatCard label={t("notifications.total")} value={`${notifications.length}`} icon={<Inbox className="h-4 w-4" />} />
        <StatCard
          label={t("notifications.paymentAlerts")}
          value={`${notifications.filter((n) => n.type === "payment").length}`}
          icon={<Receipt className="h-4 w-4" />}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {/* R4 filter chips — only offered when the list is non-empty and there
          is more than one distinct type to switch between. */}
      {!loading && !fetchError && notifications.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("notifications.filterLabel")}>
          {(["all", "payment", "security", "system"] as const).map((f) => {
            const count = f === "all" ? notifications.length : counts[f];
            // Hide empty type chips — never offer a filter that leads nowhere.
            if (f !== "all" && count === 0) return null;
            const active = filter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={cn(
                  "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors cursor-pointer",
                  active
                    ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                    // S12-e (round-7 styling, VLM-guided): unified with the
                    // payments/actions chip language — the old ring-border/60
                    // (#1c1c1c @60%) edge was invisible in dark mode, and
                    // glass-item now carries a perceptible fill + edge.
                    : "glass-item text-muted hover:text-foreground",
                )}
              >
                {f === "all" ? t("notifications.filterAll") : t(typeConfig[f].labelKey)}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[10px] tabular-nums",
                    active ? "bg-primary/20 text-primary" : "bg-surface-3 text-muted-2",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {loading ? (
        <NotificationsSkeleton />
      ) : fetchError ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {t("notifications.error")}
          <button type="button" onClick={retry} className="ml-auto text-xs underline">
            {t("notifications.retry")}
          </button>
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={<BellOff className="h-6 w-6" />}
          title={t("notifications.empty")}
          description={t("notifications.emptyDesc")}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" />}
          title={t("notifications.emptyFilterTitle")}
          description={t("notifications.emptyFilterDesc")}
        />
      ) : (
        <div className="space-y-4">
          {dayGroups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              {/* day header — quiet uppercase label, hairline, row count */}
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
                  {group.label}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border/70" />
                <span className="shrink-0 text-[10px] tabular-nums text-muted-3">
                  {group.items.length}
                </span>
              </div>
              <div className="mt-2 space-y-2">
                {group.items.map((notif) => {
            const config = typeConfig[notif.type] ?? typeConfig.system;
            // R14 (event tone): semantic icon per payment event — settled
            // Check/success, failed X/danger, attested ShieldCheck/success,
            // in-flight events keep the bell in primary. Non-key (legacy)
            // rows fall through to the type config.
            const event = isEventKey(notif.title) ? notif.title.split(".").pop()! : null;
            const tone = event ? EVENT_TONE[event] : null;
            const Icon = tone?.icon ?? config.icon;
            const iconTone = tone?.className ?? config.className;

            // R14 (repeat intent): the joined payment row drives a Pay-again
            // affordance — offered only when the payment exists and is NOT
            // in flight (settled repeats a known-good intent; failed retries
            // one). A deleted or unknown payment shows no button (the
            // notification itself remains an honest historical record).
            const joined = notif.relatedPaymentId ? paymentById.get(notif.relatedPaymentId) : undefined;
            const repeatable = !!joined && !IN_FLIGHT.has(joined.status);

            return (
              <div
                key={notif.id}
                role={selectMode ? "checkbox" : notif.read ? undefined : "button"}
                aria-checked={selectMode ? selectedIds.has(notif.id) : undefined}
                tabIndex={selectMode ? 0 : notif.read ? -1 : 0}
                onClick={() => {
                  if (selectMode) toggleSelected(notif.id);
                  else if (!notif.read) markRead(notif.id);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  if (selectMode) {
                    e.preventDefault();
                    toggleSelected(notif.id);
                  } else if (!notif.read) {
                    e.preventDefault();
                    markRead(notif.id);
                  }
                }}
                title={selectMode ? t("notifications.selectRow") : notif.read ? undefined : t("notifications.markRead")}
                className={cn(
                  "group relative flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-all duration-200",
                  selectMode
                    ? selectedIds.has(notif.id)
                      ? "border-primary/45 bg-primary/10 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                      : "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.35)] border-border bg-surface/50 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                    : notif.read
                      ? "bg-surface/50"
                      : "cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.35)]",
                  !selectMode &&
                    (notif.read
                      ? "border-border hover:border-border/80"
                      : "border-primary/25 bg-primary/5 hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"),
                )}
              >
                {/* R19 styling detail: unread rows carry a 3px primary accent
                    bar on the leading edge (inset 16px — the row's own corner
                    radius — so it never pokes past the arc). With the avatar
                    tone and the dot it gives unread rows three reinforcing
                    signals without touching layout. Hidden in select mode,
                    where the checkbox + selection fill take over. */}
                {!selectMode && !notif.read ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full bg-gradient-to-b from-primary/90 via-primary/40 to-primary/5"
                  />
                ) : null}
                {/* R18 (bulk select): the avatar becomes the checkbox in select
                    mode — no layout shift, and the position already reads as
                    "this row". Selected: primary fill + Check; unselected: an
                    empty bordered well. The event-tone icon returns on exit. */}
                {selectMode ? (
                  <div
                    aria-hidden
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-200 group-hover:scale-105",
                      selectedIds.has(notif.id)
                        ? "bg-primary text-primary-foreground shadow-[0_2px_8px_-1px_rgba(8,145,178,0.5)]"
                        : "ring-1 ring-border bg-surface-2/60",
                    )}
                  >
                    {selectedIds.has(notif.id) ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-105",
                      iconTone,
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p
                      className={cn(
                        "truncate text-sm",
                        notif.read ? "text-muted" : "font-medium text-foreground",
                      )}
                    >
                      {renderTitle(notif)}
                    </p>
                    <span
                      className={cn(
                        // Type badge is desktop-density chrome — on phones it
                        // squeezed the title into mid-word truncation ("Payment
                        // setti…"); the icon + message carry the type there.
                        "hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium sm:inline-flex",
                        notif.type === "payment"
                          ? "bg-primary/10 text-primary"
                          : notif.type === "security"
                            ? "bg-warning/10 text-warning"
                            : "bg-surface-3 text-muted",
                      )}
                    >
                      {t(config.labelKey)}
                    </span>
                    {!notif.read ? (
                      <Circle aria-hidden className="h-2 w-2 shrink-0 fill-primary text-primary animate-pulse" />
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{renderMessage(notif)}</p>
                  <p
                    className="mt-1 text-[11px] text-muted-2"
                    title={formatFullDate(notif.createdAt)}
                  >
                    {timeAgo(notif.createdAt)}
                  </p>
                </div>
                {joined ? (
                  <div className="flex shrink-0 flex-col gap-1">
                    {/* R15 (deep-link): drill into the payment's row on the
                        payments page — the row arrives expanded + highlighted.
                        Offered whenever the payment still exists (any status);
                        the "in flight" case is exactly when you want to go
                        watch it. */}
                    <Link
                      href={`/payments?highlight=${encodeURIComponent(joined.id)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary transition-all duration-200 hover:border-primary/45 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                      aria-label={t("notifications.viewPayment")}
                      title={t("notifications.viewPayment")}
                    >
                      <Receipt className="h-3.5 w-3.5" />
                    </Link>
                    {repeatable ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          askAgent(
                            t("payments.payAgainPrompt", {
                              amount: joined.amountHuman,
                              token: joined.token,
                              name: joined.recipientLabel ?? shortenAddress(joined.recipientAddress),
                              address: joined.recipientAddress,
                              chain: networkName(joined.chainId),
                            }),
                          );
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-3 transition-colors hover:bg-primary/10 hover:text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        aria-label={t("payments.payAgain")}
                        title={t("payments.payAgain")}
                      >
                        <Repeat className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
                );
              })}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
