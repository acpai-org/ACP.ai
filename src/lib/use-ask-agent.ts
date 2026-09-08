"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { askAgentFromAnywhere } from "@/lib/palette-events";

// ─────────────────────────────────────────────────────────────────────────────
// useAskAgent: the agent-handoff primitive for non-chat surfaces (Wallet tab
// quick actions, swap modal, activity prompts). Wraps the palette-ask bridge
// with SPA navigation — when called from any page other than the chat, it
// routes to "/" so ChatView's mount-time pending-ask consumer picks the
// intent up and sends it to the agent.
// ─────────────────────────────────────────────────────────────────────────────

export function useAskAgent() {
  const router = useRouter();
  return useCallback(
    (text: string) => {
      askAgentFromAnywhere(text);
      if (window.location.pathname !== "/") router.push("/");
    },
    [router],
  );
}
