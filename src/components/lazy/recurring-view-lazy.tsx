"use client";

import dynamic from "next/dynamic";
import { RouteSkeleton } from "@/components/ui/route-skeleton";

// RecurringView is client-only: schedule registration/cancellation uses
// wagmi hooks (see use-recurring-schedule), which need the browser-only
// Web3Provider context — see app-shell.tsx for the memory rationale.
const RecurringView = dynamic(
  () => import("@/app/recurring/recurring-view").then((m) => m.RecurringView),
  { ssr: false, loading: () => <RouteSkeleton /> },
);

export function RecurringViewLazy() {
  return <RecurringView />;
}
