import { ChatViewLazy } from "@/components/lazy/chat-view-lazy";

// The whole app frame is client-rendered (see app-shell.tsx), so route-level
// caching never applies — no `instant` export needed.

export default function Home() {
  return <ChatViewLazy />;
}
