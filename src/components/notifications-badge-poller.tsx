"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useNotificationsBadge } from "@/lib/notifications-badge";

// ─────────────────────────────────────────────────────────────────────────────
// NotificationsBadgePoller (R17) — mounted once in Web3Frame next to the
// automation/recurring pollers. Keeps the global unread badge fresh:
// refresh on mount + every route change (cheap: one count query) and a
// 45 s heartbeat for a page left sitting (the Attestcoin poller can flip
// rows to "attested" and fire notifications while nobody is watching).
//
// The notifications page pushes immediate updates through the same store on
// its own mutations — those never wait for a tick.
// ─────────────────────────────────────────────────────────────────────────────

export function NotificationsBadgePoller() {
  const refresh = useNotificationsBadge((s) => s.refresh);
  const pathname = usePathname();

  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    const iv = setInterval(() => void refresh(), 45_000);
    return () => clearInterval(iv);
  }, [refresh]);

  return null;
}
