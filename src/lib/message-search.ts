import type { ChatMessageData } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Message search scope (R5): flatten one chat message into the text segments
// a user meaningfully searches. Content is the classic scope; reasoning
// blocks (N26) and agent trace steps (tool name, titles, summaries, hashes,
// addresses, arg values) extend it — "what did the agent conclude about
// USDC" and "which chat touched 0x9f8a…" both resolve now.
//
// Shared by the command palette's cross-session search AND the chats
// sidebar's search-as-you-type — one scan contract, two surfaces.
// ─────────────────────────────────────────────────────────────────────────────

export type MessageSearchSource = "content" | "reasoning" | "trace";

export interface MessageSearchText {
  source: MessageSearchSource;
  text: string;
}

/** Which parts of a trace step are searchable — whitelist, deliberately. */
function traceStepText(step: NonNullable<ChatMessageData["trace"]>[number]): string | null {
  const parts: string[] = [step.tool];
  if (step.title) parts.push(step.title);
  const d = step.detail;
  if (d) {
    if (d.text) parts.push(d.text);
    if (d.txHash) parts.push(d.txHash);
    if (d.address) parts.push(d.address);
    if (d.merkleRoot) parts.push(d.merkleRoot);
    if (d.error) parts.push(d.error);
  }
  const r = step.result;
  if (r) {
    if (r.summary) parts.push(r.summary);
    if (r.txHash && r.txHash !== d?.txHash) parts.push(r.txHash);
  }
  // Arg VALUES only (not keys): recipients, tokens, memos, hashes — the
  // things a user would actually type into a search box.
  if (step.args) {
    for (const v of Object.values(step.args)) {
      if (typeof v === "string" && v.length >= 2) parts.push(v);
      else if (typeof v === "number") parts.push(String(v));
    }
  }
  const text = parts.filter(Boolean).join(" · ");
  return text.trim() ? text : null;
}

/**
 * Flatten a message into searchable segments in priority order:
 * content → reasoning → per-step trace text. Segments are non-empty and
 * pre-trimmed. Trace-only beats (beat === "trace", empty content) become
 * searchable for the first time.
 */
export function messageSearchTexts(msg: ChatMessageData): MessageSearchText[] {
  const out: MessageSearchText[] = [];
  const content = msg.content ?? "";
  if (content.trim()) out.push({ source: "content", text: content });
  const reasoning = msg.reasoning ?? "";
  if (reasoning.trim()) out.push({ source: "reasoning", text: reasoning });
  if (msg.trace) {
    for (const step of msg.trace) {
      const text = traceStepText(step);
      if (text) out.push({ source: "trace", text });
    }
  }
  return out;
}
