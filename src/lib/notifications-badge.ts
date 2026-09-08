import { create } from "zustand";

// ─────────────────────────────────────────────────────────────────────────────
// Global unread-notifications badge store (R17).
//
// Surfaces "you have unseen alerts" OUTSIDE the notifications page:
//   - a count pill on the More-drawer's Notifications row,
//   - a dot on the mobile tabbar's More button (Notifications lives inside
//     the drawer, so the dot points one tap away).
//
// Two writers keep it fresh:
//   1. NotificationsBadgePoller (web3-frame) — on mount, on every route
//      change, and every 45 s via GET /api/notifications/unread-count.
//   2. The notifications page — after its own loads/mutations it pushes the
//      exact local count (no poll wait, no double fetch).
//
// Offline-tolerant: a failed refresh keeps the last known count (the badge is
// an ambient hint, not a ledger).
// ─────────────────────────────────────────────────────────────────────────────

interface NotificationsBadgeState {
  unread: number;
  setUnread: (count: number) => void;
  refresh: () => Promise<void>;
}

export const useNotificationsBadge = create<NotificationsBadgeState>((set) => ({
  unread: 0,
  setUnread: (count) => set({ unread: Math.max(0, Math.trunc(count)) }),
  refresh: async () => {
    try {
      const res = await fetch("/api/notifications/unread-count", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { count?: unknown };
      if (typeof data.count === "number") set({ unread: Math.max(0, Math.trunc(data.count)) });
    } catch {
      // keep the last known count — an ambient badge must never throw
    }
  },
}));
