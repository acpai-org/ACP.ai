/**
 * Command-palette ↔ chat bridge (brief §10-style cross-surface wiring).
 *
 * The palette is mounted globally in Web3Frame, but only the ChatView knows
 * how to send a message to the agent. The two surfaces talk through:
 *
 *  1. PALETTE_ASK_EVENT  — live dispatch while the chat page is mounted.
 *  2. PENDING_ASK_KEY    — sessionStorage handoff when the palette opened the
 *                          chat from ANOTHER page (ChatView consumes it once
 *                          on mount; consumed means removed).
 *  3. PALETTE_OPEN_EVENT — lets any surface (e.g. the composer's ⌘K chip)
 *                          pop the palette without owning the component.
 */

export const PALETTE_ASK_EVENT = "acp:palette-ask";
export const PALETTE_OPEN_EVENT = "acp:palette-open";
export const PENDING_ASK_KEY = "acp:pending-ask";

/** Shortcuts overlay open event — any surface (e.g. the composer's keyboard
 *  button on touch devices, where the `?` key is out of reach) can pop the
 *  `?` help dialog without owning the component. Same pattern as the palette. */
export const SHORTCUTS_OPEN_EVENT = "acp:shortcuts-open";

/** Open the keyboard-shortcuts overlay from anywhere. */
export function openShortcutsHelp(): void {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_OPEN_EVENT));
}

/** Ask the assistant from anywhere. Navigates to the chat if needed. */
export function askAgentFromAnywhere(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    sessionStorage.setItem(PENDING_ASK_KEY, trimmed);
  } catch {
    /* private mode — fall through to the live event only */
  }
  window.dispatchEvent(new CustomEvent(PALETTE_ASK_EVENT, { detail: trimmed }));
}

/** Open the command palette from anywhere. */
export function openPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
}

// ── Message search jump bridge (post-phase round 1) ─────────────────────────
// Cross-session message search needs the same two-path handoff as the ask
// bridge: a live event when the chat page is already mounted, and a
// sessionStorage fallback that survives navigation when the palette jumps
// from another page. The target carries BOTH ids — the session to activate
// and the message to reveal — so one key serves the whole round trip.
export const PALETTE_JUMP_EVENT = "acp:palette-jump";
export const PENDING_JUMP_KEY = "acp:pending-jump";

export interface ChatJumpTarget {
  sessionId: string;
  messageId: string;
  /** Optional search term (palette / sidebar message search): when the jump
   *  lands, every occurrence of this term inside the target message is
   *  highlighted in place — not just the reveal flash. */
  term?: string;
}

/** Build a shareable permalink for a specific message. Format:
 *  `<origin>/?chat=<sessionId>#msg=<messageId>` — consumed by ChatView on
 *  load (session select + message reveal) and safe to paste in a new tab. */
export function buildMessagePermalink(sessionId: string, messageId: string): string {
  const base = typeof window === "undefined" ? "/" : `${window.location.origin}/`;
  return `${base}?chat=${encodeURIComponent(sessionId)}#msg=${encodeURIComponent(messageId)}`;
}

/** Jump to a specific message in a chat session (navigates if needed). */
export function jumpToMessage(target: ChatJumpTarget): void {
  writePendingJump(target);
  window.dispatchEvent(new CustomEvent(PALETTE_JUMP_EVENT, { detail: target }));
}

/** Write the pending jump WITHOUT dispatching the live event. Used when the
 *  writer knows the ChatView is about to (re)mount — e.g. the permalink
 *  consumer on a fresh load: the [activeId] effect peeks the key on every
 *  mount and reveals once the messages are committed. Dispatching the live
 *  event there instead would race React StrictMode's dev double-mount: the
 *  first (doomed) instance would consume the key and die with its detached
 *  ref, and the remounted instance would find nothing left to jump to. */
export function writePendingJump(target: ChatJumpTarget): void {
  try {
    sessionStorage.setItem(PENDING_JUMP_KEY, JSON.stringify(target));
  } catch {
    /* private mode — fall through to the live event only */
  }
}

function parsePendingJump(): ChatJumpTarget | null {
  try {
    const raw = sessionStorage.getItem(PENDING_JUMP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatJumpTarget>;
    if (typeof parsed.sessionId === "string" && typeof parsed.messageId === "string") {
      // Preserve the search term: cross-page jumps land AFTER the live event
      // was missed (ChatView unmounted), so this pending entry is the ONLY
      // carrier of `term` — dropping it would leave the reveal flash without
      // the in-message term marks (R3/R5 feature regression).
      return {
        sessionId: parsed.sessionId,
        messageId: parsed.messageId,
        term: typeof parsed.term === "string" ? parsed.term : undefined,
      };
    }
  } catch {
    /* private mode or corrupt payload — nothing to jump to */
  }
  return null;
}

/** Read the pending jump WITHOUT consuming it. Lets a mount attempt a reveal
 *  and consume only once it actually lands — a doomed StrictMode first mount
 *  then leaves the entry intact for the remounted instance. */
export function peekPendingJump(): ChatJumpTarget | null {
  return parsePendingJump();
}

/** Remove the pending jump (giving up — e.g. its target never appeared). */
export function dropPendingJump(): void {
  try {
    sessionStorage.removeItem(PENDING_JUMP_KEY);
  } catch {
    /* private mode */
  }
}

/** Consume the pending jump target (read-once semantics). */
export function takePendingJump(): ChatJumpTarget | null {
  const target = parsePendingJump();
  if (target) dropPendingJump();
  return target;
}
