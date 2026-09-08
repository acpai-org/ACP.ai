"use client";

import dynamic from "next/dynamic";
import { RouteSkeleton } from "@/components/ui/route-skeleton";

// ChatView is client-only: it consumes wagmi hooks (account/balance/chain)
// and the settle-payment flow, all of which need the browser-only
// Web3Provider context. Loading it dynamically keeps the wagmi module
// graph out of the server bundle entirely (see app-shell.tsx for the
// memory rationale).
const ChatView = dynamic(
  () => import("@/components/chat-view").then((m) => m.ChatView),
  { ssr: false, loading: () => <RouteSkeleton /> },
);

export function ChatViewLazy() {
  return <ChatView />;
}
